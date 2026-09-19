// Inbound mail (v2.2.0): reads the replies to Deploy's own emails over IMAP.
//
// What it does, and all it does: log in to the routine sending mailbox, read
// NEW messages in INBOX and the spam folder, hand each one to a handler
// after cheap header gates, and remember where it got to. It never moves,
// deletes, or flags mail.
//
// Track by UID, never by read state. When Deploy sends from the operator's
// own account the reply lands in the operator's own inbox and they will read
// it on their phone before Deploy polls — an UNSEEN search would silently
// miss real check-ins. The cursor (last UID + UIDVALIDITY per folder) lives
// in the settings table so a reply that arrives during a restart is
// processed exactly once afterwards.
//
// Availability is tracked as `downSince`: set on the first failure, cleared
// only after a reconnect has processed the backlog. The fail-safe in
// routes/deadman.js reads it to hold the pre-fire warning and the fire while
// Deploy knows it cannot read its own inbox. Alerting on it is by email
// first (the caller's job); ntfy is never load-bearing.
//
// Config (env, read at connect time so a config save works without a
// restart): IMAP_HOST, IMAP_PORT (993), IMAP_SECURE (true), IMAP_USER,
// IMAP_PASS. With Gmail credentials (EMAIL_USER/EMAIL_PASS) and no
// IMAP_HOST, imap.gmail.com:993 is derived with the same app password.
// REPLY_BY_EMAIL=false disables the whole thing (dashboard-only mode).

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { notify, notifyThrottled, clearThrottle } = require("./notify");

const POLL_MS = parseInt(process.env.IMAP_POLL_MS, 10) || 60 * 1000;
const RECONNECT_MIN_MS = 15 * 1000;
const RECONNECT_MAX_MS = 10 * 60 * 1000;
const VERIFY_THROTTLE_MS = 60 * 1000;
// A reply is a few KB. Anything bigger is not a reply and is not downloaded.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
// Headers fetched for the cheap gates before a body is downloaded.
const GATE_HEADERS = [
  "from",
  "subject",
  "message-id",
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "x-auto-response-suppress",
  "precedence",
  "list-id",
  "return-path",
  "content-type",
  "x-deploy-deadman",
];

function isEnabled() {
  return String(process.env.REPLY_BY_EMAIL || "").trim().toLowerCase() !== "false";
}

function buildConfig() {
  if (!isEnabled()) return null;
  let host = (process.env.IMAP_HOST || "").trim();
  let user = (process.env.IMAP_USER || "").trim();
  let pass = process.env.IMAP_PASS || "";
  let port = parseInt(process.env.IMAP_PORT, 10);
  let secure = String(process.env.IMAP_SECURE || "true").toLowerCase() !== "false";
  if (!host && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    // Gmail: same account, same app password, IMAP must be enabled in
    // Gmail settings (Forwarding and POP/IMAP).
    host = "imap.gmail.com";
    user = user || process.env.EMAIL_USER.trim();
    pass = pass || process.env.EMAIL_PASS;
    port = port || 993;
    secure = true;
  }
  if (!host || !user || !pass) return null;
  return { host, port: port || 993, secure, user, pass };
}

function isGmailHost(host) {
  return /(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i.test(String(host || ""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ImapFlow's message is often just "Command failed"; the server's own
// words are on the error object.
function describeError(error) {
  if (!error) return "unknown error";
  const parts = [error.message];
  if (error.serverResponseCode) parts.push(error.serverResponseCode);
  if (error.responseText) parts.push(error.responseText);
  if (error.command) parts.push(`(${error.command})`);
  return parts.join(": ");
}

class InboundMail {
  constructor() {
    this.store = null; // { get(key), set(key, value), del(key) }
    this.onMessage = null; // async (parsed, { folder, uid }) => result
    this.client = null;
    this.stopped = true;
    this.generation = 0;
    this.state = {
      enabled: isEnabled(),
      configured: false,
      connected: false,
      host: null,
      user: null,
      verifiedAt: null,
      lastCheckedAt: null,
      downSince: null,
      error: null,
      folders: [],
      processed: 0,
    };
    this._lastVerifyAt = 0;
    this._lastVerifyResult = null;
    this._wake = null;
    this._syncing = null;
  }

  getState() {
    const cfg = buildConfig();
    return Object.assign({}, this.state, {
      enabled: isEnabled(),
      configured: !!cfg,
      host: cfg ? cfg.host : null,
      user: cfg ? cfg.user : null,
    });
  }

  // "Can a switch be deployed?" — enabled, configured, and either connected
  // now or verified within the last few minutes.
  isReady() {
    const st = this.getState();
    if (!st.enabled || !st.configured) return false;
    if (st.connected) return true;
    return !!(st.verifiedAt && Date.now() - new Date(st.verifiedAt).getTime() < 5 * 60 * 1000);
  }

  // Log in, open INBOX, log out. Used at startup and on demand (activation).
  async verify() {
    const cfg = buildConfig();
    if (!cfg) {
      return { ok: false, error: isEnabled() ? "IMAP is not configured" : "reply-by-email is disabled (REPLY_BY_EMAIL=false)" };
    }
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      emitLogs: false,
    });
    try {
      await client.connect();
      const mb = await client.mailboxOpen("INBOX");
      await client.logout();
      this.state.verifiedAt = new Date().toISOString();
      this.state.error = null;
      console.log(
        `✅ IMAP verified: ${cfg.user}@${cfg.host}:${cfg.port} (INBOX has ${mb.exists} messages)`,
      );
      return { ok: true };
    } catch (error) {
      try { client.close(); } catch (_) {}
      this.state.error = describeError(error);
      console.error(`❌ IMAP verification failed for ${cfg.user}@${cfg.host}: ${this.state.error}`);
      return { ok: false, error: this.state.error };
    }
  }

  // verify() at most once a minute unless already connected.
  async ensureVerified() {
    if (this.getState().connected) return true;
    if (Date.now() - this._lastVerifyAt < VERIFY_THROTTLE_MS && this._lastVerifyResult) {
      return this._lastVerifyResult.ok;
    }
    this._lastVerifyAt = Date.now();
    this._lastVerifyResult = await this.verify();
    return this._lastVerifyResult.ok;
  }

  lastVerifyError() {
    return (this._lastVerifyResult && this._lastVerifyResult.error) || this.state.error;
  }

  // Start the read loop. `store` persists cursors and down_since; `onMessage`
  // receives each new message (mailparser result) in UID order.
  async start({ store, onMessage }) {
    this.store = store;
    this.onMessage = onMessage;
    this.stopped = false;
    const gen = ++this.generation;
    try {
      const ds = await store.get("imap:down_since");
      if (ds) this.state.downSince = ds;
    } catch (_) {}
    this._loop(gen).catch((e) => console.error("❌ IMAP loop crashed:", e));
  }

  async stop() {
    this.stopped = true;
    this.generation++;
    await this._closeClient();
  }

  // Config changed: drop the connection and start over with the new env.
  async reconfigure() {
    if (this.stopped) return;
    const store = this.store;
    const onMessage = this.onMessage;
    await this.stop();
    this._lastVerifyResult = null;
    this._lastVerifyAt = 0;
    await this.start({ store, onMessage });
  }

  // Ask the loop to sync now (test aid / after a config change).
  poke() {
    if (this._wake) this._wake();
  }

  async _closeClient() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await Promise.race([c.logout(), sleep(3000)]);
    } catch (_) {}
    try { c.close(); } catch (_) {}
  }

  async _loop(gen) {
    let backoff = RECONNECT_MIN_MS;
    while (!this.stopped && gen === this.generation) {
      const cfg = buildConfig();
      if (!cfg) {
        this.state.connected = false;
        await sleep(POLL_MS);
        continue;
      }
      try {
        await this._serve(cfg, gen);
        backoff = RECONNECT_MIN_MS; // clean close → quick retry
      } catch (error) {
        if (this.stopped || gen !== this.generation) break;
        await this._markDown(error);
      }
      await this._closeClient();
      if (this.stopped || gen !== this.generation) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  }

  async _serve(cfg, gen) {
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      emitLogs: false,
      // Keep the connection alive through IDLE; ImapFlow idles automatically
      // whenever no command is running on the selected mailbox.
    });
    this.client = client;

    let closed = null;
    const closedPromise = new Promise((resolve) => {
      closed = resolve;
    });
    client.on("error", (err) => {
      console.error(`❌ IMAP connection error: ${describeError(err)}`);
    });
    client.on("close", () => closed(new Error("connection closed")));
    client.on("exists", () => this.poke());

    await client.connect();
    console.log(`📥 IMAP connected: ${cfg.user}@${cfg.host}:${cfg.port}`);

    const folders = await this._resolveFolders(client, cfg);
    this.state.folders = folders;

    // Backlog first, then declare the connection up: the fail-safe must not
    // release the hold before replies that arrived during the outage have
    // been processed.
    await this._syncAll(client, folders);
    await this._markUp();

    while (!this.stopped && gen === this.generation && client.usable) {
      // Sleep until the poll interval passes, an 'exists' event arrives, or
      // the connection dies.
      let wakeTimer = null;
      const woke = await Promise.race([
        new Promise((resolve) => {
          this._wake = () => resolve("wake");
          wakeTimer = setTimeout(() => resolve("tick"), POLL_MS);
        }),
        closedPromise.then((e) => e),
      ]);
      this._wake = null;
      if (wakeTimer) clearTimeout(wakeTimer);
      if (woke instanceof Error) throw woke;
      if (this.stopped || gen !== this.generation) break;
      if (!client.usable) throw new Error("connection no longer usable");
      await this._syncAll(client, folders);
      this.state.lastCheckedAt = new Date().toISOString();
    }
  }

  async _resolveFolders(client, cfg) {
    const folders = ["INBOX"];
    try {
      const list = await client.list();
      const junk = list.find((m) => m.specialUse === "\\Junk");
      if (junk) {
        folders.push(junk.path);
      } else {
        const candidates = isGmailHost(cfg.host)
          ? ["[Gmail]/Spam", "Spam", "Junk"]
          : ["Junk", "Spam", "Junk E-mail", "INBOX.Junk", "INBOX.Spam"];
        for (const name of candidates) {
          if (list.some((m) => m.path === name)) {
            folders.push(name);
            break;
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ IMAP: could not list folders (${error.message}); reading INBOX only`);
    }
    return folders;
  }

  async _syncAll(client, folders) {
    if (this._syncing) return this._syncing;
    this._syncing = (async () => {
      for (const folder of folders) {
        try {
          await this._syncFolder(client, folder);
        } catch (error) {
          // INBOX failing is a real outage; the spam folder failing (Gmail
          // occasionally refuses to select it) must not take the reader
          // down with it.
          if (folder === "INBOX" || !client.usable) throw error;
          console.warn(`⚠️ IMAP: could not read ${folder} (${describeError(error)}); continuing with the other folders`);
        }
      }
      // Leave INBOX selected so IDLE reports new mail there.
      if (!client.mailbox || client.mailbox.path !== "INBOX") {
        try { await client.mailboxOpen("INBOX"); } catch (_) {}
      }
    })().finally(() => {
      this._syncing = null;
    });
    return this._syncing;
  }

  async _syncFolder(client, folder) {
    const lock = await client.getMailboxLock(folder);
    try {
      const mb = client.mailbox;
      const validity = String(mb.uidValidity);
      const uidNext = Number(mb.uidNext) || 0;
      const validityKey = `imap:${folder}:uidvalidity`;
      const lastKey = `imap:${folder}:lastuid`;
      const storedValidity = await this.store.get(validityKey);
      let lastUid = parseInt(await this.store.get(lastKey), 10);

      if (storedValidity !== validity || !Number.isFinite(lastUid)) {
        // First sight of this folder, or the server rebuilt it: nothing
        // before now can be trusted as a reply to a code that is still
        // live, so start from the present rather than replaying history.
        lastUid = Math.max(0, uidNext - 1);
        await this.store.set(validityKey, validity);
        await this.store.set(lastKey, lastUid);
        console.log(`📥 IMAP: cursor for ${folder} set to UID ${lastUid} (UIDVALIDITY ${validity})`);
        return;
      }
      if (uidNext > 0 && uidNext - 1 <= lastUid) return; // nothing new

      const metas = [];
      for await (const msg of client.fetch(
        `${lastUid + 1}:*`,
        { uid: true, size: true, headers: GATE_HEADERS },
        { uid: true },
      )) {
        // "N:*" returns the last message even when N > max UID.
        if (msg.uid <= lastUid) continue;
        metas.push(msg);
      }
      metas.sort((a, b) => a.uid - b.uid);

      for (const meta of metas) {
        try {
          await this._processMessage(client, folder, meta);
        } catch (error) {
          console.error(`❌ IMAP: processing ${folder} UID ${meta.uid} failed: ${describeError(error)}`);
        }
        lastUid = meta.uid;
        await this.store.set(lastKey, lastUid);
      }
    } finally {
      lock.release();
    }
  }

  async _processMessage(client, folder, meta) {
    // Cheap gates on headers alone. The parser's own gates run again on the
    // full message; these only avoid downloading bodies that cannot matter.
    let head = null;
    try {
      head = meta.headers ? await simpleParser(meta.headers) : null;
    } catch (_) {}
    const rawHas = (key) =>
      head && Array.isArray(head.headerLines) && head.headerLines.some((h) => h.key === key);
    if (rawHas("x-deploy-deadman")) return; // Deploy's own mail in a shared inbox
    if (meta.size && meta.size > MAX_MESSAGE_BYTES) return;

    const full = await client.fetchOne(String(meta.uid), { source: true }, { uid: true });
    if (!full || !full.source) return;
    const parsed = await simpleParser(full.source);
    this.state.processed++;
    if (this.onMessage) {
      const result = await this.onMessage(parsed, { folder, uid: meta.uid });
      if (result && result.action && result.action !== "dropped") {
        console.log(`📥 IMAP: ${folder} UID ${meta.uid} → ${result.action}${result.reason ? ` (${result.reason})` : ""}`);
      }
    }
  }

  async _markDown(error) {
    this.state.connected = false;
    this.state.error = describeError(error);
    if (!this.state.downSince) {
      this.state.downSince = new Date().toISOString();
      try { await this.store.set("imap:down_since", this.state.downSince); } catch (_) {}
      console.error(`❌ IMAP DOWN since ${this.state.downSince}: ${this.state.error}`);
    } else {
      console.error(`❌ IMAP still down (since ${this.state.downSince}): ${this.state.error}`);
    }
    // ntfy in addition to (never instead of) the email alert the routes send.
    notifyThrottled(
      "imap-down",
      60 * 60 * 1000,
      `Deploy cannot read its mailbox (${this.state.error}). Replies to check-in emails are NOT being received. Check in from the dashboard and fix the IMAP settings.`,
      { priority: "urgent", tags: "rotating_light,mailbox" },
    );
  }

  async _markUp() {
    this.state.connected = true;
    this.state.error = null;
    this.state.lastCheckedAt = new Date().toISOString();
    this.state.verifiedAt = this.state.lastCheckedAt;
    if (this.state.downSince) {
      const since = this.state.downSince;
      this.state.downSince = null;
      try { await this.store.del("imap:down_since"); } catch (_) {}
      console.log(`✅ IMAP recovered (was down since ${since}); backlog processed`);
      clearThrottle("imap-down");
      notify("Deploy can read its mailbox again — replies are being received.", {
        tags: "white_check_mark,mailbox",
      });
    }
  }
}

const inboundMail = new InboundMail();
inboundMail.buildConfig = buildConfig;
inboundMail.isEnabled = isEnabled;
module.exports = inboundMail;
