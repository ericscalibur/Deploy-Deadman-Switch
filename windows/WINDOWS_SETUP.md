# Running Deploy Deadman Switch on Windows

This guide sets up the Deadman Switch on a Windows computer so that it:

- starts automatically when the computer is turned on,
- runs invisibly in the background (no black command window),
- and keeps working **even if nobody logs into Windows** — so simply
  powering on the computer is enough for the switch to recover and, if the
  deadline has passed, deliver your messages.

That last point matters more than it may seem. This is a deadman switch: the
whole point is what happens when *you* are not there. If the switch only
starts after you personally log in, then in the exact situation it exists
for, it would never start. The steps below avoid that.

You do not need any programming experience. Every step says exactly what to
click or type.

## 1. Install Node.js (one time)

1. Go to https://nodejs.org and download the "LTS" version for Windows.
2. Run the installer and accept the defaults.
3. To confirm it worked: press the Windows key, type `powershell`, press
   Enter, then type `node --version` and press Enter. You should see a
   version number like `v20.x.x`.

## 2. Install the Deadman Switch (one time)

1. Download the latest `Deploy-vX.Y.Z.tar.gz` from the
   [Releases page](https://github.com/ericscalibur/Deploy-Deadman-Switch/releases)
   — always use the Releases page, not the green "Code" button.
2. Create a permanent folder for it, for example `C:\DeadmanSwitch`.
   Do not run it from the Downloads folder — Downloads tends to collect
   multiple copies and it is easy to end up running an old one.
3. Copy the downloaded file into `C:\DeadmanSwitch`, then in PowerShell:

   ```powershell
   cd C:\DeadmanSwitch
   tar -xzf Deploy-vX.Y.Z.tar.gz
   npm install
   ```

4. Create a file named `.env` in `C:\DeadmanSwitch` containing:

   ```
   EMAIL_USER=your-address@gmail.com
   EMAIL_PASS=your-16-character-app-password
   APP_URL=http://localhost:3000
   PORT=3000
   ```

   `EMAIL_PASS` is a Gmail **App Password** (Google Account → Security →
   App Passwords), not your normal Gmail password. You do not need to add a
   SECRET_KEY — the app creates one automatically the first time it runs
   and saves it into this file. Never delete or change the SECRET_KEY line
   once it appears: it protects the data the switch needs to recover after
   a restart.

5. Test it once by hand: in PowerShell type `npm start` and press Enter.
   The first line printed should be `Deploy Deadman Switch vX.Y.Z starting`.
   Open http://localhost:3000 in your browser and make sure the page loads.
   Then go back to the PowerShell window, press `Ctrl+C` to stop the
   server, and close the window.

## 3. Make it start automatically and invisibly

The `windows` folder of this project contains two small files:

- `Start-DeadmanSwitch.bat` — starts the server.
- `Start-DeadmanSwitch-Hidden.vbs` — starts the .bat with **no visible
  window**. Task Scheduler should point at this one.

Set up the scheduled task:

1. Press the Windows key, type `task scheduler`, press Enter.
2. In the right-hand panel click **Create Task…** (not "Create Basic Task").
3. **General tab:**
   - Name: `Deploy Deadman Switch`
   - Select **"Run whether user is logged on or not"**. This is the
     important one — it is what lets the switch start when the computer is
     powered on without anyone logging in.
   - Tick **"Run with highest privileges"**.
4. **Triggers tab:** click **New…**, set "Begin the task" to
   **"At startup"**, click OK.
5. **Actions tab:** click **New…**:
   - Program/script: `wscript.exe`
   - Add arguments (include the quotes):
     `"C:\DeadmanSwitch\windows\Start-DeadmanSwitch-Hidden.vbs"`
   - Click OK.
6. **Conditions tab:** untick **"Start the task only if the computer is on
   AC power"** (otherwise a laptop running on battery will not start it).
7. **Settings tab:** make sure **"Allow task to be run on demand"** is
   ticked, and untick **"Stop the task if it runs longer than"**.
8. Click OK. Windows will ask for your Windows password once — this is
   what allows the task to run without a login.

## 4. Confirm it works

1. Restart the computer. **Do not log in yet** if you want the full test —
   wait a minute or two at the login screen.
2. Log in, open a browser, and go to http://localhost:3000. The page should
   load, and if you had an active switch, its timers should be running.
3. There should be no black console window anywhere — the server runs
   invisibly. To confirm it is running: press `Ctrl+Shift+Esc` to open Task
   Manager and look for **Node.js** under background processes.

To stop the server manually: open Task Manager, find **Node.js JavaScript
Runtime**, right-click → End task. It will start again at the next boot.

## Important limits of a laptop setup

A laptop is a fine test platform, but keep two things in mind while a
switch is armed with real stakes:

- **The switch cannot fire while the computer is off.** If the deadline
  passes while the machine is off, delivery happens as soon as the machine
  is next powered on. Someone has to press the power button.
- **Sleep and hibernation also pause the switch.** In Settings → System →
  Power, set the computer to never sleep while plugged in, or the timers
  stop whenever the lid closes.

For a switch protecting something that matters, the long-term answer is an
always-on machine — a small home server such as a
[Start9](https://start9.com/) box, which this project supports natively.
