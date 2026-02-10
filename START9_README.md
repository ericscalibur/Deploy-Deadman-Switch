# Deadman Switch for Start9

This directory contains all the necessary files to package the Deadman Switch application for Start9 servers.

## Quick Start

### Building the Package

1. **Install Prerequisites**
   ```bash
   # Docker (required for building)
   sudo apt install docker.io
   
   # ImageMagick (optional, for icon generation)
   sudo apt install imagemagick
   
   # Make (build system)
   sudo apt install make
   ```

2. **Build the Start9 Package**
   ```bash
   make build
   ```

3. **Validate the Package**
   ```bash
   make validate
   ```

4. **Install to Start9** (if you have start-cli)
   ```bash
   make install
   ```

### Manual Installation

If you don't have start-cli, you can manually install:

1. Build the package: `make build`
2. Copy the `build/` directory contents to your Start9 server
3. Use the Start9 web interface to install the local package

## Package Structure

```
Deploy/
├── start9/
│   ├── manifest.yaml          # Start9 service definition
│   ├── docker_entrypoint.sh   # Container startup script
│   ├── configurator.sh        # Configuration management
│   ├── check-web.sh           # Health check script
│   ├── properties.sh          # Service properties
│   └── backup.sh              # Backup/restore functionality
├── Dockerfile                 # Container definition
├── Makefile                   # Build system
└── START9_README.md           # This file
```

## Configuration

After installation, configure the service through the Start9 web interface:

### Email Provider Setup

**Option 1: Gmail (Recommended)**
1. Enable 2-factor authentication on your Google account
2. Generate an App Password: Google Account → Security → App Passwords
3. Use your Gmail address and the 16-character app password

**Option 2: Custom SMTP**
1. Get SMTP settings from your email provider
2. Enter hostname, port (usually 587), username, and password

### Advanced Settings
- **Port**: Internal service port (default: 3000)
- **Environment**: Production or development mode

## Features in Start9

- ✅ **Automatic Backup/Restore**: User data and configurations are backed up
- ✅ **Health Monitoring**: Real-time service health checks
- ✅ **Secure Configuration**: Secrets are properly managed
- ✅ **Tor Integration**: Accessible via .onion address
- ✅ **LAN Access**: Available on your local network with SSL
- ✅ **Data Persistence**: Survives service restarts and updates

## Usage After Installation

1. **Initial Setup**
   - Access the service from your Start9 Services page
   - Create a user account and log in
   - Configure your email settings in the Start9 config panel

2. **Configure Deadman Switch**
   - Add recipient email addresses
   - Set check-in frequency (1 minute to 2 weeks)
   - Set inactivity period (3 minutes to 9 months)
   - Test with short intervals first

3. **Activate**
   - Deploy the deadman switch
   - Respond to check-in emails to stay active
   - Monitor countdown timers in the dashboard

## Security Considerations

- **Email Credentials**: Stored securely in Start9's configuration system
- **User Data**: Encrypted and isolated per user
- **JWT Tokens**: Cryptographically secure authentication
- **Backup Security**: Sensitive credentials excluded from backups

## Troubleshooting

### Service Won't Start
1. Check configuration in Start9 Config tab
2. Ensure email credentials are valid
3. Check service logs in Start9 interface

### Emails Not Sending
1. Verify email configuration
2. Test with a short check-in interval
3. Check that your email provider allows SMTP

### Timer Display Issues
The service now supports proper formatting for long periods:
- Short periods: `HH:mm:ss` (e.g., `23:45:30`)
- Long periods: `DDD:HH:mm:ss` (e.g., `007:00:00:00` for 1 week)

### Large Timeout Periods
The service handles JavaScript's setTimeout limitations for periods > 24.8 days by using interval checking.

## Development

### Testing Locally
```bash
# Build development image
make dev-build

# Run development container
make dev-run
```

### Making Changes
1. Modify the source files as needed
2. Update version in `start9/manifest.yaml` if making a release
3. Rebuild: `make clean && make build`
4. Test thoroughly before deploying

### Build Targets
- `make verify` - Check package structure
- `make build` - Build complete package
- `make clean` - Remove build artifacts
- `make validate` - Validate built package
- `make help` - Show all available commands

## Support

For issues specific to the Start9 packaging:
- Check the build logs: `make build`
- Validate the package: `make validate`
- Review Start9 service logs in the web interface

For general application issues:
- See the main README.md in the project root
- Check GitHub issues: https://github.com/ericscalibur/Deploy-Deadman-Switch/issues

## Version History

- **v1.0.0**: Initial Start9 package release
  - Full Deadman Switch functionality
  - Gmail and custom SMTP support
  - Automatic backup/restore
  - Health monitoring integration
  - Fixed large timeout handling (>24.8 days)
  - Improved timer display format (DDD:HH:mm:ss)