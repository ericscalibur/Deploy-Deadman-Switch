# Roadmap

Working list of what's staged for the next release and what's on the
horizon. Items in "Staged" are already merged on `main` and ship
automatically with the next version bump.

## Staged for next release (v2.0.0)

- **Beneficiary pre-fire warning** (Issue #1): after N consecutive missed
  check-in intervals (default 5), every recipient gets a plain-language
  warning — what this system is, that it fires in ~30 days, what to do.
  Counted on missed check-ins, not calendar dates; no key material.
- **Recipient acknowledgment + annual liveness ping** (Issue #2): the
  warning carries an ack link and re-sends each interval until
  acknowledged; every recipient address is verified annually with a
  one-click link, and the operator is alerted if a ping goes unanswered
  for 30 days — channel liveness proven on both ends, never assumed.
- **Subject-line severity coding, no emoji** (Issue #4): ROUTINE-tier
  subjects carry no urgency word, URGENT marks the pre-fire warning,
  CRITICAL is reserved for the trigger; optional dedicated trigger sender
  address (`TRIGGER_EMAIL_*` / `TRIGGER_SMTP_*`) so habituation can't
  attach to the sender that matters.
- **Self-contained trigger email** (Issue #5): the trigger now embeds
  recovery instructions and a plain-language specification of the Legacy
  encryption format (v1 and v2), sufficient to reimplement decryption
  from scratch — no dependency on GitHub, the tool running, or any 2026
  runtime. Project link demoted to a convenience.
- **Windows launcher kit** (`windows/`): `Start-DeadmanSwitch.bat`,
  `Start-DeadmanSwitch-Hidden.vbs`, and a plain-language
  `WINDOWS_SETUP.md` covering invisible background operation and a Task
  Scheduler configuration that starts the switch at power-on **without
  requiring a Windows login** — essential for the scenario a deadman
  switch exists for. (Approach contributed by community testing.)
- **README refresh**: Python no longer listed as a requirement (the
  SECRET_KEY auto-generates since v1.0.38 and accepts any encoding since
  then too), install steps point at the Releases page, corrected API
  endpoint paths and project structure, added a warning against rotating
  SECRET_KEY while a switch is armed.

## Open decisions

- **Second check-in channel** (Issue #3): a channel-independent way for the
  operator to check in and be alerted, so losing the email account alone
  can't fire the switch. Constraint A: genuinely independent failure mode
  (Telegram/WhatsApp/SMS all die with one phone). Constraint B: any channel
  that can warn the operator must also accept an "I'm here" response.
  Channel not yet selected — candidates to evaluate: Signal (signal-cli on
  the server, survives if phone number is recoverable), a second email
  account on a different provider checked from independent devices, Nostr
  DM (keypair-based, no phone dependency), SimpleX. Blocked on operator
  decision; software will follow the choice.

## Backlog (unscheduled)

- **`GET /deadman/emails` password in query string** — accepts the
  decryption password as a URL query parameter; migrate to POST body so
  the password can't land in logs/history. Deferred mid-testing-cycle to
  avoid changing API shape under an active tester.
- **Documentation phrasing pass** — write all user-facing instructions in
  concrete OS-specific terms ("in the PowerShell window, press Ctrl+C")
  rather than developer shorthand ("restart the server"). Windows guide
  already follows this; apply to README and in-app text.
- **Release credits** — consider a CREDITS section acknowledging
  community testers.

## Longer term

- First-class Start9 marketplace listing (currently sideload-only).
- In-app guidance for migrating a switch from a laptop install to an
  always-on server.
