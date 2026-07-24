# Roadmap

Working list of what's staged for the next release and what's on the
horizon. Items in "Staged" are already merged on `main` and ship
automatically with the next version bump.

## Staged for next release (v1.0.41)

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
