const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const emailService = require("../utils/emailService");

// Production mode - user-selected intervals are used
const TEST_MODE = false;

// Helper function to get interval in milliseconds based on user selection
function getIntervalMs(intervalValue) {
  switch (intervalValue) {
    case "1-minute":
      return 1 * 60 * 1000; // 1 minute (testing)
    case "2-hours":
      return 2 * 60 * 60 * 1000; // 2 hours
    case "2-days":
      return 2 * 24 * 60 * 60 * 1000; // 2 days
    case "2-weeks":
      return 2 * 7 * 24 * 60 * 60 * 1000; // 2 weeks
    default:
      return 2 * 60 * 60 * 1000; // Default to 2 hours
  }
}

// Helper function to get inactivity period in milliseconds based on user selection
function getInactivityMs(periodValue) {
  switch (periodValue) {
    case "3-minutes":
      return 3 * 60 * 1000; // 3 minutes (testing)
    case "1-day":
      return 24 * 60 * 60 * 1000; // 1 day
    case "1-month":
      return 30 * 24 * 60 * 60 * 1000; // 1 month (30 days)
    case "3-months":
      return 3 * 30 * 24 * 60 * 60 * 1000; // 3 months
    case "6-months":
      return 6 * 30 * 24 * 60 * 60 * 1000; // 6 months
    case "9-months":
      return 9 * 30 * 24 * 60 * 60 * 1000; // 9 months
    default:
      return 24 * 60 * 60 * 1000; // Default to 1 day
  }
}

// Store active deadman switches
const activeDeadmanSwitches = new Map();

// Store check-in tokens (token -> userEmail mapping)
const checkinTokens = new Map();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, process.env.SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Simple test route
router.get("/test", (req, res) => {
  res.json({ message: "Minimal deadman routes working!" });
});

// Test status endpoint
router.get("/test-status", authenticateToken, (req, res) => {
  res.json({
    testMode: TEST_MODE,
    message: TEST_MODE ? "Test mode is active" : "Test mode is inactive",
  });
});

// Store user emails (in memory for now)
const userEmails = new Map();

// Store deadman activation history to track triggered state
const deadmanActivationHistory = new Map();

// Emails endpoint - save/update email data
router.post("/emails", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const { emailAddress, emailContent, emailIndex } = req.body;

    // Get existing emails for this user
    const existingEmails = userEmails.get(userEmail) || [];

    if (emailIndex !== null && emailIndex >= 0) {
      // Update existing email
      existingEmails[emailIndex] = {
        address: emailAddress,
        content: emailContent,
        to: emailAddress,
        subject: "Important Message from " + userEmail,
        body: emailContent,
      };
    } else {
      // Add new email
      existingEmails.push({
        address: emailAddress,
        content: emailContent,
        to: emailAddress,
        subject: "Important Message from " + userEmail,
        body: emailContent,
      });
    }

    // Save back to storage
    userEmails.set(userEmail, existingEmails);

    res.json({
      success: true,
      message: "Email saved successfully",
      emailCount: existingEmails.length,
    });
  } catch (error) {
    console.error("Error saving email:", error);
    res.status(500).json({ message: "Failed to save email" });
  }
});

// Get emails endpoint
router.get("/emails", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const emails = userEmails.get(userEmail) || [];

    // If no emails in backend but user is requesting, sync from frontend will happen via POST
    res.json({
      success: true,
      emails: emails,
      syncInfo: {
        backendCount: emails.length,
        totalUsersWithEmails: userEmails.size,
        needsSync: emails.length === 0,
      },
    });
  } catch (error) {
    console.error("Error getting emails:", error);
    res.status(500).json({ message: "Failed to get emails" });
  }
});

// Activate deadman switch
router.post("/activate", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const { checkinMethod, checkinInterval, inactivityPeriod } = req.body;

    // Get emails from backend storage instead of request body
    const emails = userEmails.get(userEmail) || [];

    // Calculate timer intervals
    const checkinIntervalMs = getIntervalMs(checkinInterval);
    const inactivityMs = getInactivityMs(inactivityPeriod);

    // Store the deadman switch data
    const switchData = {
      userEmail,
      settings: {
        checkinMethod,
        checkinInterval,
        inactivityPeriod,
        emails,
      },
      lastActivity: new Date(),
      nextCheckinTime: new Date(Date.now() + checkinIntervalMs),
      checkinTimer: null,
      deadmanTimer: null,
    };

    // Set up check-in timer
    switchData.checkinTimer = setInterval(async () => {
      try {
        // Generate unique check-in token
        const checkinToken = crypto.randomBytes(32).toString("hex");
        checkinTokens.set(checkinToken, userEmail);

        // Send actual check-in email (non-blocking)
        emailService
          .sendCheckinEmail(userEmail, checkinToken)
          .then((emailSent) => {
            if (!emailSent) {
              console.error(`Failed to send check-in email to ${userEmail}`);
            }
          })
          .catch((error) => {
            console.error(
              `Error sending check-in email to ${userEmail}:`,
              error,
            );
          });

        // Update next check-in time
        switchData.nextCheckinTime = new Date(Date.now() + checkinIntervalMs);
      } catch (error) {
        console.error(`Error in check-in timer callback:`, error);
      }
    }, checkinIntervalMs);

    // Set up deadman timer
    switchData.deadmanTimer = setTimeout(async () => {
      try {
        // Send actual deadman emails (non-blocking)
        emailService
          .sendDeadmanEmails(userEmail, emails)
          .then((emailsSent) => {
            if (!emailsSent) {
              console.error(`Failed to send deadman emails for ${userEmail}`);
              // Still record activation even if email failed
              deadmanActivationHistory.set(userEmail, {
                triggered: true,
                timestamp: new Date().toISOString(),
                emailsSent: 0,
                reason: "inactivity_timeout",
                status: "email_failed",
              });
            } else {
              // Record successful activation in history
              deadmanActivationHistory.set(userEmail, {
                triggered: true,
                timestamp: new Date().toISOString(),
                emailsSent: emails.length,
                reason: "inactivity_timeout",
                status: "success",
              });
            }
          })
          .catch((error) => {
            console.error(
              `Error sending deadman emails for ${userEmail}:`,
              error,
            );
            // Record activation even if error occurred
            deadmanActivationHistory.set(userEmail, {
              triggered: true,
              timestamp: new Date().toISOString(),
              emailsSent: 0,
              reason: "inactivity_timeout",
              status: "error",
              error: error.message,
            });
          });

        // Clean up after activation (do cleanup immediately)
        // Clear check-in timer to stop further check-in emails
        const switchData = activeDeadmanSwitches.get(userEmail);
        if (switchData && switchData.checkinTimer) {
          clearInterval(switchData.checkinTimer);
        }

        // Record activation immediately (before email result)
        deadmanActivationHistory.set(userEmail, {
          triggered: true,
          timestamp: new Date().toISOString(),
          emailsSent: emails.length,
          reason: "inactivity_timeout",
          status: "pending",
        });

        // Clear all user data after deadman activation
        userEmails.delete(userEmail);

        // Clear any check-in tokens for this user
        const tokensToDelete = [];
        for (const [token, email] of checkinTokens.entries()) {
          if (email === userEmail) {
            tokensToDelete.push(token);
          }
        }
        tokensToDelete.forEach((token) => checkinTokens.delete(token));

        activeDeadmanSwitches.delete(userEmail);
      } catch (error) {
        console.error(`Error in deadman timer callback:`, error);
      }
    }, inactivityMs);

    // Store the active switch
    activeDeadmanSwitches.set(userEmail, switchData);

    res.status(200).json({
      success: true,
      message: "Deadman switch activated successfully",
      testMode: TEST_MODE,
      settings: {
        checkinIntervalMinutes: checkinIntervalMs / 1000 / 60,
        deadmanTimerMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error("Error activating deadman switch:", error);
    res.status(500).json({ message: "Failed to activate deadman switch" });
  }
});

// Deactivate deadman switch
router.post("/deactivate", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;

    if (!activeDeadmanSwitches.has(userEmail)) {
      return res.status(400).json({
        message: "No active deadman switch found for this user",
      });
    }

    // Get the active switch data
    const switchData = activeDeadmanSwitches.get(userEmail);

    // Clear all timers
    if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
    if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);

    // Remove from active switches
    activeDeadmanSwitches.delete(userEmail);

    res.status(200).json({
      success: true,
      message: "Deadman switch deactivated successfully",
    });
  } catch (error) {
    console.error("Error deactivating deadman switch:", error);
    res.status(500).json({ message: "Failed to deactivate deadman switch" });
  }
});

// Activity logging endpoint
router.post("/activity", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    res.status(200).json({
      success: true,
      message: "Activity logged successfully",
    });
  } catch (error) {
    console.error("Error logging activity:", error);
    res.status(500).json({ message: "Failed to log activity" });
  }
});

// Timer status endpoint - returns real backend timer values
router.get("/timer-status", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;

    if (!activeDeadmanSwitches.has(userEmail)) {
      return res.json({
        active: false,
        message: "No active deadman switch",
        nextCheckin: null,
        deadmanActivation: null,
        lastActivity: null,
        triggered: false,
      });
    }

    const switchData = activeDeadmanSwitches.get(userEmail);
    const now = Date.now();

    // Calculate when next check-in will happen
    const checkinInterval = getIntervalMs(
      switchData.settings.checkinInterval || "2-hours",
    );
    const nextCheckinTime = switchData.nextCheckinTime.getTime();

    // Calculate when deadman switch will activate
    const inactivityPeriod = getInactivityMs(
      switchData.settings.inactivityPeriod || "1-day",
    );
    const deadmanActivationTime =
      switchData.lastActivity.getTime() + inactivityPeriod;

    res.json({
      active: true,
      nextCheckin: Math.max(0, nextCheckinTime - now),
      deadmanActivation: Math.max(0, deadmanActivationTime - now),
      lastActivity: switchData.lastActivity.toISOString(),
      testMode: TEST_MODE,
      triggered: false,
    });
  } catch (error) {
    console.error("Error getting timer status:", error);
    res.status(500).json({ message: "Failed to get timer status" });
  }
});

// New endpoint to check if deadman was triggered for user
router.get("/deadman-status", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;

    // Check activation history first (most reliable)
    const activationHistory = deadmanActivationHistory.get(userEmail);
    if (activationHistory && activationHistory.triggered) {
      return res.json({
        triggered: true,
        message:
          "Deadman switch has been activated - beneficiary emails were sent",
        canReset: true,
        activationTime: activationHistory.timestamp,
        emailsSent: activationHistory.emailsSent,
      });
    }

    // Check if user has an active deadman switch
    const hasActiveSwitch = activeDeadmanSwitches.has(userEmail);
    if (hasActiveSwitch) {
      return res.json({
        triggered: false,
        message: "Deadman switch is active and running",
        canReset: false,
      });
    }

    // No active switch and no activation history = never activated
    res.json({
      triggered: false,
      message: "No deadman switch configured",
      canReset: false,
    });
  } catch (error) {
    console.error("Error checking deadman status:", error);
    res.status(500).json({ message: "Failed to check deadman status" });
  }
});

// Simple activation function (DISABLED IN PRODUCTION)
router.post("/activate-simple", (req, res) => {
  if (!TEST_MODE) {
    return res.status(403).json({
      message: "Simple activation not available in production mode",
    });
  }

  try {
    // Set 2-minute deadman timer
    const deadmanTimer = setTimeout(
      () => {
        // Test deadman activation
      },
      2 * 60 * 1000,
    );

    // Set 1-minute check-in timer
    const checkinTimer = setInterval(
      () => {
        // Test check-in reminder
      },
      1 * 60 * 1000,
    );

    res.json({
      success: true,
      message:
        "Simple activation successful: 2-minute deadman timer, 1-minute check-ins",
      deadmanMinutes: 2,
      checkinMinutes: 1,
    });
  } catch (error) {
    console.error("Error in simple activation:", error);
    res.status(500).json({ message: "Simple activation failed" });
  }
});

// Debug endpoint to check backend state
router.get("/debug/status", (req, res) => {
  const switches = [];
  for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
    switches.push({
      userEmail,
      lastActivity: switchData.lastActivity,
      hasCheckinTimer: !!switchData.checkinTimer,
      hasDeadmanTimer: !!switchData.deadmanTimer,
      settings: switchData.settings,
    });
  }

  res.json({
    testMode: TEST_MODE,
    activeDeadmanSwitches: switches,
    userEmailsCount: userEmails.size,
    checkinTokensCount: checkinTokens.size,
    timestamp: new Date().toISOString(),
  });
});

// Email test endpoint
router.post("/debug/test-email", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // Test email service connection
    const connectionTest = await emailService.testEmailConnection();

    if (!connectionTest.success) {
      return res.json({
        success: false,
        message: "Email service connection failed",
        error: connectionTest.message,
      });
    }

    // Test sending a check-in email
    const testToken = "test-token-123";
    const emailSent = await emailService.sendCheckinEmail(userEmail, testToken);

    res.json({
      success: emailSent,
      message: emailSent
        ? "Test email sent successfully"
        : "Failed to send test email",
      connectionTest: connectionTest,
    });
  } catch (error) {
    console.error("Email test error:", error);
    res.status(500).json({
      success: false,
      message: "Email test failed",
      error: error.message,
    });
  }
});

// Reset endpoint to clear deadman data after activation
router.post("/reset", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;

    // Clear any active deadman switch
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
    }

    // Clear stored emails
    if (userEmails.has(userEmail)) {
      userEmails.delete(userEmail);
    }

    // Clear activation history
    if (deadmanActivationHistory.has(userEmail)) {
      deadmanActivationHistory.delete(userEmail);
    }

    // Clear any check-in tokens for this user
    const tokensToDelete = [];
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        tokensToDelete.push(token);
      }
    }
    tokensToDelete.forEach((token) => checkinTokens.delete(token));

    res.json({
      success: true,
      message: "Deadman switch data has been reset successfully",
      cleared: {
        activeSwitch: true,
        emails: true,
        activationHistory: true,
        tokens: tokensToDelete.length,
      },
    });
  } catch (error) {
    console.error("Error resetting deadman data:", error);
    res.status(500).json({
      message: "Failed to reset deadman data",
      error: error.message,
    });
  }
});

// Admin endpoint to wipe all user data (DISABLED IN PRODUCTION)
router.post("/admin/wipe-all-data", (req, res) => {
  if (!TEST_MODE) {
    return res.status(403).json({
      message: "Data wipe not available in production mode",
    });
  }

  try {
    // Clear all active deadman switches
    for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
    }
    activeDeadmanSwitches.clear();

    res.json({
      success: true,
      message: "All user data has been wiped successfully",
      clearedDeadmanSwitches: true,
    });
  } catch (error) {
    console.error("Error wiping user data:", error);
    res.status(500).json({
      message: "Failed to wipe user data",
      error: error.message,
    });
  }
});

// Check-in endpoint - handles check-in link clicks
router.get("/checkin/:token", (req, res) => {
  try {
    const { token } = req.params;

    if (!checkinTokens.has(token)) {
      return res.status(400).send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h2>❌ Invalid Check-In Link</h2>
            <p>This check-in link is invalid or has expired.</p>
            <p>Please use the latest check-in email.</p>
          </body>
        </html>
      `);
    }

    const userEmail = checkinTokens.get(token);

    // Update activity time and reset both timers
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      switchData.lastActivity = new Date();

      // Reset check-in timer
      if (switchData.checkinTimer) {
        clearInterval(switchData.checkinTimer);
      }

      // Reset deadman timer
      if (switchData.deadmanTimer) {
        clearTimeout(switchData.deadmanTimer);
      }

      // Recreate check-in timer
      const checkinIntervalMs = getIntervalMs(
        switchData.settings.checkinInterval,
      );
      switchData.nextCheckinTime = new Date(Date.now() + checkinIntervalMs);
      switchData.checkinTimer = setInterval(async () => {
        try {
          const checkinToken = crypto.randomBytes(32).toString("hex");
          checkinTokens.set(checkinToken, userEmail);

          emailService
            .sendCheckinEmail(userEmail, checkinToken)
            .then((emailSent) => {
              if (!emailSent) {
                console.error(`Failed to send check-in email to ${userEmail}`);
              }
            })
            .catch((error) => {
              console.error(
                `Error sending check-in email to ${userEmail}:`,
                error,
              );
            });

          // Update next check-in time
          switchData.nextCheckinTime = new Date(Date.now() + checkinIntervalMs);
        } catch (error) {
          console.error(`Error in check-in timer callback:`, error);
        }
      }, checkinIntervalMs);

      // Recreate deadman timer
      const inactivityMs = getInactivityMs(
        switchData.settings.inactivityPeriod,
      );
      switchData.deadmanTimer = setTimeout(async () => {
        try {
          const emails = userEmails.get(userEmail) || [];
          // Record activation immediately (before email sending)
          deadmanActivationHistory.set(userEmail, {
            triggered: true,
            timestamp: new Date().toISOString(),
            emailsSent: emails.length,
            reason: "inactivity_timeout",
            status: "pending",
          });

          emailService
            .sendDeadmanEmails(userEmail, emails)
            .then((emailsSent) => {
              if (!emailsSent) {
                console.error(`Failed to send deadman emails for ${userEmail}`);
                // Update activation history with failure status
                deadmanActivationHistory.set(userEmail, {
                  triggered: true,
                  timestamp: new Date().toISOString(),
                  emailsSent: 0,
                  reason: "inactivity_timeout",
                  status: "email_failed",
                });
              } else {
                // Update activation history with success status
                deadmanActivationHistory.set(userEmail, {
                  triggered: true,
                  timestamp: new Date().toISOString(),
                  emailsSent: emails.length,
                  reason: "inactivity_timeout",
                  status: "success",
                });
              }
            })
            .catch((error) => {
              console.error(
                `Error sending deadman emails for ${userEmail}:`,
                error,
              );
              // Update activation history with error status
              deadmanActivationHistory.set(userEmail, {
                triggered: true,
                timestamp: new Date().toISOString(),
                emailsSent: 0,
                reason: "inactivity_timeout",
                status: "error",
                error: error.message,
              });
            });

          // Clean up after activation (do cleanup immediately)
          // Clear check-in timer to stop further check-in emails
          const switchData = activeDeadmanSwitches.get(userEmail);
          if (switchData && switchData.checkinTimer) {
            clearInterval(switchData.checkinTimer);
          }

          // Clear all user data after deadman activation
          userEmails.delete(userEmail);

          // Clear any check-in tokens for this user
          const tokensToDelete = [];
          for (const [token, email] of checkinTokens.entries()) {
            if (email === userEmail) {
              tokensToDelete.push(token);
            }
          }
          tokensToDelete.forEach((token) => checkinTokens.delete(token));

          activeDeadmanSwitches.delete(userEmail);
        } catch (error) {
          console.error(`Error in deadman timer callback:`, error);
        }
      }, inactivityMs);
    }

    // Remove used token
    checkinTokens.delete(token);

    // Send success response
    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>✅ Check-In Successful!</h2>
          <p>Thank you for checking in.</p>
          <p>Your deadman switch timer has been reset.</p>
          <p>Last activity: ${new Date().toLocaleString()}</p>
          <hr>
          <p><small>You can close this window now.</small></p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error processing check-in:", error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>❌ Check-In Error</h2>
          <p>An error occurred while processing your check-in.</p>
          <p>Please try again or contact support.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;
