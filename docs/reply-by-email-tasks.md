# Reply-by-email — implementation task list (v2.2.0)

Spec: `docs/reply-by-email.md` (read it first, all of it). Invariants:
`CLAUDE.md`. Work in this order; each step leaves the suite green.

## 0. Setup
- [x] `npm install imapflow mailparser` (commit package-lock.json — the
      Docker build runs `npm ci`).
- [x] Bump version to 2.2.0 in `package.json`, `manifest.yaml`,
      `start9/manifest.yaml` (release notes prepended, same style as 2.1.10).

## 1. Codes (`utils/codes.js` + `tests/codes.test.js`)
- [x] `ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"`, `generateCode()` →
      8 chars via `crypto.randomInt`, `formatCode()` → `XXXX-XXXX`,
      `normalizeCode(s)` → uppercase, strip `-`/spaces/punctuation,
      `hashCode(code)` → sha256 hex of normalized, `CODE_REGEX` matching
      the alphabet with optional single separator after 4 chars.
- [x] Tests: alphabet has no 0/O/1/I/L; round-trip; normalisation of lower
      case, no hyphen, trailing period, autocorrected spacing.

## 2. Persistence (`database/init.js`, `database/userService.js`)
- [x] New table `reply_codes(id, code_hash UNIQUE, kind
      ['arming','checkin','ping-ack','warning-ack'], user_id,
      recipient_hash, ref TEXT, created_at, used_at, retired_at,
      failed_attempts INTEGER DEFAULT 0)`. `ref` = session_token for
      arming/checkin/warning-ack, beneficiary_pings.id for ping-ack.
      `recipient_hash` = sha256(lowercased address the email went to).
- [x] `issueCode({kind,userId,recipientHash,ref})` retires (retired_at=now)
      any live code with the same (user_id, kind[, ref]) and inserts the new
      one; returns the plaintext code once.
- [x] `findLiveCode(hash)`, `markCodeUsed(id)`, `bumpFailedAttempts(id)`
      (returns new count), `retireCode(id)`, `liveCodeFor(userId, kind, ref)`.
- [x] `settings` rows for inbound state: `imap:<folder>:uidvalidity`,
      `imap:<folder>:lastuid`, `imap:down_since`, `migrated_reply_codes`.
- [x] Add `reply_codes.user_id` to the cascade-delete paths (nuclear reset,
      delete account) alongside beneficiary_pings.

## 3. Email content (`utils/emailService.js`)
- [x] `sendCheckinEmail(userEmail, code, missedCheckins, {arming})`: subject
      `Deploy check-in — <D Mon YYYY>` (arming: `Confirm your first
      check-in to arm your Deploy switch — <date>`); body per spec UX;
      code in plain text AND html, monospace, large; NO button, NO URL.
      Set `Reply-To` to the routine address explicitly.
- [x] `buildBeneficiaryPingContent(operatorEmail, code, firstContact)` and
      `sendBeneficiaryWarning(addr, operator, days, code, isResend)`: code
      instead of ackUrl; delete `torNotice()` and every `${APP_URL}` use.
- [x] `GET /deadman/contact-template` passes the inert code `EXAM-PLE1`.
- [x] New: `sendReceipt(to, subject, text)` (plain, one line), and
      `sendInboundDownAlert(operatorEmail, downSince)`.
- [x] Nothing in `sendDeadmanEmails` (CRITICAL) changes.

## 4. Inbound parser (`utils/inboundParser.js` + `tests/inboundParser.test.js`)
- [x] `isAutoReply(headers)`: `Auto-Submitted` ≠ `no`, `X-Autoreply`,
      `X-Autorespond`, `X-Auto-Response-Suppress`, `Precedence`
      bulk|auto_reply|junk|list, `List-Id`. `isBounce(parsed)`:
      `mailer-daemon`/`postmaster` From, empty Return-Path,
      `multipart/report`.
- [x] `visibleText(parsed)`: prefer text part; else html → strip
      `<blockquote>`, `.gmail_quote`, `#divRplyFwdMsg`, `.yahoo_quoted`,
      `#appendonsend`, then to text. Then cut at the first quote marker
      (leading `>`, `On … wrote:`, `-----Original Message-----`,
      `________________________________`, `From:` followed within 3 lines
      by `Sent:|Date:` and `To:`, and the fr/de/es Gmail/Apple variants).
- [x] `extractCode(subject, visibleText)` → normalized code or null
      (subject first, then body; first match wins).
- [x] Fixtures under `tests/fixtures/inbound/`: gmail-web, gmail-ios,
      gmail-android, outlook-desktop, outlook-web, outlook-ios, apple-mail,
      thunderbird, proton-web; each top-posted; plus bottom-posted,
      quote-stripped, vacation (Auto-Submitted), helpdesk auto-ack quoting
      the original (code only inside quote → null), forward, code in
      subject only, code lowercase no hyphen, code with trailing period.
      Write the fixtures by hand from real client output shapes.

## 5. Core refactor (`routes/deadman.js`)
- [x] `issueCheckinEmail(userEmail, switchData, {arming, missedCheckins})`:
      generate code → `issueCode(kind arming|checkin, ref=sessionToken)` →
      `sendCheckinEmail`. Record `switchData.lastCheckinSentAt`. Replace
      EVERY `crypto.randomBytes… checkinTokens.set… sendCheckinEmail` site
      (activate arming, pending reminders, both periodic ticks, recovery,
      /recover, resend paths). Enforce the one-reissue-per-hour limit for
      reissues triggered by inbound mail (not for scheduled ticks).
- [x] `performCheckin(userEmail, switchData, {via})`: body of today's
      `GET /checkin/:token` minus token lookup and HTML. Returns
      `{ok, wasPending}`. Dashboard check-in endpoint calls it with
      `via:"dashboard"`; inbound calls it with `via:"reply"`.
- [x] `performAck(codeRow)`: ping-ack → `ackBeneficiaryPing(row.ref)`
      (by id, not token) + operator notification as today; warning-ack →
      set `warningAckAt` on the session as today.
- [x] Delete `GET /checkin/:token`, `GET /ack/:token`, `checkinTokens`,
      `usedCheckinTokens`, `rememberUsedCheckinToken`, and the
      `checkinTokens` cleanup loops in reset/clear/nuclear paths.
      `warningAckToken` and `beneficiary_pings.ping_token` become unused
      (leave columns; never drop in SQLite).
- [x] `processBeneficiaryPings`: `issueCode(kind ping-ack, ref=ping.id,
      recipientHash)` and pass the code to the ping email.
- [x] `/activate`: refuse with a clear 400 unless
      `inboundMail.isReady()` — except when `DEPLOY_TEST_HOOKS=1`.
- [x] `GET /inbound-status` → `{configured, connected, lastCheckedAt,
      downSince, error}` for the dashboard.

## 6. Inbound handling (`utils/inboundMail.js`)
- [x] Config: `IMAP_HOST/PORT/SECURE/USER/PASS`; derive Gmail
      (`imap.gmail.com:993`, EMAIL_USER/EMAIL_PASS) when
      `EMAIL_PROVIDER=gmail` and no IMAP_HOST. `REPLY_BY_EMAIL=false`
      disables (dashboard-only mode; activation refuses unless test hooks).
- [x] `verify()` at startup and on demand: login, select INBOX, log result.
- [x] Loop: folders `INBOX` + spam (`[Gmail]/Spam` when host is Gmail;
      else `Junk`/`Spam` if present). Per folder: compare UIDVALIDITY
      (reset lastuid on change), fetch `UID lastuid+1:*` headers+body,
      process in UID order, persist lastuid after each message. IDLE on
      INBOX when supported; otherwise poll every 60 s. Reconnect with
      backoff; set `imap:down_since` on first failure, clear on success.
- [x] `handleInbound(parsed)`: bounce/auto-reply → drop. `extractCode`
      → none → drop silently. `findLiveCode(hash)` → none: if the hash
      matches a used/retired code of some user, send the "expired — fresh
      one on its way" receipt to that user's address and reissue (rate
      limited); else drop. Live: `From` hash ≠ `recipient_hash` → receipt
      to the ORIGINAL address ("arrived from <other> and was not
      accepted"), once per code; else dispatch by kind → `performCheckin`
      / `performAck` → `markCodeUsed` → success receipt. Wrong-code
      handling: only reachable when a From-matching message carries a code
      that hashes to nothing live but the sender has a live code of that
      kind → `bumpFailedAttempts` on that live code; at 5 → retire +
      reissue + receipt.
- [x] Never move/delete mail; never mark flags except optionally
      `$DeployHandled`.
- [x] Test hook: `POST /internal/test/inbound` (raw RFC822 body), enabled
      only with `DEPLOY_TEST_HOOKS=1`, runs `handleInbound` on it.

## 7. Fail-safe (`routes/deadman.js`)
- [x] In `registerMissedCheckin` and in both deadman-timer fire paths: if
      `imap:down_since` is set AND down_since < `lastCheckinSentAt` AND
      now − down_since < 7 days → count the miss, but skip the warning /
      postpone the fire (reschedule fire check every 10 min); send
      `sendInboundDownAlert` at most once per 24 h (+ ntfy if set). When
      the connection recovers, process backlog first. After 7 days,
      resume normal timing; the alert says so.
- [x] Dashboard red banner from `/inbound-status` when downSince is set.

## 8. Frontend (`public/`)
- [x] Welcome/how-it-works copy: "click the link" → "reply with the code".
      Remove any mention of Tor Browser for beneficiaries.
- [x] Status line "Email replies: connected — last checked <UTC>" /
      "not configured" / red banner; poll with the existing sync.
- [x] Last check-in shows "via reply" / "via dashboard".
- [x] Contact template preview shows the inert code.

## 9. Config + docs
- [x] `start9/configurator.sh`: `imap_host`, `imap_port` (993),
      `imap_user`, `imap_password` (masked) for the custom-SMTP provider;
      Gmail derives; description states mailbox scope. `app_url`
      description: "Where your dashboard lives. Emails no longer contain
      links." Pass through to `.env` and `/internal/config`.
- [x] `README.md`, `windows/WINDOWS_SETUP.md`, `START9_README.md`: IMAP
      variables; Gmail "enable IMAP" step; "Choosing a mail provider"
      (Gmail default, any password-auth SMTP+IMAP provider works, Proton
      needs Bridge, dedicated mailbox recommended, don't self-host mail).
- [x] `CLAUDE.md` invariants: code is the token; counts only outside
      quoted text and never from auto-replies; UID not UNSEEN; ntfy never
      load-bearing; armed switch never torn down by upgrade.

## 10. Upgrade path (startup, once, keyed by `settings.migrated_reply_codes`)
- [x] After recovery: for each armed switch, `issueCheckinEmail` (fresh
      code). For each beneficiary_pings row with ping_sent_at set and
      ack_at null, resend the ping with a code. Do not touch switches
      whose operator has no working IMAP beyond the red banner + alert.

## 11. Verification (all must pass before tag)
- [x] `npm test` green.
- [x] Sandbox E2E with `DEPLOY_TEST_HOOKS=1`, 1-min/5-min: deploy → inject
      arming reply → armed → first contact (code) → inject ben ack → inject
      check-in reply → silent → warning at missed=3 → CRITICAL. Assert no
      `http` link in any operator/beneficiary email except CRITICAL's
      external tool links.
- [x] Inject: wrong code ×5 → reissue; old code → "expired" receipt +
      fresh email; vacation reply (Auto-Submitted) with code only inside
      quote → ignored; reply from other address → receipt to original.
- [x] Restart mid-cycle; inject a reply after restart → processed once.
- [x] Fail-safe: simulate down_since across a warning tick → held + alert
      email; clear → resumes.
- [x] Live: real Gmail, phone off the LAN, Gmail app + Apple Mail +
      Outlook mobile, one arming and one check-in each.
- [ ] Release: push → make build → start-sdk pack → start-cli s9pk convert
      → verify layers (grep `inboundMail`, no `deadman/checkin/`) →
      sideload → tag → sign → release.

## Live pass record (2026-09-18/19, Eric's Gmail, Proton beneficiaries)

Two full cycles on a local server against the real account (shared
mailbox: Deploy sends from the operator's own Gmail). Second cycle at
3-min / 9-min after the fixes below: arming by reply, first contact →
Proton ack (HTML-only client), routine check-in by reply, reply to the
OLDER of two outstanding check-in emails accepted, pre-fire warning →
Proton warning-ack by reply, stand-down after a late check-in, CRITICAL
delivered 1/1 at the deadline, dying-gasp tick skipped, session closed,
post-fire replies answered "switch no longer running". Every code kind
has a live sample; every reply was processed on the IDLE push.

Found and fixed during the pass: (1) retire-on-issue turned a reply that
crossed a tick into "expired" and fired the switch on a living operator —
outstanding operator codes now stay live until a check-in; (2) a push
arriving mid-sync was dropped; (3) a push-woken sync compared the cursor
against ImapFlow's stale uidNext and skipped INBOX; (4) the recipient
status line refreshed at most once a minute; (5) the dashboard check-in
button was removed at Eric's call. "Phone off the LAN" is moot for
reply-by-email: the reply never touches the server's address.

