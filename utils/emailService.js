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

// Beneficiary addresses never appear in the log: the database keeps them
// encrypted and the ping table keeps only hashes, and a plaintext address in
// the StartOS log would undo that. Log lines name a recipient by a short
// hash prefix instead ("recipient 3f9a2c1d"). The operator's own address is
// the account name and is logged as such.
const { createHash } = require("crypto");
function tag(address) {
  const h = createHash("sha256")
    .update(String(address || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 8);
  return `recipient ${h}`;
}

// Reply-by-email (v2.2.0): no email Deploy sends carries a link back to
// this server. Every actionable email carries a short code instead, and the
// reader replies with it — from any phone or computer, no reachability
// required. APP_URL is where the dashboard lives and nothing more.
const { formatCode } = require("./codes");

// "18 Sep 2026 14:02 UTC" — every check-in email gets a distinct subject so
// Gmail does not stack them into one conversation showing several codes.
function dateStamp(d = new Date()) {
  const day = d.getUTCDate();
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

// The code, large and monospace, in both parts. Plain text gets it on a line
// of its own so a phone's "copy" picks up exactly the code.
// A real code is formatted XXXX-XXXX; the inert template code EXAM-PLE1 is
// shown exactly as given (it is outside the code alphabet on purpose).
function displayCode(code) {
  const s = String(code || "").toUpperCase();
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(s) ? s : formatCode(s);
}
function codeBlockHtml(code) {
  return `<p style="font-family: Menlo, Consolas, monospace; font-size: 28px; letter-spacing: 3px; margin: 18px 0; padding: 12px 16px; background: #f4f4f4; border-radius: 6px; display: inline-block;">${displayCode(code)}</p>`;
}
function codeBlockText(code) {
  return `\n    ${displayCode(code)}\n`;
}

// Headers on every message Deploy sends. X-Deploy-Deadman lets the inbound
// poller recognise Deploy's own mail when it shares the operator's mailbox
// (a check-in email in the same INBOX would otherwise read as a reply
// carrying its own code — a switch that checks itself in forever).
// Auto-Submitted (RFC 3834) tells vacation responders not to answer routine
// mail, which is how auto-reply loops are prevented on the sending side.
function stampHeaders(mailOptions, { routine = true } = {}) {
  const headers = Object.assign({}, mailOptions.headers || {});
  headers["X-Deploy-Deadman"] = "1";
  if (routine) headers["Auto-Submitted"] = "auto-generated";
  return Object.assign({}, mailOptions, { headers });
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
  async _sendWithFallback(mailOptions, { routine = true } = {}) {
    mailOptions = stampHeaders(mailOptions, { routine });
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
        const info = await this.triggerTransporter.sendMail(
          stampHeaders(mailOptions, { routine: false }),
        );
        return { success: true, info, usedBackup: false };
      } catch (triggerError) {
        console.error(
          "❌ Trigger SMTP send failed, falling back to primary:",
          triggerError.message,
        );
      }
    }
    return this._sendWithFallback(mailOptions, { routine: false });
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

  // The check-in email. Carries a code; the operator replies with it. Also
  // the arming email ({arming: true}) — the first check-in of a deployed
  // switch, which proves the whole round trip (Deploy can send, the
  // operator receives, Deploy can read the answer) before anything counts
  // down — and its reminders ({arming: true, reminder: true}).
  //
  // No button, no URL. Reply-To is set explicitly to the routine address so
  // the reply lands where the inbound poller reads, whatever the client's
  // idea of the sender is.
  //
  // {upgrade: true} is the one-time email sent on first start after the
  // v2.2.0 upgrade: an operator with a two-week interval who got a link
  // email a few days ago must not read an unexpected check-in as a fault.
  async sendCheckinEmail(
    userEmail,
    code,
    missedCheckins = 0,
    { arming = false, reminder = false, upgrade = false } = {},
  ) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — ${arming ? "arming " : ""}check-in email to ${userEmail} NOT sent. Check EMAIL_USER/EMAIL_PASS.`,
      );
      this._alertCheckinSendFailure(userEmail, "email service not initialized");
      return false;
    }

    try {
      console.log(`📧 Sending ${arming ? "arming " : ""}check-in email to ${userEmail}`);
      const stamp = dateStamp();

      let subject;
      let heading;
      let leadHtml;
      let leadText;
      if (arming) {
        subject = reminder
          ? `URGENT: Deploy switch is still NOT armed — confirm your first check-in — ${stamp}`
          : `Confirm your first check-in to arm your Deploy switch — ${stamp}`;
        heading = "Your switch is pending — not armed yet";
        leadHtml = `
          <p>You deployed your Deploy Deadman Switch, but the countdown has
          <strong>not started</strong>. It starts only when you complete this
          first check-in, which proves the whole loop works: this email reached
          you, your reply reached Deploy, and Deploy could read it.</p>
          <p><strong>To arm the switch, reply to this email with this code:</strong></p>`;
        leadText = `You deployed your Deploy Deadman Switch, but the countdown has NOT started. It starts only when you complete this first check-in, which proves the whole loop works: this email reached you, your reply reached Deploy, and Deploy could read it.

To arm the switch, reply to this email with this code:`;
      } else if (upgrade) {
        subject = `Deploy check-in — Deploy was updated — ${stamp}`;
        heading = "Deploy was updated";
        leadHtml = `
          <p>Deploy was updated and check-ins now work by <strong>email
          reply</strong>: the check-in link is gone, and every check-in
          email carries a short code instead.</p>
          <p><strong>Reply to this email with this code to confirm you are
          receiving these.</strong> It counts as a check-in; your check-in
          interval and settings are unchanged.</p>`;
        leadText = `Deploy was updated and check-ins now work by EMAIL REPLY: the check-in link is gone, and every check-in email carries a short code instead.

Reply to this email with this code to confirm you are receiving these. It counts as a check-in; your check-in interval and settings are unchanged.`;
      } else {
        // missedCheckins counts consecutive intervals of silence including
        // the one that just elapsed; earlier *emails* left unanswered is one
        // less.
        const unanswered = Math.max(0, missedCheckins - 1);
        subject =
          unanswered === 0
            ? `Deploy check-in — ${stamp}`
            : `URGENT: Deploy check-in overdue — ${unanswered} unanswered — ${stamp}`;
        heading = "Check-in required";
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
            : `You have not responded to ${unanswered} previous check-in email(s). If you keep missing check-ins, your recipients will first receive a pre-fire warning, and eventually the switch will fire.

`;
        leadHtml = `
          <p>This is your scheduled check-in from Deploy Deadman Switch.</p>
          ${overdueHtml}
          <p><strong>To confirm you are alive, reply to this email with this code:</strong></p>`;
        leadText = `This is your scheduled check-in from Deploy Deadman Switch.

${overdueText}To confirm you are alive, reply to this email with this code:`;
      }

      const tailHtml = arming
        ? `<p>Nothing else is needed. The reply can come from any phone or computer.</p>
          <hr>
          <p><small>Until you reply, no timers run and nothing will ever be
          sent to your recipients. You will be reminded until the switch is
          armed. Your Deploy dashboard shows whether replies are being
          received.</small></p>`
        : `<p>Nothing else is needed. The reply can come from any phone or computer.</p>
          <hr>
          <p><small>If you don't respond to check-ins, your deadman switch will
          activate and send your configured emails. Your Deploy dashboard
          shows whether replies are being received.</small></p>`;
      const tailText = arming
        ? `Nothing else is needed. The reply can come from any phone or computer.

Until you reply, no timers run and nothing will ever be sent to your recipients. You will be reminded until the switch is armed. Your Deploy dashboard shows whether replies are being received.`
        : `Nothing else is needed. The reply can come from any phone or computer.

If you don't respond to check-ins, your deadman switch will activate and send your configured emails. Your Deploy dashboard shows whether replies are being received.`;

      const mailOptions = {
        from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
        replyTo: this._routineFromAddress(),
        to: userEmail,
        subject,
        html: `
          <h2>${heading}</h2>
          <p>Hello,</p>
          ${leadHtml}
          ${codeBlockHtml(code)}
          ${tailHtml}
          <p><small>This is an automated message from Deploy Deadman Switch.</small></p>
        `,
        text: `
${heading}

Hello,

${leadText}
${codeBlockText(code)}
${tailText}

This is an automated message from Deploy Deadman Switch.
        `,
      };

      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ ${arming ? `Arming check-in email ${reminder ? "(reminder) " : ""}` : upgrade ? "Post-upgrade check-in email " : "Check-in email "}sent to ${userEmail}`,
        info.messageId,
      );
      clearThrottle(`checkin-send-failed:${userEmail}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send check-in email to ${userEmail}:`, error);
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
          `📧 Sending deadman email ${index + 1} to ${tag(recipientEmail)}`,
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
        // The airgapped decryption route: a SeedSigner running the Legacy
        // fork decrypts on-device, so the seed phrase is never typed into or
        // displayed on an internet-capable computer. Listed first because a
        // beneficiary decrypting a seed in a browser has already lost the
        // property cold storage exists to protect. Points at a branch, so
        // Points at /releases/latest, not the source tree: a beneficiary
        // needs a flashable signed image with a verifiable hash, not a repo
        // that has to be built with Docker. /latest rather than a pinned tag
        // so the link keeps working as the firmware is updated — but it is
        // only as good as the newest published release, so this link is dead
        // until a release exists.
        const seedsignerUrl =
          "https://github.com/ericscalibur/seedsigner/releases/latest";
        // Tool links lead, instructions follow. The reader has just been told
        // someone died; the first thing they need is the thing to open, not a
        // paragraph about fields they cannot see yet.
        const specHtml = email.payload
          ? `
            <h3>How to decrypt</h3>
            <p>There are two ways. Use the first if you have a SeedSigner
            running Legacy Encryption, or if one was left for you &mdash; it is
            the only route where the seed phrase never touches a computer.
            Otherwise use the second.</p>

            <p><strong>1. On a SeedSigner &mdash; keeps the seed phrase cold</strong><br>
            <a href="${seedsignerUrl}">SeedSigner with Legacy Encryption</a><br>
            On the device go to <em>Tools &rarr; Legacy Encryption &rarr;
            Decrypt Seed Phrase</em>, scan the QR code above, then enter the
            benefactor key followed by the beneficiary key. The recovered words appear on the
            device screen and are never shown on, or typed into, a computer.
            This route needs a SeedSigner running that firmware; the link
            has the image to flash, its checksum, and what hardware it
            runs on.</p>

            <p><strong>2. In the Legacy Decryption tool</strong><br>
            <a href="${decryptUrl}">Legacy Decryption</a> &mdash; or download the
            <a href="${offlineUrl}">offline version</a> to run on a computer
            with no internet connection.<br>
            Paste the cypher text into the Encrypted Seed Phrase field, enter
            your Beneficiary Key and the Benefactor Key, then click
            'Decrypt'.<br>
            If you intend to keep these funds rather than move them
            immediately, prefer the offline version, on a computer you can
            erase afterwards.</p>

            <p>For more information see the <a href="${faqUrl}">FAQ</a>.</p>`
          : "";
        const specText = email.payload
          ? `
How to decrypt

There are two ways. Use the first if you have a SeedSigner running Legacy
Encryption, or if one was left for you - it is the only route where the seed
phrase never touches a computer. Otherwise use the second.

1. On a SeedSigner - keeps the seed phrase cold
   SeedSigner with Legacy Encryption: ${seedsignerUrl}
   On the device go to Tools -> Legacy Encryption -> Decrypt Seed Phrase,
   scan the QR code in this email, then enter the benefactor key followed by
   the beneficiary key. The recovered words appear on the device screen and are
   never shown on, or typed into, a computer. This route needs a SeedSigner
   running that firmware; the link has the image to flash, its checksum, and
   what hardware it runs on.

2. In the Legacy Decryption tool
   Online: ${decryptUrl}
   Offline (download to run on a computer with no internet connection):
   ${offlineUrl}
   Paste the cypher text into the Encrypted Seed Phrase field, enter your
   Beneficiary Key and the Benefactor Key, then click 'Decrypt'.
   If you intend to keep these funds rather than move them immediately, prefer
   the offline version, on a computer you can erase afterwards.

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
            `✅ Deadman email ${index + 1} sent successfully to ${tag(recipientEmail)}`,
            info.messageId,
          );
          return { success: true, index, messageId: info.messageId };
        } catch (error) {
          console.error(
            `❌ Failed to send deadman email ${index + 1} to ${tag(recipientEmail)}:`,
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
    code,
    isResend = false,
  ) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — beneficiary warning to ${tag(recipientEmail)} NOT sent.`,
      );
      return false;
    }

    const daysText =
      daysRemaining > 0 ? `approximately ${daysRemaining} days` : "very soon";

    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      replyTo: this._routineFromAddress(),
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
          <li><strong>Confirm you received this warning by replying to this email
          with this code:</strong>
          ${codeBlockHtml(code)}
          This only confirms this address works; it does not trigger or stop
          anything.</li>
        </ol>
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

2. Confirm you received this warning by replying to this email with this code:
${codeBlockText(code)}
This only confirms this address works; it does not trigger or stop anything.

This warning contains no sensitive information. If the final message is sent later, it will arrive from a different sender address and will be marked CRITICAL.

Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}.
      `,
    };

    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Beneficiary warning sent to ${tag(recipientEmail)}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send beneficiary warning to ${tag(recipientEmail)}:`,
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
  // Single source of truth for the beneficiary contact email.
  //
  // The message editor shows the operator this exact text before they decide
  // whether a beneficiary should receive it, so it is built here and used by
  // both the sender and the preview endpoint. A hand-maintained copy in the
  // UI would drift the moment this wording changed — and it is the copy the
  // operator trusts when making that decision.
  // `code` is the reply code the beneficiary answers with. The message
  // editor's preview passes the inert EXAM-PLE1 (it contains symbols outside
  // the code alphabet, so it can never be mistaken for a live code).
  // {upgrade: true}: this address was already asked to confirm by link
  // before the v2.2.0 upgrade and never did; say plainly that the method
  // changed so a second email in a week does not read as a glitch.
  buildBeneficiaryPingContent(operatorEmail, code, firstContact = false, { upgrade = false } = {}) {
    const esc = (v) =>
      String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const op = esc(operatorEmail);

    const subject = firstContact
      ? `${operatorEmail} listed you as a trusted contact — one reply required`
      : `Annual contact check for ${operatorEmail} — one reply required`;

    const codeHtml = codeBlockHtml(code);
    const codeText = codeBlockText(code);

    const upgradeHtml = upgrade
      ? `<p><em>We've changed how you confirm: instead of a link, reply to this email with the code below. If you received an earlier email with a link, please ignore it.</em></p>`
      : "";
    const upgradeText = upgrade
      ? `We've changed how you confirm: instead of a link, reply to this email with the code below. If you received an earlier email with a link, please ignore it.

`
      : "";

    const introHtml = (firstContact
      ? `<p><strong>${op}</strong> has set up an automated notification
        system and listed this address as a trusted contact. If they ever become
        unreachable for a long period, this system will send you important
        information they prepared. Nothing is wrong and nothing is being sent
        to you now.</p>
        <p><strong>To confirm this address works, reply to this email with this code:</strong></p>
        ${codeHtml}
        <p>Nothing else is needed. The reply can come from any phone or computer.</p>`
      : `<p>This is the once-a-year address verification from the automated
        notification system that <strong>${op}</strong> set up with you
        in mind. Nothing is wrong and nothing is being sent to you.</p>
        <p><strong>To confirm this address still works, reply to this email with this code:</strong></p>
        ${codeHtml}
        <p>Nothing else is needed. The reply can come from any phone or computer.</p>`
    ).replace("<p><strong>To confirm", `${upgradeHtml}<p><strong>To confirm`);

    const introText = (firstContact
      ? `${operatorEmail} has set up an automated notification system and listed this address as a trusted contact. If they ever become unreachable for a long period, this system will send you important information they prepared. Nothing is wrong and nothing is being sent to you now.

To confirm this address works, reply to this email with this code:
${codeText}
Nothing else is needed. The reply can come from any phone or computer.`
      : `This is the once-a-year address verification from the automated notification system that ${operatorEmail} set up with you in mind. Nothing is wrong and nothing is being sent to you.

To confirm this address still works, reply to this email with this code:
${codeText}
Nothing else is needed. The reply can come from any phone or computer.`
    ).replace("To confirm this address", `${upgradeText}To confirm this address`);

    return {
      subject,
      html: `
        ${introHtml}
        <p>If you don't confirm within 30 days, ${op} will be alerted
        that this address may no longer be in use.</p>
        <p><small>Automated message from Deploy Deadman Switch on behalf of ${op}. After this, expect exactly one verification per year.</small></p>
      `,
      text: `
${introText}

If you don't confirm within 30 days, ${operatorEmail} will be alerted that this address may no longer be in use.

Automated message from Deploy Deadman Switch on behalf of ${operatorEmail}. After this, expect exactly one verification per year.
      `,
    };
  }

  async sendBeneficiaryPing(
    recipientEmail,
    operatorEmail,
    code,
    firstContact = false,
    { upgrade = false } = {},
  ) {
    if (!(await this.ensureReady())) {
      console.error(
        `❌ Email service not initialized — beneficiary ping to ${tag(recipientEmail)} NOT sent.`,
      );
      return false;
    }

    const { subject, html, text } = this.buildBeneficiaryPingContent(
      operatorEmail,
      code,
      firstContact,
      { upgrade },
    );

    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      replyTo: this._routineFromAddress(),
      to: recipientEmail,
      subject,
      html,
      text,
    };

    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(
        `✅ Beneficiary liveness ping sent to ${tag(recipientEmail)}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send beneficiary ping to ${tag(recipientEmail)}:`,
        error,
      );
      return false;
    }
  }

  // The beneficiary answered with their code — tell the operator the line of
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
        `❌ Email service not initialized — stand-down notice to ${tag(recipientEmail)} NOT sent.`,
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
        `✅ Stand-down notice sent to ${tag(recipientEmail)}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to send stand-down notice to ${tag(recipientEmail)}:`,
        error,
      );
      return false;
    }
  }

  // One-line receipt answering a reply. Threaded onto the reader's message
  // when its Message-ID is known so it lands under their own reply. Never
  // sent to unrecognised mail — see handleInbound; that is how auto-reply
  // loops start.
  async sendReceipt(to, subject, text, { inReplyTo = null, references = null } = {}) {
    if (!(await this.ensureReady())) {
      console.error(`❌ Email service not initialized — receipt to ${tag(to)} NOT sent.`);
      return false;
    }
    const esc = (v) =>
      String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const mailOptions = {
      from: `"Deploy Deadman Switch" <${this._routineFromAddress()}>`,
      replyTo: this._routineFromAddress(),
      to,
      subject,
      text: `${text}\n`,
      html: `<p>${esc(text)}</p>`,
    };
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = references || inReplyTo;
    }
    try {
      const { info } = await this._sendWithFallback(mailOptions);
      console.log(`✅ Receipt sent to ${tag(to)}: ${subject}`, info.messageId);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send receipt to ${tag(to)}:`, error);
      return false;
    }
  }

  // Deploy cannot read its own mailbox, so a reply from this operator would
  // go unseen. Email FIRST — an IMAP failure rarely coincides with an SMTP
  // failure — and ntfy only in addition (the caller does that). Repeated
  // daily by the caller while the condition persists.
  //   notConfigured: no IMAP settings at all (custom SMTP without IMAP)
  //   capExpired:    the 7-day fail-safe hold has run out; normal timing
  //                  has resumed and the switch can now fire on schedule
  async sendInboundDownAlert(
    operatorEmail,
    downSince,
    { notConfigured = false, capExpired = false, error = null } = {},
  ) {
    const since =
      downSince instanceof Date
        ? downSince
        : downSince
          ? new Date(downSince)
          : null;
    const sinceText =
      since && !isNaN(since.getTime()) ? `since ${dateStamp(since)}` : "";
    const whyHtml = notConfigured
      ? `<p>No IMAP (incoming mail) settings are configured, so Deploy has no
         way to read the replies to its check-in emails.</p>`
      : `<p>Deploy has not been able to read its mailbox ${sinceText}${error ? ` (last error: <code>${String(error).replace(/</g, "&lt;")}</code>)` : ""}.</p>`;
    const whyText = notConfigured
      ? `No IMAP (incoming mail) settings are configured, so Deploy has no way to read the replies to its check-in emails.`
      : `Deploy has not been able to read its mailbox ${sinceText}${error ? ` (last error: ${error})` : ""}.`;
    const holdHtml = notConfigured
      ? `<p>Your switch keeps running on its normal schedule. Until this is
         fixed there is no way to check in: configure IMAP, or abort the
         switch from the dashboard.</p>`
      : capExpired
        ? `<p><strong>The 7-day safety hold has run out.</strong> The switch has
           resumed its normal timing: if you do not check in, the warning and
           the trigger will now go out on schedule.</p>`
        : `<p>As a safety measure, the pre-fire warning and the trigger are
           <strong>held</strong> while this lasts (for at most 7 days), so the
           switch cannot fire on a reply it could not read. Missed check-ins
           are still being counted. Fix the mail settings, or abort the switch
           from the dashboard, before the hold runs out.</p>`;
    const holdText = notConfigured
      ? `Your switch keeps running on its normal schedule. Until this is fixed there is no way to check in: configure IMAP, or abort the switch from the dashboard.`
      : capExpired
        ? `THE 7-DAY SAFETY HOLD HAS RUN OUT. The switch has resumed its normal timing: if you do not check in, the warning and the trigger will now go out on schedule.`
        : `As a safety measure, the pre-fire warning and the trigger are HELD while this lasts (for at most 7 days), so the switch cannot fire on a reply it could not read. Missed check-ins are still being counted. Fix the mail settings, or abort the switch from the dashboard, before the hold runs out.`;

    return this.sendAlertEmail(
      operatorEmail,
      `WARNING: your Deploy replies are not being received — ${dateStamp()}`,
      `<h2>Your check-in replies are not being received</h2>
       ${whyHtml}
       <p><strong>Fix the mail settings, or abort the switch.</strong>
       Replying to check-in emails will not work until this is resolved.</p>
       ${holdHtml}
       <p><small>This alert repeats daily while the problem persists. Automated message from Deploy Deadman Switch.</small></p>`,
      `Your check-in replies are not being received

${whyText}

FIX THE MAIL SETTINGS, OR ABORT THE SWITCH. Replying to check-in emails will not work until this is resolved.

${holdText}

This alert repeats daily while the problem persists. Automated message from Deploy Deadman Switch.`,
    );
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
emailService.dateStamp = dateStamp;

module.exports = emailService;
