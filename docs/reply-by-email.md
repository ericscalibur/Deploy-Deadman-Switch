# Reply-by-email check-ins and acknowledgements — specification

Status: proposed (2026-09-18). Target: v2.2.0.

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

## Principle

Email is the one channel Deploy already requires and that works from
everywhere, in both directions. Make it sufficient on its own: every
actionable email can be answered by **replying to it**. Links remain as the
fast path where they work.

## Threat model — what must not change

Today: whoever can read the email can act on it (the token is the link).
Reply-by-email must be no weaker than that, and specifically must not open
a way for the switch to be kept alive by something other than a living
operator:

1. **Auto-responders.** Vacation/out-of-office replies carry `In-Reply-To`
   and come from the operator's address. Gmail re-sends its vacation reply
   to the same sender every ~4 days; check-ins arrive every 1–4 weeks. A
   dead operator's mailbox would answer every check-in indefinitely.
   *Mitigation:* a reply counts only if it contains the required word
   (`ALIVE` for check-ins, `CONFIRM` for acks) on a line of its own, AND
   carries no auto-reply marker (`Auto-Submitted` other than `no`,
   `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress`,
   `Precedence: bulk|auto_reply|junk`, `List-Id`). Both conditions.
2. **Replay.** An old captured email must not work forever.
   *Mitigation:* only the currently outstanding token is accepted, exactly
   as with links. A reply to a stale email is answered with a fresh
   check-in email (see UX) and is otherwise ignored.
3. **Forgery.** Anyone can put the operator's address in `From`.
   *Mitigation:* the token is the secret, as today. `From` must additionally
   match the address the original was sent to (cheap filter against stray
   forwards). DKIM verification is a later hardening, not a v1 requirement.
4. **Bounces / delivery failures** (`mailer-daemon`, `Return-Path: <>`)
   are never treated as replies. (Future: treat a bounce of a beneficiary
   ping as evidence the address is dead — see "Later".)
5. **Scope of mailbox access.** Deploy gains IMAP read on the sending
   account. It reads only messages that reference its own Message-IDs or
   subject tag; it never reads, moves or deletes anything else. Document
   this plainly in the config UI.

## Matching a reply to a token — three keys, any one suffices

Outgoing actionable emails (check-in, arming check-in, first contact /
annual ping, pre-fire warning) get:

- `Message-ID: <dm-<kind>-<token>@deploy.local>` — replies carry it in
  `In-Reply-To` / `References` (RFC 5322; preserved by every mainstream
  client, independent of quoting).
- Subject suffix ` [DM-<first 12 hex of token>]` — survives clients that
  drop `References`; 48 bits is unguessable by mail.
- The full URL already in the body — quoted by most clients; a body scan
  for `/deadman/(checkin|ack)/<64 hex>` is the third key.
- `Reply-To` set explicitly to the routine sending address.

`parseInboundReply(raw) → { kind: "checkin"|"ack"|null, token|shortRef,
from, word: "ALIVE"|"CONFIRM"|null, autoReply: bool, bounce: bool }` is a
pure function with fixture tests (Gmail web, Gmail mobile, Outlook, Apple
Mail, Thunderbird; top-posted, bottom-posted, quote-stripped; vacation
reply; bounce; a forward; word missing; word inside quoted text only).

The required word must appear **outside** quoted material (lines not
starting with `>` and above the first `On … wrote:` / `-----Original
Message-----` marker) so the word in Deploy's own instructions never
satisfies the check.

## Processing

Refactor the existing handlers so the route and the poller share one path:

- `performCheckin(token, { via })` — extracted from `GET /checkin/:token`:
  pending→armed transition, `resetEscalationState`, timer resets, first
  contact on arming, used-token memory. Returns `{ ok, wasPending,
  alreadyUsed, unknown }`. The route renders HTML from it; the poller
  emails a receipt from it.
- `performAck(token)` — extracted from `GET /ack/:token` (both the
  beneficiary-ping and warning-ack branches).

Poller (`utils/inboundMail.js`):

- `imapflow` (nodemailer's sibling; IDLE + reconnect built in),
  `mailparser` for RFC822 parsing.
- Connect to the routine sending mailbox. Search
  `UNSEEN HEADER In-Reply-To dm-` OR `UNSEEN SUBJECT "[DM-"`. IDLE when the
  server supports it; poll every 60 s otherwise; full resync on reconnect.
- Persist last processed UID (+ UIDVALIDITY) per mailbox in `settings` so
  restarts neither miss nor reprocess. Additionally mark handled messages
  with the `$DeployHandled` keyword when the server allows custom flags.
- Per message: `parseInboundReply` → reject if bounce/auto-reply/no word
  → resolve short-ref to a token among outstanding tokens for that operator
  → `From` must equal the original recipient → `performCheckin` /
  `performAck`.
- Never deletes or moves mail. Marks `\Seen` only on messages it handled.
- On IMAP failure: `notifyThrottled` once ("reply-by-email is down; links
  still work"), retry with backoff. Never affects the fire path.

## UX

Check-in email gains, directly under the button:

> **No link access? Just reply to this email with the single word
> `ALIVE`.**

First contact / annual ping / pre-fire warning gain:

> **Or reply to this email with the single word `CONFIRM`.**

Receipts: a reply that registers a check-in gets a short confirmation
email ("Check-in received by reply at 14:02 UTC — next check-in due
<date>"). A reply to a stale or used check-in gets: "That check-in has
already been used / expired. A fresh check-in email is on its way — reply
`ALIVE` to that one." and a fresh check-in is sent immediately. A reply
with no recognised word gets nothing (silence is safer than teaching an
auto-responder loop).

Dashboard: "Reply-by-email: connected — last checked 14:02 UTC" (or "not
configured" / "error: …"). Last check-in shows "via link" / "via reply".

## Configuration

Env: `IMAP_HOST`, `IMAP_PORT` (993), `IMAP_SECURE` (true), `IMAP_USER`,
`IMAP_PASS`. With `EMAIL_PROVIDER=gmail` and no explicit IMAP settings,
derive `imap.gmail.com:993` with the same app password (IMAP must be
enabled in Gmail settings — document). `REPLY_BY_EMAIL=false` disables.

Start9 configurator: "Reply-by-email check-ins" toggle (default on) plus
IMAP host/port/user/password fields shown for the custom-SMTP provider;
Gmail derives them. Description states the mailbox-access scope.

Windows/.env docs: same variables; a paragraph explaining that with
`APP_URL=http://localhost:3000` links only work on that machine and
reply-by-email is how check-ins work from anywhere.

## Dependencies on other roadmap items

- **Persist check-in tokens (hashed)**: reply-by-email makes this more
  pressing, not less — a reply can arrive days after a restart. Do it in
  the same release. Store `sha256(token)`, kind, operator, created_at,
  used_at; outstanding = not used and newest per operator.

## Out of scope for v1

- DKIM/SPF verification of inbound replies (`mailauth`); v1 relies on the
  token secret, as links do.
- Treating bounced beneficiary pings as dead-address evidence.
- Proton Mail (no IMAP without Bridge) — document as unsupported for reply.

## Effort

Roughly 2–3 working days: headers + copy (½), parser + fixtures (½),
handler refactor (½), poller + state (1), config plumbing + docs (½),
dashboard status + sandbox test hook (`POST /internal/test/inbound`,
enabled only by `DEPLOY_TEST_HOOKS=1`) (½). Plus one live test against
a real Gmail account before release.

## Test plan

- Unit: parser fixtures above; short-ref resolution; auto-reply rejection.
- Sandbox E2E (compressed timers): arm via link; check in via injected
  reply; go silent → warning; beneficiary `CONFIRM` via injected reply;
  stale-token reply → fresh check-in sent; vacation-style reply → ignored,
  switch fires on schedule.
- Restart mid-cycle: reply arriving after restart is processed once.
- Live: Gmail account, reply from a phone off the LAN, all three keys
  exercised (normal reply; subject edited; quote stripped).
