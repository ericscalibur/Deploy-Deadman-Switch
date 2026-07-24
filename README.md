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

## How It Works

1. **Configure**: Set up your check-in frequency and inactivity timeout
2. **Add Recipients**: Configure emails to be sent if deadman activates  
3. **Activate**: Start the deadman switch with real-time monitoring
4. **Check-in**: Click links in periodic check-in emails to stay active
5. **Automatic Trigger**: If you don't check in, recipient emails are sent automatically

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
- `GET /deadman/timer-status` - Get current timer status
- `GET /deadman/checkin/:token` - Process check-in from email link

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
