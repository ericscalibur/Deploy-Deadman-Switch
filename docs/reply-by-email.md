# Check-in and acknowledgement by email reply — specification

Status: proposed (2026-09-18), revised same day after review. Target: v2.2.0.

## Problem

Every actionable link Deploy sends is built from `APP_URL`. The link only
works from wherever that address is reachable: the Tor onion on Start9, the
LAN (or only the machine itself, with the documented `localhost`) on a
laptop install. An operator away from home, or a beneficiary anywhere, may
have no way to click. Reachability is a deployment property Deploy cannot
control, and the operator will not be around to fix it when it matters.

The trigger (CRITICAL) email is already self-contained — ciphertext and QR
inline, decryption tools external — and needs no reachability. The gap is
proof of life from the operator, and address acknowledgement from
beneficiaries.

## Decision

Email is the one channel Deploy already requires and that works from
everywhere, in both directions. Make it the **only** remote path:

- Every actionable email carries a short **code**. The reader replies to
  the email with that code. That is the whole interaction.
- The "I'm Active" button, the check-in URL and the ack URL are removed
  from all emails. `APP_URL` no longer appears in any email; it is only
  where the dashboard lives.
- The operator's fallback when email is broken is the dashboard's own
  "Check in now" button, reachable at home (LAN / onion). Nothing else.

One path for remote users, one for the operator at home. No "or".

## The code

- 8 characters from a 32-symbol alphabet with no look-alikes
  (`23456789ABCDEFGHJKMNPQRSTVWXYZ` — no 0/O, 1/I/L): 40 bits.
- Displayed as `K7M4-P2XQ`; accepted case-insensitively, hyphen optional,
  surrounding whitespace ignored.
- The code **is** the token. Stored only as `sha256(code)` with kind
  (checkin / arming / ping-ack / warning-ack), operator id, recipient
  address, created_at, used_at, failed_attempts. This absorbs the
  "persist check-in tokens (hashed)" roadmap item; nothing lives in memory.
- Exactly one live code per (operator, kind, recipient) for the
  beneficiary kinds; issuing a new ping or warning retires the previous.
- **Amended 2026-09-18 after the live pass:** check-in and arming codes
  are NOT retired when a newer one is issued. Every outstanding code stays
  live (at most five; the oldest beyond that is retired) until a check-in
  succeeds by any means, which retires them all, or the switch stops.
  Retiring on issue turned any reply that crossed a check-in tick into
  "expired": the operator answered the older of two emails seconds after
  the newer one went out, the reissue it triggered retired the newer one
  too, and the switch fired on a living operator who had replied three
  times. All outstanding codes went to the same inbox for the same
  purpose, so keeping them live is no weaker.
- After 5 wrong codes against a live code, it is retired and a fresh
  email is issued (limits brute force to 5 × 2^-40 per email).

## Threat model — what must hold

Today: whoever can read the email can act on it. Reply-with-code must be
no weaker, and must not let anything other than a living human keep the
switch alive:

1. **Auto-responders.** Vacation / out-of-office replies come from the
   operator's address and, from some systems (helpdesks), quote the
   original — code included. A dead operator's mailbox could answer every
   check-in. *Mitigation:* the code counts only when found **outside
   quoted material**, and any message carrying an auto-reply marker is
   discarded outright (`Auto-Submitted` other than `no`, `X-Autoreply`,
   `X-Autorespond`, `X-Auto-Response-Suppress`, `Precedence:
   bulk|auto_reply|junk|list`, `List-Id`). Both conditions, always.
2. **Replay.** Only the live code is accepted; a used or retired code is
   answered with a fresh email and nothing else changes.
3. **Forgery.** Anyone can put an address in `From`. The code is the
   secret; `From` must additionally equal the address Deploy wrote to
   (case-insensitive; filters stray forwards). DKIM verification of the
   inbound message is a later hardening, not v1.
4. **Bounces** (`mailer-daemon`, empty `Return-Path`) are never replies.
5. **False fire.** If Deploy cannot read mail, a living operator cannot
   check in remotely. *Mitigations:* IMAP is verified before a switch can
   be deployed (as SMTP is today); the dashboard check-in is unaffected;
   Deploy never fires on the strength of "no reply" while it knows its own
   inbox is unreadable — see "Fail-safe". Alerting is by **email first**:
   an IMAP failure rarely coincides with an SMTP failure, so Deploy mails
   the operator ("your replies are not being received — check in from the
   dashboard and fix the mail settings"), repeats daily while it persists,
   and shows a red banner on the dashboard. ntfy, when configured,
   repeats the same alert. Nothing in the protocol depends on ntfy.
6. **Mailbox scope.** Deploy gains IMAP read on its sending account. It
   searches only for unseen mail addressed to it, reads only messages
   containing a code pattern, never moves or deletes anything. Stated in
   the config UI.

## Quoted-text detection

The parser works on the plain-text part when present, else HTML converted
to text with `<blockquote>` and `.gmail_quote` / `#divRplyFwdMsg` /
`.yahoo_quoted` subtrees removed first. Then, top-down, everything from
the first quote marker onward is discarded:

- a line beginning with `>`
- `On … wrote:` (Gmail, Apple Mail; multi-line variants)
- `-----Original Message-----` / `________________________________`
  (Outlook)
- `From: …` immediately followed by `Sent:`/`Date:` and `To:` lines
- `Le … a écrit :`, `Am … schrieb …`, `El … escribió:` (localised
  Gmail/Apple headers — the alphabet is fixed, the language is not)

The code is searched only in what remains. Fixture tests cover Gmail web,
Gmail iOS/Android, Outlook desktop/web/mobile, Apple Mail, Thunderbird,
Proton web; top-posted, bottom-posted, inline, quote-stripped; a vacation
reply; a helpdesk auto-ack that quotes the original; a forward; the code
only inside the quote; the code with/without hyphen and in lower case.

## Fail-safe

`registerMissedCheckin()` gains one guard: if the inbound mail connection
has been down continuously since before the last check-in email was sent,
the miss is still counted (the operator has other duties) **but** the
pre-fire warning and the fire are held while the outage persists, with a
daily alert email (and ntfy if configured). When the connection recovers,
the backlog is processed before any timer decision. This trades a delayed
fire for never firing on a living operator whose replies Deploy could not
read. The hold is capped at 7 days, after which normal timing resumes and
the alert says so — an outage that long is the operator's problem to have
noticed. ntfy is never load-bearing: every alert in Deploy goes by email
first and by ntfy only in addition.

## Processing

- `performCheckin(codeHash, { via })` — extracted from today's
  `GET /checkin/:token` handler: pending→armed, `resetEscalationState`,
  timer resets, first contact on arming, code retirement. The dashboard
  button and the poller both call it. The HTTP route is removed.
- `performAck(codeHash)` — extracted from `GET /ack/:token` (ping-ack and
  warning-ack branches). Route removed.

Poller (`utils/inboundMail.js`): `imapflow` + `mailparser`. Connect to
the routine sending mailbox; `IDLE` where supported, else poll every 60 s;
full resync on reconnect. **Track by UID, never by read state**: when
Deploy sends from the operator's own account, the reply lands in the
operator's own inbox and they will read it on their phone before Deploy
polls — an `UNSEEN` search would silently miss real check-ins. Persist
last UID + UIDVALIDITY per folder in `settings`. Read `INBOX` and the
spam folder (`[Gmail]/Spam` on Gmail) — a beneficiary's first-ever
message to Deploy's address can land there. Per new message: discard
bounces/auto-replies → extract the code from the subject or from the
body outside quotes → hash → look up live code → `From` must match →
`performCheckin` / `performAck`. Wrong code: increment `failed_attempts`;
on the 5th retire and reissue. Reissues (for any reason) are limited to
one per hour per operator so a spoofed `From` cannot be used to flood the
operator with fresh check-ins. No code found: ignore silently (never
answer unrecognised mail — that is how auto-reply loops start). Never
moves or deletes mail.

Recommend a **dedicated mailbox** for Deploy in the docs (not required):
it removes the read-state collision above entirely, keeps Deploy out of
the operator's personal mail, and means a leaked app password exposes
nothing personal.

## UX

Every check-in email has a distinct subject ("Deploy check-in — 18 Sep
2026") so Gmail does not stack them into one conversation showing several
codes at once.

Check-in email (also the arming check-in):

> **To confirm you are alive, reply to this email with this code:**
> `K7M4-P2XQ`
> Nothing else is needed. The reply can come from any phone or computer.

Arming is therefore the dry run it was meant to be: it proves the whole
round trip — Deploy can send, the operator receives, Deploy can read the
answer — before anything is allowed to fire.

First contact / annual ping / pre-fire warning:

> **To confirm this address works, reply to this email with this code:**
> `R8TF-3NQW`

Receipts, all one line, all at most once per live code:

- correct code → "Check-in received at 14:02 UTC — next check-in due
  <date>" (operator) / "Confirmed — thank you. Nothing has been sent or
  triggered and nothing else is needed." (beneficiary — replaces today's
  ack page, or a nervous beneficiary sends the code twice)
- used or retired code → "That code has expired — a fresh check-in email
  is on its way."
- wrong code → "That code didn't match."
- code correct but `From` does not match → to the **original** address:
  "A reply with your code arrived from <other address> and was not
  accepted. Reply from <original address>, or check in from the
  dashboard." Silence here would let the operator believe they checked
  in when they had not.
- anything else → silence.

Dashboard: "Email replies: connected — last checked 14:02 UTC" (or "not
configured" / red banner "error: … — remote check-ins are NOT working;
use this button"). Each check-in records `via: reply | dashboard`.

## Configuration

Env: `IMAP_HOST`, `IMAP_PORT` (993), `IMAP_SECURE` (true), `IMAP_USER`,
`IMAP_PASS`. With `EMAIL_PROVIDER=gmail` and no explicit IMAP settings,
derive `imap.gmail.com:993` with the same app password (Gmail: IMAP must
be enabled in Settings → Forwarding and POP/IMAP — document with a
screenshot). Deploy refuses `/activate` until the IMAP login has been
verified, with a clear message.

Start9 configurator: IMAP host/port/user/password fields for the custom
SMTP provider; Gmail derives them. Description states the mailbox-access
scope. `app_url` description rewritten: "Where your dashboard lives.
Emails no longer contain links."

`.env` / Windows docs: same variables; `APP_URL=http://localhost:3000` is
now fine for a laptop install because emails never use it.

## Removed

- `GET /deadman/checkin/:token`, `GET /deadman/ack/:token`, the in-memory
  `checkinTokens` / `usedCheckinTokens` maps, `warningAckToken`,
  `beneficiary_pings.ping_token` (replaced by `code_hash`), the "I'm
  Active" button, all `${APP_URL}/deadman/…` URLs, the Tor-Browser copy
  in beneficiary emails (`torNotice`).
- Upgrade path, in order: (a) every outstanding link token is retired;
  (b) each armed switch gets a fresh check-in email carrying a code on
  first start; (c) each beneficiary ping that was sent but never
  acknowledged is re-sent with a code — otherwise its dead link would age
  into a false "address may be dead" alert; (d) an armed switch whose
  operator has no working IMAP (custom SMTP without IMAP settings) keeps
  running untouched: the dashboard goes red and the alert email goes out,
  but an armed switch is never torn down by an upgrade.

## Out of scope for v1

- DKIM/SPF verification of inbound mail (`mailauth`).
- Treating bounced beneficiary pings as dead-address evidence.
- Proton Mail (no IMAP without Bridge) — documented as unsupported.

## Effort

Roughly 3 days: code generation + hashed persistence + migration (½),
parser + fixtures (½), handler refactor + route removal (½), poller +
state + fail-safe (1), config / IMAP verify / docs (½), dashboard status +
sandbox test hook (`POST /internal/test/inbound`, only with
`DEPLOY_TEST_HOOKS=1`) (½). Plus one live pass against a real Gmail
account from a phone off the LAN before release.

## Test plan

- Unit: parser fixtures; alphabet/normalisation; lockout after 5.
- Sandbox E2E (compressed timers): deploy → arming code by injected reply
  → armed; check-in by reply; wrong code ×5 → reissue; old code → fresh
  email; vacation-style reply (auto-submitted, no code outside quote) →
  ignored, switch fires on schedule; beneficiary ack by reply; opted-out
  recipient untouched.
- Restart mid-cycle: a reply arriving during the restart is processed once
  afterwards (UID tracking).
- Fail-safe: IMAP down across a warning tick → warning held, ntfy sent;
  IMAP back → backlog processed, warning stands down if a code arrived.
- Live: Gmail, phone off the LAN, reply from Gmail app, Apple Mail and
  Outlook mobile.
