# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A **dead man's switch** web application — if a user fails to check in within a configured time window, pre-written emails are automatically sent to designated recipients. Built for self-hosting, with a primary deployment target of [Start9](https://start9.com/) (a personal server OS).

## Commands

```bash
# Generate SECRET_KEY and other env secrets
python3 generate_secret.py

# Run the server (requires .env to be configured)
node server.js

# Run tests
npm test

# Sandbox end-to-end (SMTP sink + DEPLOY_TEST_HOOKS=1, ~6 min): full loop or fail-safe
node tests/tools/sandbox-e2e.js full
node tests/tools/sandbox-e2e.js failsafe

# Build Start9 package
make build

# Build + run Docker container for local dev
make dev-build && make dev-run

# Debug active switch state (browser console or curl while logged in)
fetch('/deadman/debug/status').then(r=>r.json()).then(console.log)
```

## Environment Setup

Copy `.env` and set these variables:
- `SECRET_KEY` — base64-encoded 32-byte key for JWT signing (generate with `generate_secret.py`)
- `EMAIL_USER` / `EMAIL_PASS` — Gmail credentials (use an App Password, not account password)
- `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` / `IMAP_USER` / `IMAP_PASS` — where Deploy reads the replies to its own emails (v2.2.0). Derived from the Gmail credentials (`imap.gmail.com:993`) when unset; Gmail must have IMAP enabled. `REPLY_BY_EMAIL=false` disables reading (dashboard-only; activation refuses). `DEPLOY_TEST_HOOKS=1` enables `POST /internal/test/inbound` and lets `/activate` proceed without IMAP — sandbox only.
- If no email is configured, the server falls back to [Ethereal](https://ethereal.email/) test accounts (emails are not actually delivered)

## Architecture

```
server.js                  # Express entry point; HTTPS/HTTP, security headers, mounts /deadman
routes/
  deadman.js               # All routes: auth, switch lifecycle, check-in, debug (~2500 lines)
database/
  init.js                  # SQLite schema creation
  userService.js           # All DB reads/writes; stores data encrypted
  crypto.js                # AES-256-GCM encryption, PBKDF2 key derivation, token generation
utils/
  timeUtils.js             # Pure functions: ms↔interval conversion and validation
  emailService.js          # Nodemailer wrapper; Gmail SMTP or custom SMTP; optional dedicated trigger sender
  escalation.js            # Pure decision logic: pre-fire warning + annual liveness ping timing
  notify.js                # Out-of-band operator alerts via ntfy (NTFY_TOPIC unset → disabled)
  codes.js                 # Reply codes (v2.2.0): alphabet, generation, normalisation, sha256
  inboundParser.js         # Pure reply parsing: auto-reply/bounce gates, quote removal, code extraction
  inboundMail.js           # IMAP reader: UID cursor per folder, IDLE/poll, down_since tracking
public/                    # Vanilla JS/HTML/CSS frontend (no build step)
tests/
  timeUtils.test.js        # Unit tests for time utilities
  crypto.test.js           # Unit tests for crypto operations
  codes.test.js            # Reply-code alphabet / normalisation
  inboundParser.test.js    # Parser against tests/fixtures/inbound/*.eml (one per mail client)
  replyCodes.test.js       # reply_codes persistence against a temp SQLite file
  tools/                   # smtp-sink.js + sandbox-e2e.js (not run by npm test)
start9/                    # Packaging scripts for Start9 OS deployment
```

### Key Design Decisions

- **All user data is encrypted at rest** using AES-256-GCM with a key derived from the user's password (PBKDF2, 100k iterations). The database stores ciphertext — the server cannot read user data without the user's password.
- **Timer recovery on restart**: `deadman.js` queries the DB on startup and re-arms any active switches, recalculating remaining time from stored timestamps.
- **Large timeout handling**: JavaScript's `setTimeout` overflows at ~24.8 days. The code uses `setInterval`-based polling for timeouts beyond that threshold.
- **Single-use reply codes (v2.2.0; supersedes single-use check-in tokens)**: each check-in email contains a unique 8-character code; replying with it resets the timer and marks the code used. The code IS the token — stored only as `sha256(code)` in `reply_codes` with kind (arming / checkin / ping-ack / warning-ack), user, `recipient_hash`, `ref`; exactly one live code per (user, kind[, ref][, recipient]); issuing a new one retires the previous; five wrong guesses retire it and reissue. Nothing token-like lives in memory, so codes survive restarts. `GET /checkin/:token` and `GET /ack/:token` no longer exist; no email contains `APP_URL`.
- **Reply-by-email invariants (v2.2.0)** — `docs/reply-by-email.md` is the spec:
  - A code counts **only outside quoted text** (`utils/inboundParser.js` drops `>`-prefixed lines in place and cuts everything below an unprefixed quote marker or Outlook header block; HTML-only mail is cut at the first quote container) **and never from an auto-reply** (`Auto-Submitted` ≠ `no`, `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress`, `Precedence` bulk/auto_reply/junk/list, `List-Id`) or bounce. Both rules, always — a dead operator's vacation responder that quotes the original must not keep the switch alive.
  - `From` must hash to the `recipient_hash` the code was sent to; a right code from the wrong address is rejected and the ORIGINAL address is told once. Unrecognised mail is never answered (that is how auto-reply loops start). Receipts go out at most once per code per type. Inbound-triggered reissues are limited to one per hour per operator (`REISSUE_MIN_GAP_MS`).
  - The IMAP reader tracks **by UID, never by read state** (`imap:<folder>:lastuid` + `uidvalidity` in `settings`); a shared mailbox where the operator reads the reply first still counts. It reads INBOX + the spam folder, downloads bodies only past the header gates, and **never moves, deletes or flags mail**. Every outgoing message is stamped `X-Deploy-Deadman: 1` (dropped on the way in, so Deploy cannot check itself in from a shared inbox) and routine mail `Auto-Submitted: auto-generated`.
  - **ntfy is never load-bearing**: every alert goes by email first (`sendInboundDownAlert`, daily while the condition persists) and by ntfy only in addition.
  - **Fail-safe**: while `imap:down_since` is set, the outage began before the last check-in email went out, and it is younger than 7 days, misses are still counted but the pre-fire warning is skipped and the fire is re-checked every 10 minutes (`inboundHold()`); recovery clears `down_since` only after the backlog is processed. An install with no IMAP configured at all is never held — red banner + alert email only — so **an armed switch is never torn down or frozen by an upgrade**. `/activate` refuses until IMAP has been verified (like SMTP), except with `DEPLOY_TEST_HOOKS=1`.
  - The inbound reader starts only after restart recovery has re-armed every switch, or a reply that arrived during the restart would find no switch. `performCheckin(userEmail, switchData, {via})` is the one check-in implementation (poller: `reply`; `POST /checkin`: `dashboard`); `performAck(codeRow)` the one ack implementation.
- **Auth tokens**: JWTs expire in 24h and are stored in HTTP-only cookies. All `/deadman/*` routes except signup/login (and the unauthenticated `/debug/status`) require a valid JWT cookie.
- **Beneficiary escalation (v2.0.0)**: after `WARNING_MISSED_CHECKINS` consecutive check-in intervals of operator silence (default 5), recipients get a pre-fire warning carrying a reply code (kind `warning-ack`, one per recipient per session); unacknowledged warnings re-send each interval with a fresh code. A daily sweep sends annual liveness pings to recipients (addresses stored only as SHA-256 hashes in `beneficiary_pings`) and alerts the operator when a ping goes unanswered past the grace window. Escalation state lives in `deadman_sessions` columns and survives restarts.
- **Trigger email carries the payload, not the manual**: the encrypted payload (and its QR) ride in the email itself, but decryption instructions are links to the Legacy site — the decrypt page, the downloadable offline copy, and the full reimplementation spec in FAQ item 10 of the Legacy_Encryption repo (the former `utils/recoverySpec.js` content moved there in v2.0.10). It sends from a dedicated sender when `TRIGGER_EMAIL_*`/`TRIGGER_SMTP_*` are configured, with the subject prefixed `CRITICAL:` — subjects use plain severity words, never emoji.

- **Arming requires the first check-in (v2.1.0)**: activation puts the switch in a PENDING state — the arming check-in email is sent immediately, but no countdown exists until the operator replies with its code, proving the whole round trip (Deploy can send, the operator receives, Deploy can read the answer) end to end. Pending switches cannot fire or escalate, re-send the arming email every check-in interval, and survive restarts (persisted as an active session with `expires_at IS NULL`). `performCheckin()`'s timer rebuild doubles as the pending→armed transition (the dashboard button arms too, with a UI warning that it skips the email dry run).
- **Recipient edits are live on an armed switch (v2.0.11, surfaced in
  v2.1.1)**: `syncActiveSwitchRecipients()` updates every place the fire
  paths read — the `userEmails` map, `switchData.settings.emails`, and the
  SECRET_KEY-encrypted envelope that post-restart recovery fires from. Fire
  paths read `userEmails.get(userEmail)` at fire time, never a closure
  snapshot. `/timer-status` returns `armedRecipients` from the same source
  and the recipient table is the delivery list — no separate panel restates
  it.
- **Beneficiaries are contacted on ARMING, never on deploy (v2.1.7)**:
  deploying only creates a PENDING switch, which may never arm. Three paths
  could reach a beneficiary before that: the activation handler, a recipient
  edit via `syncActiveSwitchRecipients()`, and `runBeneficiaryPingSweep()`
  (whose query is `is_active = 1`, and a pending session is active with
  `expires_at IS NULL`). All three are now gated; first contact fires from
  the `wasPending` branch in `performCheckin()`. Any new ping path must
  respect the same rule — contacting a third party cannot be undone.
- **Per-recipient address confirmation (v2.1.1)**: `contactChecks` on the
  email record (default on; only an explicit `false` disables). It lives on
  the email object rather than in a settings table so it travels inside the
  SECRET_KEY-encrypted envelope and is therefore available to the daily sweep
  after a restart, with no schema change. Opting out suppresses ALL contact
  before the trigger — the first-contact/confirmation ping AND the pre-fire
  warning (v2.1.9; the editor copy promises "no contact with the beneficiary
  prior to the deadman switch trigger", and the code honours that literally).
  `executeDeadmanActivation` ignores the flag entirely: the CRITICAL email
  always goes to every recipient.
- **Warning threshold is clamped to the deadline (v2.1.9)**:
  `effectiveWarningThreshold()` caps `WARNING_MISSED_CHECKINS` at the number
  of check-in ticks that fit inside the inactivity period (minus one for a
  resend). Never below 2 (v2.1.10): "missed" is counted at the tick that
  SENDS a check-in email, so missed=1 means the first email just went out —
  warning there told beneficiaries the operator had "stopped responding"
  minutes after a routine check-in arrived (Dale, 1-day/2-day config). With
  an inactivity period ≤ 2× the check-in interval no warning is possible;
  `warningPossible()` makes `/activate` say so in its confirmation message.
- **Interval validation must match the parsers (v2.1.9)**: `getIntervalMs`
  / `getInactivityMs` fall back to a default on out-of-range input instead
  of throwing. `validateTimeInterval` therefore enforces the same ceilings
  (check-in ≤ 4 weeks, inactivity ≤ 365 days) and the dashboard clamps the
  inputs. Before this, "6-weeks" check-ins silently ran every 2 hours and
  "52-weeks"/"365-days" inactivity silently became 1 day.
- **Fire state is persisted (v2.1.9)**: `deadman_sessions.triggered_at` +
  `triggered_emails_sent` are set on delivery; `/deadman-status` falls back
  to them when memory is empty, `/reset` and a fresh `/activate` clear them.
- **Beneficiary contact passes are serialized per operator (v2.1.1)**:
  `pingAction()` is idempotent only against *committed* state — it returns
  "send" whenever the `beneficiary_pings` row is absent, and that row is not
  written until the send resolves. Overlapping passes (two quick recipient
  edits, or an edit during the daily sweep) therefore all read "never
  contacted" and all send. `queueBeneficiaryPings()` chains passes per
  userId; call it, never `processBeneficiaryPings()` directly.
- **Out-of-band alerting (v2.1.0)**: `utils/notify.js` pushes to an ntfy topic (config field or `NTFY_TOPIC`/`NTFY_SERVER` env; unset = disabled) so failures reach the operator on a path independent of email and Tor: SMTP down/recovered, check-in send failures, missed check-ins (≥2), pre-fire warning, fire + delivery failures, save failures, dead beneficiary addresses. Repeats are throttled per issue key.

### Email Flow

1. User activates switch → switch is PENDING; the first check-in email (with a code) is sent immediately
2. User replies with the code → the IMAP reader hands it to `performCheckin()` → switch ARMS, countdown starts (later replies reset the timer; each check-in email carries a fresh code and retires the previous one)
3. If timer expires without check-in → trigger emails sent to all configured recipients (held for up to 7 days only while Deploy knows its own inbox is unreadable)

### Start9 Deployment

The `start9/` directory contains the packaging layer for running this as a Start9 service. `Makefile` targets (`make build`, `make install`) handle building the `.s9pk` package. `start9/manifest.yaml` defines the service metadata, ports, and health checks.
