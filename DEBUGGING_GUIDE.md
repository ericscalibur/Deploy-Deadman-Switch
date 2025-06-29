# Deadman Switch Debugging Guide

This guide will help you troubleshoot the two main issues you're experiencing:
1. Check-in email link not resetting the deadman switch timer
2. Beneficiary emails not being sent when the timer expires

## Quick Fixes Applied

I've already made several fixes to your code:

### 1. Fixed Check-in Link Timer Reset Issue
- **Problem**: The check-in endpoint was trying to use `sessionData.sessionToken` which wasn't available in that scope
- **Fix**: Now properly retrieves the session token from `switchData.sessionToken` and updates the database
- **Location**: `Deploy/routes/deadman-minimal.js` lines ~935-946

### 2. Enhanced Email Sending Logic
- **Problem**: Emails might not be available during deadman activation
- **Fix**: Added fallback to get emails from `switchData.settings.emails` if not found in memory
- **Location**: `Deploy/routes/deadman-minimal.js` lines ~1007-1016

### 3. Improved Logging
- **Enhancement**: Added comprehensive logging throughout the email service and deadman logic
- **Location**: `Deploy/utils/emailService.js` and `Deploy/routes/deadman-minimal.js`

## Debugging Steps

### Step 1: Check Email Service Configuration

1. Make sure your `.env` file has the correct email configuration:

```env
# For Gmail (recommended for testing)
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-app-password

# OR for production SMTP
SMTP_HOST=your-smtp-server.com
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password

# Application URL (important for check-in links)
APP_URL=http://localhost:3000
```

2. Test email service by visiting: `GET /deadman/debug/test-email`

### Step 2: Verify Active Deadman Switch

1. Check if your deadman switch is properly active:
   - Visit: `GET /deadman/debug/active-switches`
   - Look for:
     - `hasActiveSwitch: true`
     - `hasCheckinTimer: true`
     - `hasDeadmanTimer: true`
     - `sessionToken` should not be null
     - `emailCount` should be > 0

### Step 3: Check Database Session Updates

1. Look at server logs when clicking check-in links
2. You should see: `Database session activity updated for [email]`
3. If you see errors about session not found, the database session might be expired

### Step 4: Verify Email Configuration in Deadman Switch

1. When setting up your deadman switch, ensure:
   - Beneficiary emails are properly formatted
   - Each email has: `to`, `subject`, and `body` fields
   - Example format:
   ```json
   [
     {
       "to": "recipient@example.com",
       "subject": "Important Message",
       "body": "This is my important message"
     }
   ]
   ```

### Step 5: Monitor Deadman Timer Activation

1. Check activation history: `GET /deadman/debug/activation-history`
2. Look at server logs for:
   - `Deadman timer expired for [email], sending X emails`
   - `Successfully sent deadman emails for [email]`
   - Any error messages about email sending

## Common Issues and Solutions

### Issue: Check-in Link Shows "Invalid Check-In Link"
**Cause**: Token expired or server restarted (tokens are stored in memory)
**Solution**: Wait for next check-in email or restart deadman switch

### Issue: No Check-in Emails Received
**Causes**:
1. Email service not configured properly
2. Emails going to spam folder
3. Timer not started properly

**Solutions**:
1. Test email service with debug endpoint
2. Check spam/junk folders
3. Restart the deadman switch

### Issue: Beneficiary Emails Not Sent
**Causes**:
1. No emails configured in the deadman switch
2. Email service failure
3. Emails stored only in memory and lost on restart

**Solutions**:
1. Verify email configuration in debug endpoint
2. Check server logs for email sending errors
3. Ensure server stays running continuously

### Issue: Timer Not Resetting After Check-in
**Causes**:
1. Database session update failed
2. Session token invalid or expired
3. Server error during check-in processing

**Solutions**:
1. Check server logs for database errors
2. Restart deadman switch to generate new session
3. Verify database connectivity

## Testing Procedure

1. **Set up deadman switch** with short intervals for testing:
   - Check-in interval: 1 minute
   - Inactivity period: 3 minutes

2. **Verify initial setup**:
   - Visit `/deadman/debug/active-switches`
   - Confirm all timers are active and emails configured

3. **Test check-in flow**:
   - Wait for check-in email (1 minute)
   - Click the check-in link
   - Verify success message appears
   - Check server logs for database update confirmation

4. **Test deadman activation**:
   - Don't click check-in link for 3+ minutes
   - Monitor server logs for deadman activation
   - Check if beneficiary emails are sent
   - Visit `/deadman/debug/activation-history` to confirm

## Production Recommendations

1. **Use persistent storage**: Consider storing active switches in database instead of memory
2. **Email reliability**: Use a reliable SMTP service (SendGrid, Mailgun, etc.)
3. **Monitoring**: Set up alerts for email sending failures
4. **Backup check-ins**: Implement multiple check-in methods (email + SMS)
5. **Recovery procedures**: Document how to recover from server restarts

## Server Logs to Monitor

Watch for these log messages:
- `✅ Email service initialized successfully`
- `📧 Sending check-in email to [email]`
- `Database session activity updated for [email]`
- `🚨 Sending deadman emails for [email] to X recipients`
- `✅ Deadman email sent successfully`

## Getting Help

If issues persist:
1. Check server logs for specific error messages
2. Use the debug endpoints to gather system state information
3. Verify all environment variables are set correctly
4. Test with shorter time intervals for faster debugging