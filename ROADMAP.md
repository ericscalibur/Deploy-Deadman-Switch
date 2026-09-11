# Roadmap

Working list of what's staged for the next release and what's on the
horizon. Items in "Staged" are already merged on `main` and ship
automatically with the next version bump.

## Next up (post-v2.1.2)

- **Pre-deployment recipient subtext is premature**: before the switch is
  deployed, a saved recipient's row reads "Not yet confirmed by recipient".
  Nothing has been attempted yet, so that describes a pending action that
  does not exist — and it reads as a problem the operator should fix.
  Should read "Save and Deploy to send first contact emails" until
  activation, then switch to the contact states. `loadBeneficiaryStatus()`
  already renders the contact line; the missing input is whether a switch
  is active, which the dashboard knows from `/timer-status`.
- **Rework the address-confirmation explanation**: the paragraph under "Ask
  this recipient to confirm their address" in the message editor is not
  right yet. Operator rewriting it; current text is a placeholder.
- **Label displayed dates as UTC**: dates render a day ahead when viewed in
  the evening from the Americas. Not a conversion bug — storage is UTC,
  `parseDbTimestamp()` appends `Z`, and the ISO the server sends is correct.
  Tor Browser pins the page's timezone to UTC as anti-fingerprinting, so
  `toLocaleDateString()` renders UTC regardless of where the operator is.
  Detecting the real timezone is exactly what that defence prevents, so the
  fix is to stop implying local time: render "11 Sep 2026 (UTC)". Applies
  to every date in the UI — recipient contact dates and "Last activity",
  which is the more confusing one because the operator remembers when they
  last checked in. Observed 2026-09-10 from UTC-6.

- **Check whether the SeedSigner main-menu entry actually renders**: at
  `2e19bf4` the fork adds "Legacy Encryption" to BOTH the Tools menu
  (`tools_views.py`) and the main menu (`view.py`,
  `[SCAN, SEEDS, TOOLS, SETTINGS, LEGACY]`), but only the Tools path was
  observed on hardware 2026-09-11. Either the top-level entry is redundant
  and should be removed, or the main menu is not rendering its fifth button
  — worth knowing which before more people flash the published image. The
  trigger email documents the Tools path, which is confirmed working.
- **`INTEGRATION.md` menu instructions are wrong**: it tells the reader to
  wire the entry into `MainMenuView`, but the shipped firmware reaches it
  through Tools. Anyone following the guide to build their own image gets a
  different menu layout from the release.

- **Persist check-in tokens (hashed) in the DB**: tokens live in memory, so
  any restart invalidates every outstanding check-in/arming link until the
  next email goes out. Observed live 2026-09-03 (config save → restart →
  first arming email's link dead). On a monthly check-in interval a restart
  could orphan the operator's only valid link for weeks. Store token hashes
  server-side so links survive restarts; do before real keys.

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
