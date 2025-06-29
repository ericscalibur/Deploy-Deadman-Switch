const nodemailer = require("nodemailer");

// Email service for sending check-in and deadman emails
class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
    this.init();
  }

  async init() {
    try {
      console.log("Initializing email service...");

      // For testing, use Ethereal Email (fake SMTP service)
      // In production, you'd use real SMTP credentials
      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        console.log("Using Gmail SMTP configuration");
        // Gmail SMTP configuration
        this.transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });
      } else if (
        process.env.SMTP_HOST &&
        process.env.SMTP_USER &&
        process.env.SMTP_PASS
      ) {
        console.log("Using production SMTP configuration");
        // Production SMTP configuration
        this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT || 587,
          secure: false, // true for 465, false for other ports
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });
      } else {
        console.log("Using Ethereal test email configuration");
        // Test configuration using Ethereal Email
        const testAccount = await nodemailer.createTestAccount();
        console.log("Test account created:", testAccount.user);

        this.transporter = nodemailer.createTransport({
          host: "smtp.ethereal.email",
          port: 587,
          secure: false,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass,
          },
        });
      }

      // Verify the connection
      await this.transporter.verify();
      this.initialized = true;
      console.log("✅ Email service initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize email service:", error);
      this.initialized = false;
    }
  }

  async sendCheckinEmail(userEmail, checkinToken) {
    if (!this.initialized) {
      console.log("❌ Email service not initialized");
      return false;
    }

    try {
      const checkinUrl = `${process.env.APP_URL || "http://localhost:3000"}/deadman/checkin/${checkinToken}`;
      console.log(`📧 Sending check-in email to ${userEmail}`);

      const mailOptions = {
        from: `"Deploy Deadman Switch" <${process.env.EMAIL_USER || "noreply@deploy-deadman.com"}>`,
        to: userEmail,
        subject: "🔔 Deploy Check-In Required",
        html: `
          <h2>🔔 Check-In Required</h2>
          <p>Hello,</p>
          <p>This is your scheduled check-in from Deploy Deadman Switch service.</p>
          <p><strong>Click the link below to confirm you're active:</strong></p>
          <p><a href="${checkinUrl}" style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">✅ I'm Active - Reset Timer</a></p>
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

Click the link below to confirm you're active:
${checkinUrl}

If you don't respond to check-ins, your deadman switch will activate and send your configured emails.

This is an automated message from Deploy Deadman Switch.
        `,
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(
        `✅ Check-in email sent successfully to ${userEmail}`,
        info.messageId,
      );
      return true;
    } catch (error) {
      console.error(`❌ Failed to send check-in email to ${userEmail}:`, error);
      return false;
    }
  }

  async sendDeadmanEmails(userEmail, configuredEmails) {
    if (!this.initialized) {
      console.log("❌ Email service not initialized for deadman emails");
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

        const mailOptions = {
          from: `"${userEmail}" <noreply@deploy-deadman.com>`,
          to: recipientEmail,
          subject: email.subject || `Important Message from ${userEmail}`,
          html: `
            <h2>🚨 Important Message</h2>
            <p>This message was automatically sent by Deploy Deadman Switch because ${userEmail} did not respond to check-ins.</p>
            <hr>
            <div style="border-left: 4px solid #007bff; padding-left: 15px; margin: 20px 0;">
              ${email.body || email.content || "No message content provided."}
            </div>
            <hr>
            <p><small>This message was sent automatically by Deploy Deadman Switch service.</small></p>
            <p><small>Original sender: ${userEmail}</small></p>
          `,
          text: `
Important Message

This message was automatically sent by Deploy Deadman Switch because ${userEmail} did not respond to check-ins.

---

${email.body || email.content || "No message content provided."}

---

This message was sent automatically by Deploy Deadman Switch service.
Original sender: ${userEmail}
          `,
        };

        try {
          const info = await this.transporter.sendMail(mailOptions);
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

  async testEmailConnection() {
    if (!this.initialized) {
      return { success: false, message: "Email service not initialized" };
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
