#!/usr/bin/env node
// Sandbox end-to-end run for reply-by-email (v2.2.0). Spawns the SMTP sink
// and the server with DEPLOY_TEST_HOOKS=1 and compressed timers, drives the
// HTTP API, reads the emails the sink captured, and injects replies through
// POST /internal/test/inbound as if IMAP had delivered them.
//
//   node tests/tools/sandbox-e2e.js [full|failsafe|upgrade]
//
// "full": deploy → arming by reply → first contact → beneficiary ack →
//   periodic check-in by reply → restart mid-cycle → reply processed once →
//   wrong code ×5 → lockout + reissue → stale code → expired + fresh email →
//   silence → warning → beneficiary warning-ack by reply → CRITICAL. Asserts
//   no http link in any operator/beneficiary email except CRITICAL's tool links.
// "upgrade": first start after v2.2.0 on a pre-upgrade-shaped DB → coded
//   "Deploy was updated" check-in + re-sent ping, missed counter reset.
// "failsafe": IMAP configured but unreachable → warning tick is HELD and the
//   alert email goes out; then restart with IMAP unset → normal timing → fire.
//
// Takes roughly 6 minutes (1-minute check-ins, 3-minute inactivity).

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { simpleParser } = require("mailparser");
const { CODE_REGEX, normalizeCode, formatCode } = require("../../utils/codes");

const ROOT = path.resolve(__dirname, "..", "..");
const scenario = process.argv[2] || "full";
const PORT = 3999;
const SINK_PORT = 2526;
const base = `http://127.0.0.1:${PORT}`;
const OP = "op@example.com";
const BEN = "ben@example.com";
const OTHER = "other@example.com";
const DEPLOY = "deploy@example.com";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-e2e-"));
const sinkDir = path.join(work, "sink");
fs.mkdirSync(sinkDir);
const children = [];
let serverProc = null;
let serverLog = "";

function log(msg) {
  console.log(`\x1b[36m[e2e ${new Date().toISOString().slice(11, 19)}]\x1b[0m ${msg}`);
}
function fail(msg) {
  console.error(`\x1b[31m[e2e FAIL]\x1b[0m ${msg}`);
  console.error("--- last server log ---\n" + serverLog.split("\n").slice(-60).join("\n"));
  shutdown(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
  else log(`ok: ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shutdown(code) {
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch (_) {}
  }
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(130));

function startSink() {
  const p = spawn(process.execPath, [path.join(ROOT, "tests/tools/smtp-sink.js"), String(SINK_PORT), sinkDir], { stdio: ["ignore", "inherit", "inherit"] });
  children.push(p);
}

async function startServer(extraEnv = {}) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    DB_PATH: path.join(work, "e2e.db"),
    SECRET_KEY: "ZTJlLXNlY3JldC1rZXktZTJlLXNlY3JldC1rZXktMDA=",
    EMAIL_USER: "",
    EMAIL_PASS: "",
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(SINK_PORT),
    SMTP_USER: DEPLOY,
    SMTP_PASS: "y",
    DEPLOY_TEST_HOOKS: "1",
    REISSUE_MIN_GAP_MS: "1000",
    PING_FORCE_MIN_GAP_MS: "1000",
    NTFY_TOPIC: "",
    NODE_ENV: "development",
    APP_URL: "http://localhost:3999",
  }, extraEnv);
  // The server loads ./.env with dotenv, which never overrides a variable
  // that is already set — so every key above is pinned even when the repo's
  // real .env carries Gmail credentials.
  const cwd = ROOT;
  serverLog = "";
  const p = spawn(process.execPath, ["server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => { serverLog += d.toString(); if (process.env.E2E_VERBOSE) process.stdout.write(d); });
  p.stderr.on("data", (d) => { serverLog += d.toString(); if (process.env.E2E_VERBOSE) process.stderr.write(d); });
  children.push(p);
  serverProc = p;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch (_) {}
    await sleep(200);
  }
  await waitForLog(/RECOVERY: Recovery complete|Found 0 recoverable/, 15000);
  log(`server up (pid ${p.pid})`);
}

async function stopServer() {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
  children.splice(children.indexOf(p), 1);
  log("server stopped");
}

async function waitForLog(re, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (re.test(serverLog)) return true;
    await sleep(200);
  }
  return false;
}

let cookie = "";
async function api(method, p, body, opts = {}) {
  const headers = { "Content-Type": opts.raw ? "text/plain" : "application/json" };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

// ---- sink helpers ----
const seen = new Set();
async function readMail() {
  const out = [];
  for (const f of fs.readdirSync(sinkDir).filter((f) => f.endsWith(".eml")).sort()) {
    const raw = fs.readFileSync(path.join(sinkDir, f));
    const parsed = await simpleParser(raw);
    out.push({ file: f, parsed, raw: raw.toString("utf8") });
  }
  return out;
}
// Next unseen message matching, waiting up to timeoutMs.
async function waitMail(pred, label, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const m of await readMail()) {
      if (seen.has(m.file)) continue;
      if (pred(m)) {
        seen.add(m.file);
        log(`mail ${m.file}: "${m.parsed.subject}" → ${m.parsed.to.text}`);
        return m;
      }
    }
    await sleep(500);
  }
  fail(`timed out waiting for mail: ${label}`);
}
// The code as printed in the email: the hyphenated match (an English word
// such as "prepared" also fits the alphabet, so plain first-match is wrong).
function codeOf(m) {
  const t = m.parsed.text || "";
  const re = new RegExp(CODE_REGEX.source, "gi");
  let match;
  let bare = null;
  while ((match = re.exec(t)) !== null) {
    if (match[0].length > 8) return normalizeCode(match[0]);
    bare = bare || match[0];
  }
  if (!bare) fail(`no code in "${m.parsed.subject}"`);
  return normalizeCode(bare);
}
function to(m) { return (m.parsed.to.value[0].address || "").toLowerCase(); }
// Routine ("Deploy check-in — …") or overdue ("URGENT: Deploy check-in overdue — …").
function isCheckinMail(m) { return /^(URGENT: )?Deploy check-in( overdue)? — /.test(subj(m)); }
function subj(m) { return m.parsed.subject || ""; }
function assertNoLinks(m) {
  const text = (m.parsed.text || "") + (m.parsed.html || "");
  assert(!/https?:\/\//i.test(text), `no http link in "${subj(m)}"`);
}

// ---- reply builder ----
function eml({ from, to: rcpt, subject, body, quoted, headers = {}, html = null }) {
  const h = [
    `From: ${from}`,
    `To: ${rcpt}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@example.com>`,
    "MIME-Version: 1.0",
  ];
  for (const [k, v] of Object.entries(headers)) h.push(`${k}: ${v}`);
  let text = body;
  if (quoted) {
    text += `\n\nOn ${new Date().toUTCString()} Deploy Deadman Switch <${DEPLOY}> wrote:\n` +
      quoted.split("\n").map((l) => "> " + l).join("\n") + "\n";
  }
  if (html) {
    const b = "b" + Date.now();
    h.push(`Content-Type: multipart/alternative; boundary="${b}"`);
    return h.join("\r\n") + "\r\n\r\n" + `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--${b}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--${b}--\r\n`;
  }
  h.push("Content-Type: text/plain; charset=utf-8");
  return h.join("\r\n") + "\r\n\r\n" + text + "\r\n";
}
async function inject(raw) {
  const r = await api("POST", "/internal/test/inbound", raw, { raw: true });
  if (r.status !== 200 || !r.json || !r.json.ok) fail(`inject failed: ${r.status} ${JSON.stringify(r.json)}`);
  log(`inject → ${JSON.stringify(r.json.result)}`);
  return r.json.result;
}
function reply(from, code, m, extra = {}) {
  return eml(Object.assign({
    from,
    to: DEPLOY,
    subject: "Re: " + subj(m),
    body: code,
    quoted: m.parsed.text,
  }, extra));
}

// ---- scenario steps ----
async function deployAndArm() {
  let r = await api("POST", "/deadman/signup", { email: OP, password: "pw-e2e-1234" });
  assert(r.status === 201 || r.status === 409, "signup");
  r = await api("POST", "/deadman/login", { email: OP, password: "pw-e2e-1234" });
  assert(r.status === 200, "login");
  r = await api("POST", "/deadman/emails", { emailAddress: BEN, emailContent: "Hello Ben, the vault is under the floor.", emailIndex: null, password: "pw-e2e-1234", emailPayload: "LEGACY-TEST-PAYLOAD" });
  assert(r.status === 200, "add recipient");
  r = await api("GET", "/deadman/inbound-status");
  assert(r.status === 200 && r.json.testHooks === true, "inbound-status reachable, test hooks on");
  r = await api("POST", "/deadman/activate", { checkinInterval: "1-minutes", inactivityPeriod: "3-minutes", password: "pw-e2e-1234" });
  assert(r.status === 200 && r.json.pending === true, `activate → pending (${r.json && r.json.message})`);
  assert(!/click/i.test(r.json.message), "activation message speaks of replying, not clicking");

  const arming = await waitMail((m) => to(m) === OP && /arm your Deploy switch/.test(subj(m)), "arming email");
  assertNoLinks(arming);
  assert(/reply to this email with this code/i.test(arming.parsed.text), "arming email tells the reader to reply with the code");
  const codeA = codeOf(arming);
  log(`arming code ${formatCode(codeA)}`);

  // auto-reply with the code only inside the quote → dropped
  let res = await inject(eml({ from: OP, to: DEPLOY, subject: "Automatic reply: " + subj(arming), body: "I am away.", quoted: arming.parsed.text, headers: { "Auto-Submitted": "auto-replied" } }));
  assert(res.action === "dropped" && res.reason === "auto-reply", "vacation auto-reply dropped");
  // helpdesk-style: no headers, code only inside the quote → no code
  res = await inject(eml({ from: OP, to: DEPLOY, subject: "Re: " + subj(arming), body: "Thanks, ticket opened.", quoted: arming.parsed.text }));
  assert(res.action === "dropped" && res.reason === "no-code", "quoted-only code ignored");
  // right code, wrong sender → rejected + receipt to the original address
  res = await inject(reply(OTHER, formatCode(codeA), arming));
  assert(res.action === "rejected" && res.reason === "from-mismatch", "reply from another address rejected");
  const mism = await waitMail((m) => to(m) === OP && /not accepted/i.test(subj(m)), "from-mismatch receipt");
  assert(new RegExp(OTHER).test(mism.parsed.text), "receipt names the other address");
  r = await api("GET", "/deadman/timer-status");
  assert(r.json.pending === true, "still pending after rejected/dropped replies");
  // unrecognised sender with a wrong code → silence
  res = await inject(eml({ from: "stranger@example.net", to: DEPLOY, subject: "hi", body: "ABCD-EFGH" }));
  assert(res.action === "dropped" && res.reason === "unknown-sender", "stranger with a wrong code gets nothing");

  // the real thing: lower-case, no hyphen, HTML part with the quote in a blockquote
  res = await inject(reply(OP, codeA.toLowerCase(), arming, { html: `<div>${codeA.toLowerCase()}</div><blockquote>${codeA}</blockquote>` }));
  assert(res.action === "checkin" && res.wasPending === true && res.via === "reply", "arming reply arms the switch");
  const armed = await waitMail((m) => to(m) === OP && /switch armed/i.test(subj(m)), "armed receipt");
  assert(/round trip is verified/.test(armed.parsed.text), "armed receipt text");
  r = await api("GET", "/deadman/timer-status");
  assert(r.json.active && r.json.pending === false && r.json.lastCheckinVia === "reply", "timer-status: armed, via reply");
  // same code again → repeat receipt, nothing else
  res = await inject(reply(OP, formatCode(codeA), arming));
  assert(res.action === "repeat", "used code again → repeat");
  await waitMail((m) => to(m) === OP && /already used/i.test(subj(m)), "already-used receipt");
  return codeA;
}

async function firstContact() {
  const ping = await waitMail((m) => to(m) === BEN && /trusted contact/.test(subj(m)), "first-contact email");
  assertNoLinks(ping);
  assert(/one reply required/.test(subj(ping)), "first-contact subject says reply");
  const codeB = codeOf(ping);
  // beneficiary's wrong code first → "didn't match"
  let res = await inject(eml({ from: BEN, to: DEPLOY, subject: "Re: " + subj(ping), body: "K7M4-P2XQ" }));
  assert(res.action === "wrong-code" && res.attempts === 1, "beneficiary wrong code counted");
  await waitMail((m) => to(m) === BEN && /didn't match/.test(subj(m)), "didn't-match receipt to beneficiary");
  res = await inject(reply(BEN, formatCode(codeB), ping));
  assert(res.action === "ack" && res.kind === "ping-ack" && res.ok, "beneficiary ack by reply");
  await waitMail((m) => to(m) === BEN && /Confirmed/.test(subj(m)), "confirmed receipt to beneficiary");
  await waitMail((m) => to(m) === OP && /recipient confirmed/.test(subj(m)), "operator notice of confirmation");
  res = await inject(reply(BEN, formatCode(codeB), ping));
  assert(res.action === "repeat", "nervous beneficiary sends twice → repeat");
  const r = await api("POST", "/deadman/beneficiary-status", { password: "pw-e2e-1234" });
  assert(r.json.beneficiaries[0].ackAt, "beneficiary-status shows ackAt");
}

async function periodicAndRestart() {
  const c1 = await waitMail((m) => to(m) === OP && isCheckinMail(m), "first periodic check-in email", 120000);
  assertNoLinks(c1);
  const codeC = codeOf(c1);
  // restart mid-cycle; the reply arrives after the restart and is processed once
  await stopServer();
  await startServer();
  let r = await api("GET", "/deadman/timer-status");
  assert(r.json.active && !r.json.pending, "switch recovered after restart");
  let res = await inject(reply(OP, formatCode(codeC), c1));
  assert(res.action === "checkin" && res.wasPending === false, "reply after restart checks in");
  await waitMail((m) => to(m) === OP && /check-in received/i.test(subj(m)), "check-in receipt");
  r = await api("GET", "/deadman/timer-status");
  assert(r.json.lastCheckinVia === "reply" && r.json.missedCheckins === 0, "missed count reset, via reply");
  res = await inject(reply(OP, formatCode(codeC), c1));
  assert(res.action === "repeat", "same reply again is not a second check-in");
  return codeC;
}

async function lockoutAndExpiry() {
  // wait for the next check-in email so a live code exists to guess against
  const c2 = await waitMail((m) => to(m) === OP && isCheckinMail(m), "second periodic check-in email", 120000);
  const codeD = codeOf(c2);
  let res;
  for (let i = 1; i <= 5; i++) {
    // valid-alphabet codes that are simply not the live one
    res = await inject(eml({ from: OP, to: DEPLOY, subject: "Re: " + subj(c2), body: `WRNG-CD${i + 1}X` }));
  }
  assert(res.action === "wrong-code" && res.lockedOut === true && res.reissued === true, "5th wrong code → lockout + reissue");
  const fresh = await waitMail((m) => to(m) === OP && isCheckinMail(m), "reissued check-in email after lockout", 30000);
  const codeE = codeOf(fresh);
  assert(codeE !== codeD, "reissued code differs");
  res = await inject(reply(OP, formatCode(codeD), c2));
  assert(res.action === "expired", "locked-out code is expired");
  await waitMail((m) => to(m) === OP && /has expired/.test(subj(m)), "expired receipt");
  await sleep(1200); // REISSUE_MIN_GAP_MS
  // stale code → expired + fresh email (reissue)
  res = await inject(reply(OP, formatCode(codeE), fresh));
  assert(res.action === "checkin", "fresh code checks in");
  const c3 = await waitMail((m) => to(m) === OP && isCheckinMail(m), "next periodic check-in", 120000);
  const codeF = codeOf(c3);
  await sleep(1200);
  res = await inject(reply(OP, formatCode(codeE), fresh)); // E is used → repeat
  assert(res.action === "repeat", "used code → repeat, no reissue");
  // make F stale by waiting for the following tick, then reply with F
  const c4 = await waitMail((m) => to(m) === OP && isCheckinMail(m), "following periodic check-in", 120000);
  res = await inject(reply(OP, formatCode(codeF), c3));
  assert(res.action === "expired" && res.reissued === true, "superseded code → expired + reissue");
  const fresh2 = await waitMail((m) => to(m) === OP && isCheckinMail(m) && !seen.has(m.file), "fresh check-in after expired reply", 30000);
  res = await inject(reply(OP, formatCode(codeOf(fresh2)), fresh2));
  assert(res.action === "checkin", "fresh code after expiry checks in");
  return c4;
}

async function silenceToFire() {
  // Earlier steps may already have produced a warning (two unanswered ticks
  // during the lockout/expiry dance) that the last check-in stood down;
  // only mail from this point on counts.
  for (const m of await readMail()) seen.add(m.file);
  log("going silent — expecting warning at missed=2, CRITICAL at 3 minutes");
  const warn = await waitMail((m) => to(m) === BEN && /^URGENT: .*stopped responding/.test(subj(m)), "beneficiary pre-fire warning", 200000);
  assertNoLinks(warn);
  assert(/reply(ing)? to this email/i.test(warn.parsed.text), "warning asks for a reply");
  const codeW = codeOf(warn);
  let res = await inject(reply(BEN, formatCode(codeW), warn));
  assert(res.action === "ack" && res.kind === "warning-ack" && res.ok, "warning ack by reply");
  let r = await api("GET", "/deadman/timer-status");
  assert(r.json.warningSent === true && r.json.warningAcknowledged === true, "timer-status shows warning acknowledged");
  const crit = await waitMail((m) => to(m) === BEN && /^CRITICAL:/.test(subj(m)), "CRITICAL trigger email", 200000);
  assert(/LEGACY-TEST-PAYLOAD/.test(crit.parsed.text), "CRITICAL carries the payload");
  assert(/legacy_encryption/i.test(crit.parsed.text), "CRITICAL keeps its external tool links");
  await sleep(1500);
  r = await api("GET", "/deadman/deadman-status");
  assert(r.json.triggered === true, "deadman-status: triggered");
  // a code from the fired switch no longer works
  res = await inject(reply(BEN, formatCode(codeW), warn));
  assert(res.action === "repeat" || res.action === "expired" || res.action === "dropped", "post-fire reply does nothing harmful");
  // every non-CRITICAL email was link-free
  for (const m of await readMail()) {
    if (/^CRITICAL:/.test(subj(m))) continue;
    const text = (m.parsed.text || "") + (m.parsed.html || "");
    if (/https?:\/\//i.test(text)) fail(`link found in non-CRITICAL email ${m.file} "${subj(m)}"`);
  }
  log("ok: no http link in any non-CRITICAL email");
}

async function failsafe() {
  // IMAP "configured" but unreachable: connection fails → down_since set.
  await deployAndArm();
  await firstContact();
  const held = await waitForLog(/IMAP DOWN since/, 30000);
  assert(held, "IMAP marked down");
  const alert = await waitMail((m) => to(m) === OP && /replies are not being received/.test(subj(m)), "inbound-down alert email", 700000);
  assert(/held/i.test(alert.parsed.text), "alert says warning and fire are held");
  // silence: the warning tick must be HELD, the fire must be HELD
  const heldLog = await waitForLog(/PRE-FIRE WARNING HELD/, 200000);
  assert(heldLog, "pre-fire warning held while IMAP down");
  const fireHeld = await waitForLog(/FIRE HELD/, 200000);
  assert(fireHeld, "fire held while IMAP down");
  for (const m of await readMail()) {
    if (/^CRITICAL:/.test(subj(m))) fail("CRITICAL sent while inbound was down");
    if (/stopped responding/.test(subj(m))) fail("warning sent while inbound was down");
  }
  log("ok: no warning, no CRITICAL while held");
  // recover: restart with IMAP unset → not configured → no hold → fire proceeds
  await stopServer();
  await startServer({ IMAP_HOST: "", IMAP_USER: "", IMAP_PASS: "" });
  const crit = await waitMail((m) => to(m) === BEN && /^CRITICAL:/.test(subj(m)), "CRITICAL after hold released", 120000);
  assert(!!crit, "fired once the hold was gone");
}

// First start after the v2.2.0 upgrade: an armed switch (stale missed
// count) and a never-answered ping must each get a coded email worded as
// an update notice, the missed counter must restart at zero, and the new
// codes must work. Runs against a DB shaped like a pre-upgrade one.
async function upgrade() {
  await deployAndArm();
  const ping = await waitMail((m) => to(m) === BEN && /trusted contact/.test(subj(m)), "first-contact email (left unanswered)");
  await stopServer();
  const sqlite3 = require("sqlite3");
  const db = new sqlite3.Database(path.join(work, "e2e.db"));
  await new Promise((res, rej) => db.serialize(() => {
    db.run("DELETE FROM settings WHERE key = 'migrated_reply_codes'");
    db.run("UPDATE deadman_sessions SET missed_checkins = 3 WHERE is_active = 1", (e) => (e ? rej(e) : res()));
  }));
  await new Promise((r) => db.close(r));
  for (const m of await readMail()) seen.add(m.file);
  await startServer();
  assert(await waitForLog(/UPGRADE: done — 1 operator check-in\(s\), 1 beneficiary ping\(s\) re-sent/, 20000), "upgrade pass ran once for 1 switch + 1 ping");
  const up = await waitMail((m) => to(m) === OP && /Deploy was updated/.test(subj(m)), "post-upgrade check-in email");
  assertNoLinks(up);
  assert(/schedule|interval and settings are unchanged/i.test(up.parsed.text), "upgrade email says settings are unchanged");
  const rp = await waitMail((m) => to(m) === BEN && /trusted contact/.test(subj(m)), "re-sent first-contact email");
  assertNoLinks(rp);
  assert(/changed how you confirm/.test(rp.parsed.text), "re-sent ping explains the change");
  let r = await api("GET", "/deadman/timer-status");
  assert(r.json.active && r.json.missedCheckins === 0, "missed counter reset to zero");
  let res = await inject(reply(BEN, formatCode(codeOf(ping)), ping));
  assert(res.action === "expired", "old ping code is stale, not live");
  res = await inject(reply(OP, formatCode(codeOf(up)), up));
  assert(res.action === "checkin" && res.via === "reply", "upgrade code checks in");
  res = await inject(reply(BEN, formatCode(codeOf(rp)), rp));
  assert(res.action === "ack" && res.ok, "re-sent ping code acks");
  await stopServer();
  await startServer();
  assert(!(await waitForLog(/UPGRADE: first start/, 5000)), "migration does not run twice");
}

(async () => {
  startSink();
  await sleep(300);
  if (scenario === "upgrade") {
    await startServer();
    await upgrade();
  } else if (scenario === "failsafe") {
    await startServer({ IMAP_HOST: "127.0.0.1", IMAP_PORT: "1", IMAP_USER: "x", IMAP_PASS: "y" });
    await failsafe();
  } else {
    await startServer();
    await deployAndArm();
    await firstContact();
    await periodicAndRestart();
    await lockoutAndExpiry();
    await silenceToFire();
  }
  log(`SCENARIO ${scenario} PASSED (work dir ${work})`);
  shutdown(0);
})().catch((e) => {
  fail(e.stack || String(e));
});
