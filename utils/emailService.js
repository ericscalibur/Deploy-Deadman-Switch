const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const { notify, notifyThrottled, clearThrottle } = require("./notify");

// Repeated-failure alert cadence: init retries once a minute and check-in
// sends recur per interval, so out-of-band alerts are capped to one per
// issue per hour to stay meaningful.
const NTFY_REPEAT_MS = 60 * 60 * 1000;

// Subject-line severity coding (Issue #4): plain words, never emoji — emoji
// in subjects is the signature of marketing mail and is exactly what spam
// heuristics are tuned to catch. Routine traffic carries no urgency word at
// all; URGENT marks the beneficiary pre-fire warning; CRITICAL is reserved
// for the trigger itself; WARNING marks operator-side operational alerts.

// Beneficiary-facing links point back at the operator's own server, which is
// normally a Tor onion address. Chrome/Safari cannot resolve .onion at all and
// report it as an ordinary dead page — so a beneficiary who is never told this
// reads a working ack link as a broken one (or as phishing) and silently never
// acknowledges. Say it explicitly, but only when the link actually needs Tor:
// on a clearnet or LAN deployment these instructions would be noise.
function torNotice(url) {
  if (!/\.onion(?::\d+)?(?:\/|$)/i.test(String(url || ""))) {
    return { html: "", text: "" };
  }
  return {
    html: `
        <p style="border-left: 4px solid #7d4698; padding-left: 15px; margin: 20px 0;">
          <strong>This link only opens in Tor Browser.</strong> It is a
          <code>.onion</code> address. Ordinary browsers such as Chrome, Safari
          or Firefox cannot reach it and will report the page as unavailable —
          that does not mean the link is broken. Install Tor Browser (free,
          takes a few minutes) from
          <a href="https://www.torproject.org/download/">torproject.org/download</a>,
          then paste the link above into it.
        </p>`,
    text: `
This link only opens in Tor Browser. It is a .onion address. Ordinary browsers such as Chrome, Safari or Firefox cannot reach it and will report the page as unavailable — that does not mean the link is broken. Install Tor Browser (free, takes a few minutes) from https://www.torproject.org/download/ then paste the link above into it.
`,
  };
}

// Email service for sending check-in and deadman emails
class EmailService {
  constructor() {
    this.transporter = null;
    this.backupTransporter = null;
    this.triggerTransporter = null;
    this.initialized = false;
    this._lastInitAttempt = Date.now();
    this._initPromise = this.init().finally(() => {
      this._initPromise = null;
    });
  }

  // Wait for any in-flight init; if init failed, retry at most once per minute
  // so fixed credentials start working without a server restart.
  async ensureReady() {
    if (this._initPromise) {
      await this._initPromise;
    }
    if (this.initialized) return true;

    if (Date.now() - this._lastInitAttempt >= 60000) {
      console.log("🔁 Email service not initialized — retrying SMTP setup...");
      this._lastInitAttempt = Date.now();
      this._initPromise = this.init().finally(() => {
        this._initPromise = null;
      });
      await this._initPromise;
    }
    return this.initialized;
  }

  _buildPrimaryTransport() {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      console.log("Using Gmail SMTP configuration (primary)");
      return nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });
    } else if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      console.log("Using custom SMTP configuration (primary)");
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_PORT === "465",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    }
    return null;
  }

  // Dedicated sender for the trigger email (Issue #4, modification 2).
  // Habituation attaches to the sender address: routine liveness traffic and
  // the one message that must land should come from different addresses, so
  // the beneficiary can filter routine mail without touching the channel
  // that matters. Optional — falls back to the primary transport if unset.
  _buildTriggerTransport() {
    if (process.env.TRIGGER_EMAIL_USER && process.env.TRIGGER_EMAIL_PASS) {
      console.log("Using Gmail SMTP configuration (trigger sender)");
      return nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.TRIGGER_EMAIL_USER,
          pass: process.env.TRIGGER_EMAIL_PASS,
        },
      });
    } else if (
      process.env.TRIGGER_SMTP_HOST &&
      process.env.TRIGGER_SMTP_USER &&
      process.env.TRIGGER_SMTP_PASS
    ) {
      console.log("Using custom SMTP configuration (trigger sender)");
      return nodemailer.createTransport({
        host: process.env.TRIGGER_SMTP_HOST,
        port: parseInt(process.env.TRIGGER_SMTP_PORT) || 587,
        secure: process.env.TRIGGER_SMTP_PORT === "465",
        auth: {
          user: process.env.TRIGGER_SMTP_USER,
          pass: process.env.TRIGGER_SMTP_PASS,
        },
      });
    }
    return null;
  }

  _routineFromAddress() {
    return (
      process.env.EMAIL_USER ||
      process.env.SMTP_USER ||
      "noreply@deploy-deadman.com"
    );
  }

  _triggerFromAddress() {
    return (
      process.env.TRIGGER_EMAIL_USER ||
      process.env.TRIGGER_SMTP_USER ||
      this._routineFromAddress()
    );
  }

  _buildBackupTransport() {
    if (process.env.SMTP_BACKUP_HOST && process.env.SMTP_BACKUP_USER && process.env.SMTP_BACKUP_PASS) {
      console.log("Using backup SMTP configuration");
      return nodemailer.createTransport({
        host: process.env.SMTP_BACKUP_HOST,
        port: parseInt(process.env.SMTP_BACKUP_PORT) || 587,
        secure: process.env.SMTP_BACKUP_PORT === "465",
        auth: {
          user: process.env.SMTP_BACKUP_USER,
          pass: process.env.SMTP_BACKUP_PASS,
        },
      });
    }
    return null;
  }

  async init() {
    try {
      console.log("Initializing email service...");

      this.transporter = this._buildPrimaryTransport();

      if (!this.transporter) {
        console.log("No primary SMTP configured — using Ethereal test account");
        const testAccount = await nodemailer.createTestAccount();
        console.log("Test account created:", testAccount.user);
        this.transporter = nodemailer.createTransport({
          host: "smtp.ethereal.email",
          port: 587,
          secure: false,
          auth: { user: testAccount.user, pass: testAccount.pass },
        });
      }

      // Verify primary
      await this.transporter.verify();
      this.initialized = true;
      console.log("✅ Primary email transporter verified");

      if (this._smtpDownAlerted) {
        this._smtpDownAlerted = false;
        clearThrottle("smtp-init-failed");
        notify("Email service recovered — SMTP transporter verified.", {
          tags: "white_check_mark,email",
        });
      }

      // Init backup transporter if configured (non-blocking)
      const backup = this._buildBackupTransport();
      if (backup) {
        backup.verify()
          .then(() => {
            this.backupTransporter = backup;
            console.log("✅ Backup email transporter verified");
          })
          .catch((err) => {
            console.warn("⚠️ Backup SMTP failed verification, ignoring:", err.message);
          });
      }

      // Init dedicated trigger transporter if configured (non-blocking)
      const trigger = this._buildTriggerTransport();
      if (trigger) {
        trigger.verify()
          .then(() => {
            this.triggerTransporter = trigger;
            console.log("✅ Trigger email transporter verified");
          })
          .catch((err) => {
            console.warn(
              "⚠️ Trigger SMTP failed verification — deadman emails will use the primary sender:",
              err.message,
            );
          });
      }
    } catch (error) {
      console.error("❌ Failed to initialize primary email service:", error);

      // Try backup as primary if primary fails init
      const backup = this._buildBackupTransport();
      if (backup) {
        try {
          await backup.verify();
          this.transporter = backup;
          this.initialized = true;
          console.log("✅ Falling back to backup SMTP as primary");
        } catch (backupError) {
          console.error("❌ Backup SMTP also failed:", backupError.message);
          this.initialized = false;
        }
      } else {
        this.initialized = false;
      }

      if (!this.initialized) {
        this._smtpDownAlerted = true;
        notifyThrottled(
          "smtp-init-failed",
          NTFY_REPEAT_MS,
          `Email transporter failed verification: ${error.message}. ` +
            "No check-in, warning, or trigger emails can be sent until this is fixed. " +
            "The server keeps retrying every minute.",
          { priority: "urgent", tags: "rotating_light,email" },
        );
      }
    }
  }

  async reinitialize() {
    console.log("Reinitializing email service with updated config...");
    this.initialized = false;
    this.transporter = null;
    this.backupTransporter = null;
    this.triggerTransporter = null;
    this._lastInitAttempt = Date.now();
    this._initPromise = this.init().finally(() => {
      this._initPromise = null;
    });
    await this._initPromise;
  }

  // Send via primary, retry once with backup on failure
  async _sendWithFallback(mailOptions) {
    try {
      const info = await this.transporter.sendMail(mailOptions);
      return { success: true, info, usedBackup: false };
    } catch (primaryError) {
      console.error("❌ Primary SMTP send failed:", primaryError.message);

      if (this.backupTransporter) {
        console.log("🔄 Retrying with backup SMTP...");
        try {
          const info = await this.backupTransporter.sendMail(mailOptions);
          console.log("✅ Backup SMTP send succeeded");
          return { success: true, info, usedBackup: true };
        } catch (backupError) {
          console.error("❌ Backup SMTP send also failed:", backupError.message);
          throw backupError;
        }
      }

      throw primaryError;
    }
  }

  // Send via the dedicated trigger sender when configured; if it fails (or
  // was never configured) fall back to the primary/backup chain — a fired
  // switch must deliver, sender hygiene is secondary to delivery.
  async _sendTrigger(mailOptions) {
    if (this.triggerTransporter) {
      try {
        const info = await this.triggerTransporter.sendMail(mailOptions);
        return { success: true, info, usedBackup: false };
      } catch (triggerError) {
        console.error(
          "❌ Trigger SMTP send failed, falling back to primary:",
          triggerError.message,
        );
      }
    }
    return this._sendWithFallback(mailOptions);
  }

  // A failed check-in email is the false-fire failure mode: the operator
  // cannot answer a question they never received, and the timer counts on
  // regardless. It gets its own out-of-band alert, per operator.
  _alertCheckinSendFailure(userEmail, reason) {
    notifyThrottled(
      `checkin-send-failed:${userEmail}`,
      NTFY_REPEAT_MS,
      `Check-in email to ${userEmail} could NOT be sent (${reason}). ` +
        "The countdown continues — if this persists the switch could fire on a living operator.",
      { priority: "urgent", tags: "rotating_light,hourglass" },
    );
  }

  async sendCheckinEmail(userEmail, checkinToken, missedCheckins = 0) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — check-in email to ${userEmail} NOT sent. Check EMAIL_USER/EMAIL_PASS.`,
      );
      this._alertCheckinSendFailure(userEmail, "email service not initialized");
      return false;
    }

    try {
      const checkinUrl = `${process.env.APP_URL || "http://localhost:3000"}/deadman/checkin/${checkinToken}`;
      console.log(`📧 Sending check-in email to ${userEmail}`);

      // missedCheckins counts consecutive intervals of silence including the
      // one that just elapsed; earlier *emails* left unanswered is one less.
      const unanswered = Math.max(0, missedCheckins - 1);
      const subject =
        unanswered === 0
          ? "Deploy check-in required"
          : `URGENT: Deploy check-in overdue — ${unanswered} unanswered`;
      const overdueHtml =
        unanswered === 0
          ? ""
          : `<p><strong>You have not responded to ${unanswered} previous check-in ${unanswered === 1 ? "email" : "emails"}.</strong>
             If you keep missing check-ins, your recipients will first receive a
             pre-fire warning, and eventually the switch will fire. If you are
             seeing this and you are fine, check in now.</p>`;
      const overdueText =
        unanswered === 0
          ? ""
          : `\nYou have not responded to ${unanswered} previous check-in email(s). If you keep missing check-ins, your recipients will first receive a pre-fire warning, and eventually the switch will fire.\n`;

      const mailOptions = {
        from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
        to: userEmail,
        subject,
        html: `
          <h2>Check-In Required</h2>
          <p>Hello,</p>
          <p>This is your scheduled check-in from Deploy Deadman Switch service.</p>
          ${overdueHtml}
          <p><strong>Click the link below to confirm you're active:</strong></p>
          <p><a href="${checkinUrl}" style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">I'm Active - Reset Timer</a></p>
          <p>Or copy and paste this URL into your browser:</p>
          <p><code>${checkinUrl}</code></p>
          <hr>
          <p><small>If you don't respond to check-ins, your deadman switch will activate and send your configured emails.</small></p>
          <p><small>This is an automated message from Deploy Deadman Switch.</small></p>
        `,
        text: `
Check-In Required

Hello,

This is your scheduled check-in from Deploy Deadman Switch service.
${overdueText}
Click the link below to confirm you're active:
${checkinUrl}

If you don't respond to check-ins, your deadman switch will activate and send your configured emails.

This is an automated message from Deploy Deadman Switch.
        `,
      };

      const { info } = await this._sendWithFallback(mailOptions);
      console.log(`✅ Check-in email sent successfully to ${userEmail}`, info.messageId);
      clearThrottle(`checkin-send-failed:${userEmail}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send check-in email to ${userEmail}:`, error);
      this._alertCheckinSendFailure(userEmail, error.message);
      return false;
    }
  }

  // First check-in email of an armed-but-pending switch (and its reminders).
  // The switch holds in pending until this link is clicked: completing the
  // check-in proves the whole loop — email arrives, link opens, server
  // reachable, token accepted — before anything is allowed to count down.
  async sendArmingCheckinEmail(userEmail, checkinToken, isReminder = false) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — arming check-in email to ${userEmail} NOT sent.`,
      );
      this._alertCheckinSendFailure(userEmail, "email service not initialized");
      return false;
    }

    try {
      const checkinUrl = `${process.env.APP_URL || "http://localhost:3000"}/deadman/checkin/${checkinToken}`;
      const subject = isReminder
        ? "URGENT: Deploy switch is still NOT armed — confirm your first check-in"
        : "Confirm your first check-in to arm your Deploy switch";

      const mailOptions = {
        from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
        to: userEmail,
        subject,
        html: `
          <h2>Your switch is pending — not armed yet</h2>
          <p>You just deployed your Deploy Deadman Switch, but the countdown
          has <strong>not started</strong>. It starts only when you complete
          this first check-in, which proves the whole loop works: this email
          reached you, the link opens, and your check-in registers.</p>
          <p><strong>Click the link below to arm the switch:</strong></p>
          <p><a href="${checkinUrl}" style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Arm My Switch - Start Countdown</a></p>
          <p>Or copy and paste this URL into your browser:</p>
          <p><code>${checkinUrl}</code></p>
          <hr>
          <p><small>Until you click, no timers run and nothing will ever be
          sent to your recipients. You will be reminded until the switch is
          armed.</small></p>
          <p><small>This is an automated message from Deploy Deadman Switch.</small></p>
        `,
        text: `
Your switch is pending — not armed yet

You just deployed your Deploy Deadman Switch, but the countdown has NOT started. It starts only when you complete this first check-in, which proves the whole loop works: this email reached you, the link opens, and your check-in registers.

Click the link below to arm the switch:
${checkinUrl}

Until you click, no timers run and nothing will ever be sent to your recipients. You will be reminded until the switch is armed.

This is an automated message from Deploy Deadman Switch.
        `,
      };

      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Arming check-in email ${isReminder ? "(reminder) " : ""}sent to ${userEmail}`,
        info.messageId,
      );
      clearThrottle(`checkin-send-failed:${userEmail}`);
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send arming check-in email to ${userEmail}:`,
        error,
      );
      this._alertCheckinSendFailure(userEmail, error.message);
      return false;
    }
  }

  // Alert the account owner about an operational problem with their switch
  // (e.g. it expired but the recipients could not be recovered after a restart).
  async sendAlertEmail(userEmail, subject, bodyHtml, bodyText) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — alert email to ${userEmail} NOT sent. Check EMAIL_USER/EMAIL_PASS.`,
      );
      return false;
    }

    try {
      const mailOptions = {
        from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
        to: userEmail,
        subject,
        html: bodyHtml,
        text: bodyText || bodyHtml.replace(/<[^>]+>/g, ""),
      };

      const { info } = await this._sendWithFallback(mailOptions);
      console.log(`✅ Alert email sent to ${userEmail}`, info.messageId);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send alert email to ${userEmail}:`, error);
      return false;
    }
  }

  async sendDeadmanEmails(userEmail, configuredEmails) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — DEADMAN emails for ${userEmail} NOT sent. Check EMAIL_USER/EMAIL_PASS.`,
      );
      return false;
    }

    if (!configuredEmails || configuredEmails.length === 0) {
      console.log(
        `❌ No configured emails for deadman activation for ${userEmail}`,
      );
      return false;
    }

    console.log(
      `🚨 Sending deadman emails for ${userEmail} to ${configuredEmails.length} recipients`,
    );

    try {
      const sendPromises = configuredEmails.map(async (email, index) => {
        const recipientEmail = email.to || email.address;
        console.log(
          `📧 Sending deadman email ${index + 1} to ${recipientEmail}`,
        );

        // Generate QR code if an encrypted payload is attached to this email
        let qrHtml = "";
        let qrText = "";
        if (email.payload) {
          try {
            const qrDataUrl = await QRCode.toDataURL(email.payload, {
              errorCorrectionLevel: "L",
              margin: 2,
              width: 400,
            });
            qrHtml = `
              <div style="text-align: center; margin: 24px 0;">
                <p><strong>Scan this QR code with Legacy to decrypt:</strong></p>
                <img src="${qrDataUrl}" alt="Legacy Encrypted QR Code" style="width: 300px; height: 300px;" />
                <p style="font-size: 11px; color: #888; margin-top: 8px;">
                  Or copy the encrypted text below into Legacy manually.
                </p>
                <pre style="font-size: 10px; word-break: break-all; background: #f4f4f4; padding: 10px; border-radius: 4px;">${email.payload}</pre>
              </div>`;
            qrText = `\nEncrypted payload (paste into Legacy to decrypt):\n${email.payload}\n`;
          } catch (qrErr) {
            console.error(`⚠️ QR generation failed for email ${index + 1}:`, qrErr.message);
          }
        }

        // The encrypted payload rides in the email itself; the how-to-decrypt
        // lives at the Legacy site (decrypt page, downloadable offline copy,
        // and the full reimplementation spec in FAQ item 10). Keeping the
        // spec out of the email trades the stand-alone-for-decades property
        // for an email a beneficiary can actually read without panic.
        const decryptUrl =
          "https://ericscalibur.github.io/Legacy_Encryption/decrypt.html";
        const offlineUrl =
          "https://github.com/ericscalibur/Legacy_Encryption/blob/main/Legacy-offline.html";
        const faqUrl =
          "https://ericscalibur.github.io/Legacy_Encryption/FAQ.html";
        const specHtml = email.payload
          ? `
            <h3>How to decrypt</h3>
            <p>To decrypt your seedphrase, paste the cypher text into the
            Encrypted Seed Phrase field, enter your Beneficiary Key and the
            Benefactor Key. Click 'Decrypt'.</p>
            <p><a href="${decryptUrl}">Legacy Decryption</a> &mdash; or download the
            <a href="${offlineUrl}">offline version</a> to run on a computer
            with no internet connection.</p>
            <p>For more information see the <a href="${faqUrl}">FAQ</a>.</p>`
          : "";
        const specText = email.payload
          ? `
How to decrypt

To decrypt your seedphrase, paste the cypher text into the Encrypted Seed Phrase field, enter your Beneficiary Key and the Benefactor Key. Click 'Decrypt'.

Legacy Decryption: ${decryptUrl}
Offline version (download to run without internet): ${offlineUrl}

For more information see the FAQ: ${faqUrl}
`
          : "";

        const mailOptions = {
          from: `"${userEmail} (Deploy Deadman Switch)" <${this._triggerFromAddress()}>`,
          to: recipientEmail,
          subject: `CRITICAL: ${email.subject || `Message from ${userEmail}`}`,
          html: `
            <h2>Important Message</h2>
            <p>This message was automatically sent by Deploy Deadman Switch because ${userEmail} did not respond to check-ins for an extended period. If you received an advance warning email recently, this is the follow-through it announced.</p>
            <hr>
            <div style="border-left: 4px solid #007bff; padding-left: 15px; margin: 20px 0;">
              ${email.body || email.content || "No message content provided."}
            </div>
            ${qrHtml}
            ${specHtml}
            <hr>
            <p><small>This message was sent automatically by Deploy Deadman Switch service.</small></p>
            <p><small>Original sender: ${userEmail}</small></p>
            <p><small>Print or save this entire email — it contains the encrypted payload needed for recovery.</small></p>
          `,
          text: `
Important Message

This message was automatically sent by Deploy Deadman Switch because ${userEmail} did not respond to check-ins for an extended period. If you received an advance warning email recently, this is the follow-through it announced.

---

${email.body || email.content || "No message content provided."}
${qrText}
${specText}
---

This message was sent automatically by Deploy Deadman Switch service.
Original sender: ${userEmail}
Print or save this entire email — it contains the encrypted payload needed for recovery.
          `,
        };

        try {
          const { info } = await this._sendTrigger(mailOptions);
          console.log(
            `✅ Deadman email ${index + 1} sent successfully to ${recipientEmail}`,
            info.messageId,
          );
          return { success: true, index, messageId: info.messageId };
        } catch (error) {
          console.error(
            `❌ Failed to send deadman email ${index + 1} to ${recipientEmail}:`,
            error,
          );
          return { success: false, index, error: error.message };
        }
      });

      const results = await Promise.all(sendPromises);
      const successCount = results.filter((r) => r.success).length;

      console.log(
        `📊 Deadman email results: ${successCount}/${configuredEmails.length} emails sent successfully`,
      );
      return successCount > 0;
    } catch (error) {
      console.error(
        `❌ Failed to send deadman emails for ${userEmail}:`,
        error,
      );
      return false;
    }
  }

  // Pre-fire warning to a beneficiary (Issue #1). Deliberately contains NO
  // key material, no ciphertext, no attachments — notification only. This is
  // the system's last false-positive filter: a human who can try channels
  // Deploy has no access to (phone, family, physically going there).
  async sendBeneficiaryWarning(
    recipientEmail,
    operatorEmail,
    daysRemaining,
    ackUrl,
    isResend = false,
  ) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — beneficiary warning to ${recipientEmail} NOT sent.`,
      );
      return false;
    }

    const daysText =
      daysRemaining > 0 ? `approximately ${daysRemaining} days` : "very soon";

    const tor = torNotice(ackUrl);

    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      to: recipientEmail,
      subject: `URGENT: ${operatorEmail} has stopped responding — action needed${isResend ? " (reminder)" : ""}`,
      html: `
        <h2>Please read this carefully</h2>
        <p>You are receiving this because <strong>${operatorEmail}</strong> set up an
        automated "dead man's switch": a system that sends you important
        pre-written information if they stop confirming they are okay.</p>
        <p><strong>${operatorEmail} has now missed several scheduled check-ins.</strong>
        If they continue not to respond, this system will automatically send you
        their prepared message in <strong>${daysText}</strong>. That final message
        cannot be cancelled once it is sent.</p>
        <h3>What you should do now</h3>
        <ol>
          <li><strong>Try to reach ${operatorEmail} by every means you have</strong> —
          phone, family, mutual friends, visiting in person. They may simply have
          lost access to this email account. If you reach them, tell them to check
          in with their Deploy system immediately.</li>
          <li><strong>Confirm you received this warning</strong> by clicking:
          <a href="${ackUrl}">${ackUrl}</a> — this only confirms this address works;
          it does not trigger or stop anything.</li>
        </ol>${tor.html}
        <p>This warning contains no sensitive information. If the final message is
        sent later, it will arrive from a different sender address and will be
        marked CRITICAL.</p>
        <p><small>Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}.</small></p>
      `,
      text: `
Please read this carefully.

You are receiving this because ${operatorEmail} set up an automated "dead man's switch": a system that sends you important pre-written information if they stop confirming they are okay.

${operatorEmail} has now missed several scheduled check-ins. If they continue not to respond, this system will automatically send you their prepared message in ${daysText}. That final message cannot be cancelled once it is sent.

What you should do now:

1. Try to reach ${operatorEmail} by every means you have — phone, family, mutual friends, visiting in person. They may simply have lost access to this email account. If you reach them, tell them to check in with their Deploy system immediately.

2. Confirm you received this warning by opening this link:
${ackUrl}
This only confirms this address works; it does not trigger or stop anything.
${tor.text}
This warning contains no sensitive information. If the final message is sent later, it will arrive from a different sender address and will be marked CRITICAL.

Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}.
      `,
    };

    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Beneficiary warning sent to ${recipientEmail}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send beneficiary warning to ${recipientEmail}:`,
        error,
      );
      return false;
    }
  }

  // Annual liveness ping (Issue #2). The beneficiary's channel is otherwise
  // exercised exactly once, years out, at the one moment nobody remains to
  // notice it failed — this keeps the address proven continuously. Kept
  // deliberately boring and rare (Issue #4: volume is the real lever).
  // firstContact selects introduction wording for an address that has never
  // been contacted (sent the moment a switch is armed); the default wording
  // is the annual renewal.
  async sendBeneficiaryPing(
    recipientEmail,
    operatorEmail,
    ackUrl,
    firstContact = false,
  ) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — beneficiary ping to ${recipientEmail} NOT sent.`,
      );
      return false;
    }

    const tor = torNotice(ackUrl);

    const subject = firstContact
      ? `${operatorEmail} listed you as a trusted contact — one click required`
      : `Annual contact check for ${operatorEmail} — one click required`;
    const introHtml = firstContact
      ? `<p><strong>${operatorEmail}</strong> has set up an automated notification
        system and listed this address as a trusted contact. If they ever become
        unreachable for a long period, this system will send you important
        information they prepared. Nothing is wrong and nothing is being sent
        to you now.</p>
        <p>To confirm the line of communication works, <strong>please click:</strong><br>
        <a href="${ackUrl}">${ackUrl}</a></p>`
      : `<p>This is the once-a-year address verification from the automated
        notification system that <strong>${operatorEmail}</strong> set up with you
        in mind. Nothing is wrong and nothing is being sent to you.</p>
        <p><strong>Please confirm this address still works by clicking:</strong><br>
        <a href="${ackUrl}">${ackUrl}</a></p>`;
    const introText = firstContact
      ? `${operatorEmail} has set up an automated notification system and listed this address as a trusted contact. If they ever become unreachable for a long period, this system will send you important information they prepared. Nothing is wrong and nothing is being sent to you now.

To confirm the line of communication works, please open this link:
${ackUrl}`
      : `This is the once-a-year address verification from the automated notification system that ${operatorEmail} set up with you in mind. Nothing is wrong and nothing is being sent to you.

Please confirm this address still works by opening this link:
${ackUrl}`;

    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      to: recipientEmail,
      subject,
      html: `
        ${introHtml}${tor.html}
        <p>If you don't confirm within 30 days, ${operatorEmail} will be alerted
        that this address may no longer be in use.</p>
        <p><small>Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}. After this, expect exactly one verification per year.</small></p>
      `,
      text: `
${introText}
${tor.text}
If you don't confirm within 30 days, ${operatorEmail} will be alerted that this address may no longer be in use.

Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}. After this, expect exactly one verification per year.
      `,
    };

    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Beneficiary liveness ping sent to ${recipientEmail}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send beneficiary ping to ${recipientEmail}:`,
        error,
      );
      return false;
    }
  }

  // The beneficiary clicked the ack link — tell the operator the line of
  // communication is confirmed open. For privacy the address is not named
  // (the dashboard's per-recipient "Last contact" line shows which).
  async sendPingConfirmedNotice(operatorEmail, firstContact) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — ping-confirmed notice to ${operatorEmail} NOT sent.`,
      );
      return false;
    }

    const lead = firstContact
      ? "A recipient has confirmed they can receive messages from your deadman switch — the line of communication is open."
      : "A recipient has answered this year's address check — their contact address is still live.";

    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      to: operatorEmail,
      subject: "A recipient confirmed their contact address",
      html: `
        <p><strong>${lead}</strong></p>
        <p>To see which recipient (and when), open your Deploy dashboard —
        each recipient shows a "Last contact" date. No action is needed.</p>
        <p><small>Automated message from Deploy Deadman Switch.</small></p>
      `,
      text: `
${lead}

To see which recipient (and when), open your Deploy dashboard — each recipient shows a "Last contact" date. No action is needed.

Automated message from Deploy Deadman Switch.
      `,
    };

    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Ping-confirmed notice sent to ${operatorEmail}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send ping-confirmed notice to ${operatorEmail}:`,
        error,
      );
      return false;
    }
  }

  // Operator checked in after a pre-fire warning went out — tell the
  // beneficiary to stand down so they aren't left expecting a fire.
  async sendBeneficiaryStandDown(recipientEmail, operatorEmail) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — stand-down notice to ${recipientEmail} NOT sent.`,
      );
      return false;
    }

    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      to: recipientEmail,
      subject: `All clear: ${operatorEmail} has checked in`,
      html: `
        <p><strong>${operatorEmail} has checked in.</strong> The earlier warning you
        received is cancelled — no message will be sent and no action is needed
        from you.</p>
        <p><small>Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}.</small></p>
      `,
      text: `
${operatorEmail} has checked in. The earlier warning you received is cancelled — no message will be sent and no action is needed from you.

Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}.
      `,
    };

    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Stand-down notice sent to ${recipientEmail}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send stand-down notice to ${recipientEmail}:`,
        error,
      );
      return false;
    }
  }

  async testEmailConnection() {
    if (!(await this.ensureReady())) {
      return {
        success: false,
        message:
          "Email service not initialized — SMTP login failed. Check EMAIL_USER/EMAIL_PASS (Gmail app passwords can be revoked).",
      };
    }

    try {
      await this.transporter.verify();
      return { success: true, message: "Email connection verified" };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}

// Create singleton instance
const emailService = new EmailService();

module.exports = emailService;
