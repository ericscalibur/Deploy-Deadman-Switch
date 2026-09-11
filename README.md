# Deploy: Deadman Switch

A secure, web-based deadman switch service that automatically sends pre-configured emails to designated recipients if you fail to check in within a specified time period.

## Features

- 🔒 **Secure Authentication** - JWT-based user authentication with password hashing
- 📧 **Email Integration** - Supports Gmail SMTP and custom SMTP servers
- ⏰ **Flexible Timers** - Configurable check-in intervals and inactivity periods
- 🔗 **One-Click Check-ins** - Simple email links to reset the deadman timer
- 📱 **Real-time Dashboard** - Live countdown timers and status monitoring
- 🧹 **Complete Data Lifecycle** - Automatic cleanup after activation
- ⚙️ **Flexible Intervals** - Configurable check-in and deadman timer periods
- 🔶 **Pre-Fire Warning** - Recipients get ~30 days' human-readable notice
  (with acknowledgment link) after repeated missed check-ins, before the
  switch fires
- 📮 **Recipient Liveness Pings** - Annual one-click address verification for
  every recipient; you are alerted while you're still around to fix a dead
  address
- ✉️ **Deliverability-Hardened Trigger** - Plain-word severity subjects (no
  emoji), optional dedicated sender address for the trigger email, and a
  self-contained recovery spec inside the trigger email itself

## How It Works

1. **Configure**: Set up your check-in frequency and inactivity timeout
2. **Add Recipients**: Configure emails to be sent if deadman activates  
3. **Activate**: Start the deadman switch with real-time monitoring
4. **Check-in**: Click links in periodic check-in emails to stay active
5. **Automatic Trigger**: If you don't check in, recipient emails are sent automatically

### Arming requires the first check-in

Deploying does not start the countdown. The switch goes to **PENDING** and
sends you a check-in email straight away; clicking that link is what arms it.
This is deliberate — it proves the whole loop (mail delivery, link
reachability, token handling) end to end before anything is allowed to fire.
A pending switch cannot fire and cannot escalate to your recipients.

### Changing recipients while the switch is armed

Adding, editing, and deleting recipients all take effect on an armed switch
**immediately**, including after a restart. You do not need to disarm and
re-arm to change who receives your messages.

The recipient table is the delivery list — an address listed there is one
that will be sent to, and a deleted one stops. Each row shows, underneath the
address, whether that recipient has confirmed their address.

One guardrail: you cannot delete your *last* remaining recipient while the
switch is armed. A switch with nobody to notify should not be armed at all —
disarm it first.

### Address confirmation (per recipient)

Deploy asks each recipient to confirm their address with a one-click link —
once when the switch is armed, and once a year after that. Their click is the
only real proof the address still reaches a living person; a domain that
resolves today proves nothing about six years from now. If a recipient stops
answering, you are alerted while you are still around to fix it.

The confirmation email says only that you have listed them and that a message
may come someday. It never reveals your message, your payload, or why.

It is **on by default and should usually stay on**, but it can be turned off
per recipient in that recipient's message editor — for the case where someone
must learn nothing until the message arrives. Turning it off means that
address is never verified: if it quietly dies, you will not find out.

Turning it off does **not** affect delivery. An opted-out recipient still
receives your message when the switch fires. It also does not suppress the
pre-fire warning, which only goes out after months of operator silence.

### While the computer is switched off

Deploy only runs while its host computer is running. That has three
consequences worth understanding before you rely on it:

- **Check-in emails are not stockpiled.** If the machine is off for two days,
  you do not receive two days of missed check-in emails when it comes back.
  Nothing is queued; the schedule simply resumes.
- **A deadline that passes while the machine is off is still honoured.**
  Deploy stores the deadline, not a running clock. On restart it compares the
  stored deadline against the real time — if the deadline passed while the
  machine was off, the switch fires within moments of the machine coming back
  up. Being switched off delays the trigger; it does not cancel it.
- **Being off is not a check-in.** Time spent powered down counts as silence,
  exactly like time spent ignoring check-in emails.

For a switch you actually depend on, run it on hardware that stays on — a
Start9 server or equivalent — rather than a laptop that sleeps.

## Quick Start

### Prerequisites
- Node.js (v16 or higher)
- Gmail account with App Password OR SMTP server access

### Installation

1. **Get the code** — download the latest release tarball from the
   [Releases page](https://github.com/ericscalibur/Deploy-Deadman-Switch/releases)
   (recommended), or clone the repository:
   ```bash
   git clone https://github.com/ericscalibur/Deploy-Deadman-Switch.git
   cd Deploy-Deadman-Switch
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure email settings** — create a `.env` file containing:
   ```env
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=your-app-password
   APP_URL=http://localhost:3000
   PORT=3000
   ```
   No `SECRET_KEY` is needed — one is generated automatically on first
   start and saved into `.env` for you.

4. **Start the server**
   ```bash
   npm start
   ```
   The first line printed is the running version, followed by database
   initialization.

5. **Open the application**
   Navigate to `http://localhost:3000`

**Windows users:** see [windows/WINDOWS_SETUP.md](windows/WINDOWS_SETUP.md)
for a step-by-step guide, including how to run the switch invisibly in the
background and start it automatically when the computer powers on.

## Configuration

### SECRET_KEY Setup
The `SECRET_KEY` signs login tokens and encrypts the data the switch needs
to recover and deliver after a server restart.

**You normally don't need to do anything** — if no `SECRET_KEY` is set, the
server generates one on first start and saves it into `.env`. To set one
yourself instead, any of these work (base64, hex, or a passphrase are all
accepted):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
or run `python3 generate_secret.py`, which also writes a `.env` template.

**Important:**
- Never share or commit your `SECRET_KEY` to version control.
- **Never change the key while a switch is armed** — timers and the
  restart-recovery data are encrypted with it, and a changed key makes them
  unrecoverable until you log in and re-arm.

### Email Setup (Gmail)
1. Enable 2-factor authentication on your Google account
2. Generate an App Password: Google Account → Security → App Passwords
3. Use your Gmail address as `EMAIL_USER` and the app password as `EMAIL_PASS`

### Custom SMTP Setup
```env
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
```

### Timer Configuration
- **Check-in Intervals**: 1 minute to 2 weeks
- **Deadman Timer**: 3 minutes to 9 months

### Beneficiary Escalation (v2.0.0)

If you keep missing check-ins, your recipients are warned by a human-readable
email *before* the switch fires — the last false-positive filter in a system
with no cancel path. Recipients also get a once-a-year address verification
email so a dead recipient address is discovered while you can still fix it.

All knobs are environment variables with sensible defaults:

```env
# Consecutive check-in intervals of silence before recipients are warned.
# Default 5 (with 2-week check-ins and a 3-month timer, the warning lands
# roughly 30 days before the switch fires).
WARNING_MISSED_CHECKINS=5

# Annual recipient address verification cadence and ack grace window.
PING_INTERVAL_DAYS=365
PING_ACK_GRACE_DAYS=30
```

The warning is a notification only — it contains no payload and no secrets.
It carries an acknowledgment link; while unacknowledged it is re-sent every
check-in interval, and stops once acknowledged. If you check in after a
warning went out, recipients automatically get an "all clear".

### Dedicated Trigger Sender (optional, recommended)

Routine mail and the trigger email can come from different addresses, so
recipients can never habituate to (or filter) the sender that matters.
Configure a second account that has never sent anything else:

```env
TRIGGER_EMAIL_USER=trigger-account@gmail.com
TRIGGER_EMAIL_PASS=its-app-password
# or, custom SMTP:
TRIGGER_SMTP_HOST=smtp.other-provider.com
TRIGGER_SMTP_PORT=587
TRIGGER_SMTP_USER=...
TRIGGER_SMTP_PASS=...
```

If unset (or failing at fire time), the trigger falls back to the primary
sender — delivery always wins over sender hygiene.

## API Endpoints

### Authentication
- `POST /deadman/signup` - Create new user account
- `POST /deadman/login` - User login
- `POST /deadman/logout` - User logout

### Deadman Switch
- `POST /deadman/emails` - Configure recipient emails
- `GET /deadman/emails` - Retrieve configured emails
- `POST /deadman/activate` - Activate deadman switch
- `POST /deadman/deactivate` - Deactivate deadman switch
- `GET /deadman/timer-status` - Get current timer status (includes missed
  check-in count and warning state)
- `GET /deadman/checkin/:token` - Process check-in from email link
- `GET /deadman/ack/:token` - Recipient acknowledgment (pre-fire warning and
  annual address verification)

### Admin/Debug
- `GET /deadman/debug/status` - System status (requires login)

## Project Structure

```
Deploy/
├── server.js                 # Main server application
├── package.json              # Dependencies and scripts
├── generate_secret.py        # Optional .env template generator
├── .env                      # Environment configuration (excluded from git)
├── routes/
│   └── deadman.js            # Auth + deadman switch routes
├── database/
│   ├── init.js               # SQLite schema creation and migrations
│   ├── userService.js        # Encrypted database reads/writes
│   └── crypto.js             # AES-256-GCM encryption utilities
├── utils/
│   ├── emailService.js       # Email sending service
│   └── timeUtils.js          # Interval conversion and validation
├── public/                   # Web interface (HTML/JS/CSS, no build step)
├── tests/                    # Unit tests (npm test)
├── windows/                  # Windows launcher scripts + setup guide
└── start9/                   # Start9 server packaging
```

## Security Features

- **Password Hashing**: PBKDF2 with salt for secure password storage
- **JWT Authentication**: Secure token-based session management
- **Environment Variables**: Sensitive configuration kept in `.env` file
- **Data Isolation**: User data stored in separate files
- **Token Expiration**: Check-in tokens are single-use and cleaned up

## Development

### Browser Console Commands
Monitor backend state during development:
```javascript
// Check email count
fetch('/deadman/debug/status').then(r=>r.json()).then(d=>console.log('📊 Backend Email Count:', d.userEmailsCount))

// Full status
fetch('/deadman/debug/status').then(r=>r.json()).then(console.log)
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3) - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This software is provided as-is for educational and personal use. Users are responsible for:
- Securing their email credentials
- Testing the system before relying on it
- Understanding local laws regarding automated communications
- Maintaining backup communication methods

## Support

For issues, questions, or contributions:
- Open an issue on GitHub
- Check existing documentation
- Review the codebase for implementation details

---

**⚠️ Important**: Always test your deadman switch configuration thoroughly before relying on it for critical communications.
