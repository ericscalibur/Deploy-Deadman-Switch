# Roadmap

Working list of what's staged for the next release and what's on the
horizon. Items in "Staged" are already merged on `main` and ship
automatically with the next version bump.

## Shipped in v2.2.0

- **Check-in and acknowledgement by email reply** (spec in
  `docs/reply-by-email.md`, task list in `docs/reply-by-email-tasks.md`):
  every actionable link depended on
  `APP_URL` being reachable from wherever the reader is — the onion on
  Start9, only the LAN or the machine itself on a laptop. Replace links
  with a code: every check-in, first-contact and pre-fire email carries an
  8-character code, and the reader replies with it. The code is the token
  (hashed at rest, one live code per purpose, retired after 5 wrong
  attempts); it counts only outside quoted text and never from an
  auto-reply, which is what stops a dead operator's vacation responder
  from keeping the switch alive. Deploy reads its own sending mailbox over
  IMAP, verified before a switch can be deployed; the dashboard "Check in
  now" is the operator's at-home fallback. Buttons, links, `/checkin/:token`
  and `/ack/:token` are removed; emails no longer contain `APP_URL` at all.
  Absorbs the hashed-token item below.
- **Self-backup by email** (after v2.2.0; needs its IMAP): a wiped data
  volume — StartOS #3650 on a failed package update, a dead laptop disk, a
  VPS reprovision — silently deletes an armed switch, and Deploy cannot
  even report it because the mail credentials, ntfy topic and SECRET_KEY
  live in the same volume. Fix: after every change to user data
  (recipients, settings, arming, ping/ack state, fire) and at least daily,
  Deploy emails its own mailbox an encrypted snapshot of the SQLite
  database, encrypted with SECRET_KEY (already the at-rest key for the
  server-recoverable envelope). Subject `Deploy backup — <date UTC>`,
  attachment `deploy-backup-<ts>.enc`, sizes are tens of KB. Restore: on a
  fresh install the setup screen asks for the mail credentials and the
  SECRET_KEY; Deploy fetches the newest backup over IMAP, decrypts,
  restores, and resumes every countdown from the snapshot's timers.
  Requires the operator to keep SECRET_KEY offline — show it once at first
  setup with "write this down; it is the only way to restore", and repeat
  the reminder on the dashboard until acknowledged. Invisible to
  beneficiaries, one email a day at most to the operator's own account
  (recommend a Gmail filter/label in the docs). Same principle as
  reply-by-email: the one channel Deploy already requires is made
  sufficient — this time for the data, not the links.
- **Until self-backup ships (ops rule, document in START9_README.md)**:
  take a StartOS backup before sideloading any Deploy update; after the
  update, log in and confirm the switch is still armed and the onion
  address under Interfaces has not changed.
- **Persist check-in tokens (hashed) in the DB** — absorbed into the
  email-reply item above (the code is the token; stored hashed). Original
  motivation: tokens live in memory, so any restart invalidates every
  outstanding link until the next email goes out; observed live
  2026-09-03.

## Next up (post-v2.2.0)

- **DKIM/SPF verification of inbound replies** (`mailauth`) — the code is
  the secret and `From` must match today; signature checks are the next
  hardening.
- **Bounced beneficiary pings as dead-address evidence** — bounces are
  currently only ignored.

## Shipped in v2.1.4

- **Pre-deployment recipient subtext**: rows read "Save and Deploy to send
  first contact emails" until a switch exists, instead of "Not yet confirmed
  by recipient" — which described a pending action that had not been
  attempted and read as a fault. Ping states are checked first so a fired
  switch still shows its contact history. Forced repaint on activation so
  it updates immediately rather than at the next status refresh.
- **Dates labelled UTC**: `formatUtcDate()` / `formatUtcDateTime()` render
  every date in UTC with the zone named. Tor Browser pins the page timezone
  to UTC for anti-fingerprinting, so local time cannot be rendered and
  detecting the real zone is what that defence prevents. Verified under a
  UTC-forced browser context.
- **Address-confirmation copy rewritten** (operator's wording), with "see
  the template" expanding the actual first-contact email — subject and body
  taken from `sendBeneficiaryPing()`, so the operator judges what the
  beneficiary really receives rather than a description of it.
- **SeedSigner `INTEGRATION.md` step 4 corrected** and the `legacy-image`
  branch's main-menu entry removed (`792cbdd` in the seedsigner fork).
  `MainMenuScreen` extends `LargeButtonScreen`, a fixed 2×2 grid that raises
  on any count but 2 or 4, so the five-entry main menu booted to an error
  screen. Released images were never affected — `build.sh` patches
  `tools_views.py` only — but the doc prescribed exactly the breaking
  change, and it is what made the trigger email document the wrong path.

## Shipped in v2.1.1

- **Per-recipient address confirmation toggle** (tester report #2): `contactChecks`
  on the email record, edited in that recipient's message editor, default
  on. Per recipient because the trade-off is per recipient — a lawyer can
  be told they are listed; a family member you are leaving a secret to may
  need to learn nothing until the message arrives. Rides on the email
  object, so it flows through the SECRET_KEY envelope and works unchanged
  at activation, on edit, and after a restart — no migration. Opting out
  suppresses only the confirmation ping: delivery and the pre-fire warning
  are unaffected. Verified: opted-out recipient received no confirmation
  email and still received the trigger email when the switch fired.
- **Recipient table** (tester report #1/#5): rows show confirmation state per
  recipient. A separate "live recipient" panel was built and then removed —
  the table already *is* the delivery list, so restating it was redundant
  and would have been one more thing to keep in sync. Delivery correctness
  itself was verified end to end: added and deleted recipients while armed,
  fired, and delivery went to exactly the current list.
- **Welcome text corrected**: removed the claim that logging in logs
  activity. It does not — the `/login` handler never touches session
  activity or the timers, so only a check-in link resets the countdown.
- **Persistent ACTIVATION notice** (tester report #3): the fired-switch notice is
  now dismissed only by the operator, and the countdowns read ACTIVATED /
  CLOSED instead of resetting to 00:00:00. Dismissal is remembered against
  the activation timestamp, so a reload does not resurrect a notice already
  read, but a new activation always shows.
- **Duplicate first-contact emails fixed**: contact passes are serialized
  per operator. `pingAction()` is idempotent only against committed state,
  and the row is not written until the send resolves — so two recipient
  edits in quick succession, or an edit landing during the daily sweep,
  mailed the same beneficiary two or three copies. Found while testing
  the tester's report, not reported.
- **Pending-state dashboard label**: PENDING now reads "Click the link in
  the email you just received" instead of labelling a countdown that is
  not running.
- **Post-restart arming resend tone**: recovery resends the arming email
  with the normal subject; only interval reminders escalate to URGENT.
- **Offline/reboot behaviour documented** (tester report #4): check-in emails are
  not stockpiled while the host is off, a deadline that passes while it is
  off still fires on restart, and time powered down counts as silence.

## Shipped in v2.0.0

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
