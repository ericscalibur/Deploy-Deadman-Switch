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
  emailService.js          # Nodemailer wrapper; Gmail SMTP or custom SMTP
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
- **Auth tokens**: JWTs expire in 24h and are stored in HTTP-only cookies. All `/deadman/*` routes except signup/login/checkin require a valid JWT cookie.

### Email Flow

1. User activates switch → server schedules a check-in email at the configured interval
2. User clicks link in check-in email → timer resets, new check-in scheduled
3. If timer expires without check-in → trigger emails sent to all configured recipients

### Start9 Deployment

The `start9/` directory contains the packaging layer for running this as a Start9 service. `Makefile` targets (`make build`, `make install`) handle building the `.s9pk` package. `start9/manifest.yaml` defines the service metadata, ports, and health checks.
