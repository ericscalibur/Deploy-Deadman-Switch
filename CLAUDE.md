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
public/                    # Vanilla JS/HTML/CSS frontend (no build step)
tests/
  timeUtils.test.js        # Unit tests for time utilities
  crypto.test.js           # Unit tests for crypto operations
start9/                    # Packaging scripts for Start9 OS deployment
```

### Key Design Decisions

- **All user data is encrypted at rest** using AES-256-GCM with a key derived from the user's password (PBKDF2, 100k iterations). The database stores ciphertext — the server cannot read user data without the user's password.
- **Timer recovery on restart**: `deadman.js` queries the DB on startup and re-arms any active switches, recalculating remaining time from stored timestamps.
- **Large timeout handling**: JavaScript's `setTimeout` overflows at ~24.8 days. The code uses `setInterval`-based polling for timeouts beyond that threshold.
- **Single-use check-in tokens**: Each check-in email contains a unique token. Clicking it resets the timer and invalidates the token.
- **Auth tokens**: JWTs expire in 24h and are stored in HTTP-only cookies. All `/deadman/*` routes except signup/login/checkin/ack require a valid JWT cookie.
- **Beneficiary escalation (v2.0.0)**: after `WARNING_MISSED_CHECKINS` consecutive check-in intervals of operator silence (default 5), recipients get a pre-fire warning with an ack link (`/deadman/ack/:token`); unacknowledged warnings re-send each interval. A daily sweep sends annual liveness pings to recipients (addresses stored only as SHA-256 hashes in `beneficiary_pings`) and alerts the operator when a ping goes unanswered past the grace window. Escalation state lives in `deadman_sessions` columns and survives restarts.
- **Trigger email carries the payload, not the manual**: the encrypted payload (and its QR) ride in the email itself, but decryption instructions are links to the Legacy site — the decrypt page, the downloadable offline copy, and the full reimplementation spec in FAQ item 10 of the Legacy_Encryption repo (the former `utils/recoverySpec.js` content moved there in v2.0.10). It sends from a dedicated sender when `TRIGGER_EMAIL_*`/`TRIGGER_SMTP_*` are configured, with the subject prefixed `CRITICAL:` — subjects use plain severity words, never emoji.

- **Arming requires the first check-in (v2.1.0)**: activation puts the switch in a PENDING state — the arming check-in email is sent immediately, but no countdown exists until the operator clicks it, proving the whole loop (email delivery, link/Tor reachability, token handling) end to end. Pending switches cannot fire or escalate, re-send the arming email every check-in interval, and survive restarts (persisted as an active session with `expires_at IS NULL`). The `/checkin` handler's timer rebuild doubles as the pending→armed transition.
- **Recipient edits are live on an armed switch (v2.0.11, surfaced in
  v2.1.1)**: `syncActiveSwitchRecipients()` updates every place the fire
  paths read — the `userEmails` map, `switchData.settings.emails`, and the
  SECRET_KEY-encrypted envelope that post-restart recovery fires from. Fire
  paths read `userEmails.get(userEmail)` at fire time, never a closure
  snapshot. `/timer-status` returns `armedRecipients` from the same source
  and the recipient table is the delivery list — no separate panel restates
  it.
- **Per-recipient address confirmation (v2.1.1)**: `contactChecks` on the
  email record (default on; only an explicit `false` disables). It lives on
  the email object rather than in a settings table so it travels inside the
  SECRET_KEY-encrypted envelope and is therefore available to the daily sweep
  after a restart, with no schema change. Opting out suppresses ONLY the
  confirmation ping — `executeDeadmanActivation` and the pre-fire warning
  ignore the flag entirely. That boundary is deliberate: confirmation
  happens while the operator is alive, the pre-fire warning only after
  months of silence.
- **Beneficiary contact passes are serialized per operator (v2.1.1)**:
  `pingAction()` is idempotent only against *committed* state — it returns
  "send" whenever the `beneficiary_pings` row is absent, and that row is not
  written until the send resolves. Overlapping passes (two quick recipient
  edits, or an edit during the daily sweep) therefore all read "never
  contacted" and all send. `queueBeneficiaryPings()` chains passes per
  userId; call it, never `processBeneficiaryPings()` directly.
- **Out-of-band alerting (v2.1.0)**: `utils/notify.js` pushes to an ntfy topic (config field or `NTFY_TOPIC`/`NTFY_SERVER` env; unset = disabled) so failures reach the operator on a path independent of email and Tor: SMTP down/recovered, check-in send failures, missed check-ins (≥2), pre-fire warning, fire + delivery failures, save failures, dead beneficiary addresses. Repeats are throttled per issue key.

### Email Flow

1. User activates switch → switch is PENDING; the first check-in email is sent immediately
2. User clicks link in check-in email → switch ARMS, countdown starts (later clicks reset the timer and schedule the next check-in)
3. If timer expires without check-in → trigger emails sent to all configured recipients

### Start9 Deployment

The `start9/` directory contains the packaging layer for running this as a Start9 service. `Makefile` targets (`make build`, `make install`) handle building the `.s9pk` package. `start9/manifest.yaml` defines the service metadata, ports, and health checks.
