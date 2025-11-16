const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const emailService = require("../utils/emailService");
const UserService = require("../database/userService");

// Helper function to get interval in milliseconds based on user selection
function getIntervalMs(intervalValue) {
  if (!intervalValue) {
    return 2 * 60 * 60 * 1000; // Default to 2 hours
  }

  // Handle legacy format for backward compatibility
  switch (intervalValue) {
    case "1-minute":
      return 1 * 60 * 1000;
    case "2-hours":
      return 2 * 60 * 60 * 1000;
    case "2-days":
      return 2 * 24 * 60 * 60 * 1000;
    case "2-weeks":
      return 2 * 7 * 24 * 60 * 60 * 1000;
  }

  // Handle new custom format: "value-unit"
  const parts = intervalValue.split("-");

  if (parts.length !== 2) {
    return 2 * 60 * 60 * 1000; // Default
  }

  const value = parseInt(parts[0], 10);
  const unit = parts[1];

  if (isNaN(value) || value < 1) {
    return 2 * 60 * 60 * 1000; // Default
  }

  const multipliers = {
    minute: 60 * 1000,
    minutes: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };

  const ms = value * (multipliers[unit] || multipliers.hours);

  // Validation limits for check-in intervals
  const MIN_INTERVAL = 1 * 60 * 1000; // 1 minute minimum
  const MAX_INTERVAL = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weeks maximum

  if (ms < MIN_INTERVAL || ms > MAX_INTERVAL) {
    return 2 * 60 * 60 * 1000; // Default to 2 hours
  }

  return ms;
}

// Helper function to get inactivity period in milliseconds based on user selection
function getInactivityMs(periodValue) {
  if (!periodValue) return 24 * 60 * 60 * 1000; // Default to 1 day

  // Handle legacy format for backward compatibility
  switch (periodValue) {
    case "2-minutes":
      return 2 * 60 * 1000;
    case "12-hours":
      return 12 * 60 * 60 * 1000;
    case "1-day":
      return 24 * 60 * 60 * 1000;
    case "3-days":
      return 3 * 24 * 60 * 60 * 1000;
    case "1-week":
      return 7 * 24 * 60 * 60 * 1000;
    case "1-month":
      return 30 * 24 * 60 * 60 * 1000;
  }

  // Handle new custom format: "value-unit"
  const parts = periodValue.split("-");
  if (parts.length !== 2) return 24 * 60 * 60 * 1000; // Default

  const value = parseInt(parts[0], 10);
  const unit = parts[1];

  if (isNaN(value) || value < 1) return 24 * 60 * 60 * 1000; // Default

  const multipliers = {
    minute: 60 * 1000,
    minutes: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
  };

  const ms = value * (multipliers[unit] || multipliers.days);

  // Validation limits for inactivity periods
  const MIN_INACTIVITY = 1 * 60 * 1000; // 1 minute minimum
  const MAX_INACTIVITY = 12 * 30 * 24 * 60 * 60 * 1000; // 12 months maximum

  if (ms < MIN_INACTIVITY || ms > MAX_INACTIVITY) {
    console.warn(
      `Inactivity period ${periodValue} out of range, using default`,
    );
    return 24 * 60 * 60 * 1000; // Default to 1 day
  }

  return ms;
}

// Initialize database service
const userService = new UserService();

// Initialize database connection
userService.connect().catch(console.error);

// In-memory cache for active sessions (will be replaced by database queries)
const activeDeadmanSwitches = new Map();
const checkinTokens = new Map();

// Recovery mechanism: Restore active switches from database on startup
async function recoverActiveDeadmanSwitches() {
  try {
    console.log(
      "🔄 RECOVERY: Checking for active deadman switches in database...",
    );

    const activeSessions = await userService.getAllActiveSessions();
    console.log(
      `🔍 RECOVERY: Found ${activeSessions.length} active sessions in database`,
    );

    for (const session of activeSessions) {
      try {
        console.log(
          `🔄 RECOVERY: Restoring deadman switch for ${session.email}`,
        );

        // Get user data to restore emails and settings
        const user = await userService.getUserById(session.user_id);
        if (!user) {
          console.error(
            `❌ RECOVERY: User not found for session ${session.session_token}`,
          );
          continue;
        }

        // For recovery, we need to get the user data, but we don't have the password
        // So we'll store essential info in the session and recover what we can
        const now = Date.now();
        const checkinIntervalMs = session.checkin_interval_ms;
        const inactivityMs = session.inactivity_timeout_ms;

        // Calculate remaining time based on last activity
        const lastActivity = new Date(session.last_activity).getTime();
        const deadmanExpiry = new Date(session.expires_at).getTime();
        const timeRemaining = deadmanExpiry - now;

        if (timeRemaining <= 0) {
          console.log(
            `⚠️ RECOVERY: Session for ${session.email} has expired, marking as triggered`,
          );
          await userService.markSessionTriggered(session.session_token);
          continue;
        }

        // Create switch data for recovery
        const switchData = {
          userEmail: session.email,
          userId: session.user_id,
          sessionToken: session.session_token,
          settings: {
            checkinInterval: getIntervalName(checkinIntervalMs),
            inactivityPeriod: getInactivityName(inactivityMs),
            emails: [], // Will be populated when user provides password
          },
          lastActivity: new Date(session.last_activity),
          nextCheckin: now + checkinIntervalMs,
          deadmanActivation: deadmanExpiry,
          checkinTimer: null,
          deadmanTimer: null,
          recovered: true, // Flag to indicate this was recovered
        };

        // Set up check-in timer
        switchData.checkinTimer = setInterval(async () => {
          try {
            console.log(
              `🔍 PERIODIC CHECK-IN: Timer fired for ${session.email} (recovered)`,
            );

            if (!activeDeadmanSwitches.has(session.email)) {
              console.log(
                `⚠️ PERIODIC CHECK-IN: Deadman switch no longer active for ${session.email}, stopping timer`,
              );
              clearInterval(switchData.checkinTimer);
              return;
            }

            const checkinToken = crypto.randomBytes(32).toString("hex");
            checkinTokens.set(checkinToken, session.email);

            if (switchData.sessionToken) {
              try {
                await userService.updateSessionActivity(
                  switchData.sessionToken,
                );
              } catch (error) {
                console.error(
                  `Failed to update session activity during recovered check-in for ${session.email}:`,
                  error,
                );
              }
            }

            emailService
              .sendCheckinEmail(session.email, checkinToken)
              .then((emailSent) => {
                if (!emailSent) {
                  console.error(
                    `❌ PERIODIC CHECK-IN: Failed to send recovered check-in email to ${session.email}`,
                  );
                } else {
                  console.log(
                    `✅ PERIODIC CHECK-IN: Recovered email sent successfully to ${session.email}`,
                  );
                }
              })
              .catch((error) => {
                console.error(
                  `❌ PERIODIC CHECK-IN: Error sending recovered check-in email to ${session.email}:`,
                  error,
                );
              });

            const nextCheckinNow = Date.now();
            switchData.nextCheckinTime = new Date(
              nextCheckinNow + checkinIntervalMs,
            );
            switchData.nextCheckin = nextCheckinNow + checkinIntervalMs;
            console.log(
              `📧 PERIODIC CHECK-IN: Recovered email sent for ${session.email}, next check-in in ${checkinIntervalMs / 1000 / 60} minutes`,
            );
          } catch (error) {
            console.error(
              `❌ PERIODIC CHECK-IN: Critical error in recovered timer callback for ${session.email}:`,
              error,
            );
          }
        }, checkinIntervalMs);

        // Set up deadman timer for remaining time with large timeout support
        const MAX_TIMEOUT = 2147483647; // Max setTimeout value

        if (timeRemaining <= MAX_TIMEOUT) {
          // Standard setTimeout for periods <= 24.8 days
          switchData.deadmanTimer = setTimeout(async () => {
            await executeDeadmanActivationRecovered(session.email, switchData);
          }, timeRemaining);
        } else {
          // For longer periods, use interval checking
          console.log(
            `⚠️ LARGE TIMEOUT RECOVERY: Using interval checking for ${session.email} (${timeRemaining}ms > ${MAX_TIMEOUT}ms)`,
          );

          switchData.deadmanTimer = setInterval(async () => {
            const now = Date.now();
            const currentTimeRemaining = switchData.deadmanActivation - now;

            console.log(
              `🔍 LARGE TIMEOUT RECOVERY CHECK: ${session.email} - ${currentTimeRemaining}ms remaining`,
            );

            if (currentTimeRemaining <= 0) {
              // Time has expired, trigger deadman
              clearInterval(switchData.deadmanTimer);
              await executeDeadmanActivationRecovered(
                session.email,
                switchData,
              );
            }
          }, 60000); // Check every minute for large timeouts
        }

        // Store the recovered switch
        activeDeadmanSwitches.set(session.email, switchData);

        console.log(
          `✅ RECOVERY: Successfully restored deadman switch for ${session.email} (${timeRemaining / 1000 / 60} minutes remaining)`,
        );
      } catch (error) {
        console.error(
          `❌ RECOVERY: Failed to restore session for ${session.email}:`,
          error,
        );
      }
    }

    console.log(
      `✅ RECOVERY: Recovery complete, restored ${activeSessions.length} deadman switches`,
    );
  } catch (error) {
    console.error("❌ RECOVERY: Failed to recover active switches:", error);
  }
}

// Helper function for recovered deadman activation
async function executeDeadmanActivationRecovered(userEmail, switchData) {
  try {
    console.log(
      `🚨 DEADMAN TIMER EXPIRED: Activating for ${userEmail} (recovered)`,
    );

    // Get emails if available
    let emails = userEmails.get(userEmail) || [];
    if (emails.length === 0) {
      console.log(
        `⚠️ DEADMAN ACTIVATION: No emails in memory for ${userEmail}, attempting recovery requires user password`,
      );
    }

    if (emails.length > 0) {
      emailService
        .sendDeadmanEmails(userEmail, emails)
        .then((emailsSent) => {
          if (emailsSent) {
            console.log(
              `✅ DEADMAN EMAILS SUCCESS: Emails sent for ${userEmail} (recovered)`,
            );
          } else {
            console.error(
              `❌ DEADMAN EMAILS FAILED: No emails sent for ${userEmail} (recovered)`,
            );
          }
        })
        .catch((error) => {
          console.error(
            `❌ DEADMAN EMAILS ERROR: Failed to send emails for ${userEmail} (recovered):`,
            error,
          );
        });
    }

    // Mark session as triggered
    await userService.markSessionTriggered(switchData.sessionToken);

    // Cleanup
    const currentSwitchData = activeDeadmanSwitches.get(userEmail);
    if (currentSwitchData && currentSwitchData.checkinTimer) {
      clearInterval(currentSwitchData.checkinTimer);
    }

    userEmails.delete(userEmail);
    const tokensToDelete = [];
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        tokensToDelete.push(token);
      }
    }
    tokensToDelete.forEach((token) => checkinTokens.delete(token));
    activeDeadmanSwitches.delete(userEmail);

    console.log(
      `✅ DEADMAN CLEANUP: All timers and data cleared for ${userEmail} (recovered)`,
    );
  } catch (error) {
    console.error(
      `Error in recovered deadman timer callback for ${userEmail}:`,
      error,
    );
  }
}

// Helper functions to convert milliseconds back to interval names
function getIntervalName(ms) {
  // Convert milliseconds to best-fit interval name
  const units = [
    { name: "weeks", ms: 7 * 24 * 60 * 60 * 1000 },
    { name: "days", ms: 24 * 60 * 60 * 1000 },
    { name: "hours", ms: 60 * 60 * 1000 },
    { name: "minutes", ms: 60 * 1000 },
  ];

  for (const unit of units) {
    if (ms >= unit.ms && ms % unit.ms === 0) {
      const value = ms / unit.ms;
      return `${value}-${unit.name}`;
    }
  }

  // Fallback to hours
  const hours = Math.round(ms / (60 * 60 * 1000));
  return `${hours}-hours`;
}

function getInactivityName(ms) {
  // Convert milliseconds to best-fit interval name
  const units = [
    { name: "months", ms: 30 * 24 * 60 * 60 * 1000 },
    { name: "weeks", ms: 7 * 24 * 60 * 60 * 1000 },
    { name: "days", ms: 24 * 60 * 60 * 1000 },
    { name: "hours", ms: 60 * 60 * 1000 },
    { name: "minutes", ms: 60 * 1000 },
  ];

  for (const unit of units) {
    if (ms >= unit.ms && ms % unit.ms === 0) {
      const value = ms / unit.ms;
      return `${value}-${unit.name}`;
    }
  }

  // Fallback to days
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return `${days}-days`;
}

// Initialize recovery on startup with delay to ensure database is ready
setTimeout(() => {
  recoverActiveDeadmanSwitches();
}, 2000);

// Periodic state saving for crash protection
const SAVE_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes
setInterval(async () => {
  try {
    console.log(
      `💾 PERIODIC SAVE: Saving timer states for ${activeDeadmanSwitches.size} active switches`,
    );

    for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
      try {
        if (!switchData.recovered && switchData.userId) {
          await userService.saveTimerState(switchData.userId, {
            nextCheckin: switchData.nextCheckin,
            deadmanActivation: switchData.deadmanActivation,
            lastActivity: switchData.lastActivity,
          });
        }
      } catch (error) {
        console.error(
          `❌ PERIODIC SAVE: Failed to save state for ${userEmail}:`,
          error,
        );
      }
    }

    if (activeDeadmanSwitches.size > 0) {
      console.log(
        `✅ PERIODIC SAVE: Completed saving ${activeDeadmanSwitches.size} timer states`,
      );
    }
  } catch (error) {
    console.error(
      "❌ PERIODIC SAVE: Critical error during periodic save:",
      error,
    );
  }
}, SAVE_INTERVAL);

// Middleware to verify JWT token and load user data
const authenticateToken = async (req, res, next) => {
  // Try to get token from HTTP-only cookie first, then fallback to Authorization header
  const token =
    req.cookies.token ||
    (req.headers["authorization"] &&
      req.headers["authorization"].split(" ")[1]);

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, process.env.SECRET_KEY, async (err, user) => {
    if (err) return res.sendStatus(403);

    try {
      // Get user data from database
      const userData = await userService.getUserById(user.userId);
      if (!userData) {
        return res.sendStatus(403);
      }

      req.user = {
        ...user,
        userData,
      };
      next();
    } catch (error) {
      console.error("Error loading user data:", error);
      return res.sendStatus(500);
    }
  });
};

// Simple test route
router.get("/test", (req, res) => {
  res.json({ message: "Minimal deadman routes working!" });
});

// User signup endpoint (encrypted database)
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Create new user with encrypted data
    const userData = await userService.createUser(email, password, {
      emails: [],
      settings: {},
      checkinTokens: {},
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: userData.userId, email: userData.email },
      process.env.SECRET_KEY,
      { expiresIn: "24h" },
    );

    // Log audit event
    await userService.logAudit(
      userData.userId,
      "USER_SIGNUP",
      "User account created",
      req.ip,
      req.get("User-Agent"),
    );

    // Set HTTP-only cookie instead of sending token in response
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        id: userData.userId,
        email: userData.email,
      },
    });
  } catch (error) {
    console.error("Error creating user:", error);

    if (error.message === "User already exists") {
      return res.status(409).json({ message: "User already exists" });
    }

    res.status(500).json({ message: "Failed to create user" });
  }
});

// User logout endpoint
router.post("/logout", (req, res) => {
  // Clear the HTTP-only cookie
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });

  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

// User login endpoint (encrypted database)
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Authenticate user and get decrypted data
    const userData = await userService.authenticateUser(email, password);

    // Generate JWT token
    const token = jwt.sign(
      { userId: userData.userId, email: userData.email },
      process.env.SECRET_KEY,
      { expiresIn: "24h" },
    );

    // Log audit event
    await userService.logAudit(
      userData.userId,
      "USER_LOGIN",
      "User logged in",
      req.ip,
      req.get("User-Agent"),
    );

    // Set HTTP-only cookie instead of sending token in response
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      success: true,
      message: "Login successful",
      user: {
        id: userData.userId,
        email: userData.email,
        lastLogin: userData.lastLogin,
      },
    });
  } catch (error) {
    console.error("Error authenticating user:", error);

    if (error.message === "Invalid credentials") {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    res.status(500).json({ message: "Authentication failed" });
  }
});

// Legacy in-memory storage (being phased out for encrypted database)
const userEmails = new Map();
const deadmanActivationHistory = new Map();

// Emails endpoint - save/update email data (encrypted database)
router.post("/emails", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    const { emailAddress, emailContent, emailIndex } = req.body;

    // Get password from request (needed for decryption)
    const password = req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for encryption" });
    }

    // Get user's salt and current encrypted data
    const user = await userService.getUserById(userId);
    const currentData = await userService.getUserData(
      userId,
      password,
      user.salt,
    );

    let existingEmails = currentData.emails || [];

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

    // Update encrypted database
    await userService.updateUserData(userId, password, user.salt, {
      emails: existingEmails,
      settings: currentData.settings,
      checkinTokens: currentData.checkinTokens,
    });

    // Log audit event
    await userService.logAudit(
      userId,
      emailIndex !== null ? "EMAIL_UPDATED" : "EMAIL_ADDED",
      `Email ${emailIndex !== null ? "updated" : "added"}: ${emailAddress}`,
      req.ip,
      req.get("User-Agent"),
    );

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

// Get emails endpoint (encrypted database)
router.get("/emails", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get password from query params or body (needed for decryption)
    const password = req.query.password || req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for decryption" });
    }

    // Get user's salt and decrypt data
    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);

    const emails = userData.emails || [];

    res.json({
      success: true,
      emails: emails,
      syncInfo: {
        backendCount: emails.length,
        encrypted: true,
        needsSync: false,
      },
    });
  } catch (error) {
    console.error("Error getting emails:", error);
    res.status(500).json({ message: "Failed to get emails" });
  }
});

// Delete email by index (encrypted database)
router.delete("/emails/:index", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const emailIndex = parseInt(req.params.index);

    // Get password from request body (needed for decryption)
    const password = req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for encryption" });
    }

    // Validate email index
    if (isNaN(emailIndex) || emailIndex < 0) {
      return res.status(400).json({ message: "Invalid email index" });
    }

    // Get user's salt and current encrypted data
    const user = await userService.getUserById(userId);
    const currentData = await userService.getUserData(
      userId,
      password,
      user.salt,
    );

    let existingEmails = currentData.emails || [];

    // Check if email index exists
    if (emailIndex >= existingEmails.length) {
      return res.status(404).json({ message: "Email not found" });
    }

    // Remove email at specified index
    existingEmails.splice(emailIndex, 1);

    // Update encrypted database
    await userService.updateUserData(userId, password, user.salt, {
      emails: existingEmails,
      settings: currentData.settings,
      checkinTokens: currentData.checkinTokens,
    });

    // Log audit event
    await userService.logAudit(
      userId,
      "EMAIL_DELETED",
      `Email deleted at index ${emailIndex}`,
      req.ip,
    );

    res.json({
      message: "Email deleted successfully",
      remainingCount: existingEmails.length,
    });
  } catch (error) {
    console.error("Error deleting email:", error);
    res.status(500).json({ message: "Failed to delete email" });
  }
});

// Status endpoint to check if user is authenticated
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await userService.getUserById(userId);

    res.json({
      success: true,
      authenticated: true,
      user: {
        id: userId,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Error getting user status:", error);
    res.status(500).json({ message: "Failed to get user status" });
  }
});

// Timer status endpoint for countdown synchronization
router.get("/timer-status", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🔍 TIMER-STATUS: Request from ${userEmail}`);

    // Check if deadman switch is active for this user
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      const now = Date.now();

      console.log(`📊 TIMER-STATUS: Active switch found for ${userEmail}`);
      console.log(`   - Current time: ${now}`);
      console.log(`   - Next checkin: ${switchData.nextCheckin}`);
      console.log(`   - Deadman activation: ${switchData.deadmanActivation}`);
      console.log(`   - Last activity: ${switchData.lastActivity}`);
      console.log(
        `   - Time until next checkin: ${switchData.nextCheckin - now}ms`,
      );
      console.log(
        `   - Time until deadman: ${switchData.deadmanActivation - now}ms`,
      );

      res.json({
        success: true,
        active: true,
        lastActivity: switchData.lastActivity,
        nextCheckin: switchData.nextCheckin,
        deadmanActivation: switchData.deadmanActivation,
        settings: {
          checkinInterval: switchData.settings.checkinInterval,
          inactivityPeriod: switchData.settings.inactivityPeriod,
        },
      });
    } else {
      console.log(`❌ TIMER-STATUS: No active switch for ${userEmail}`);
      res.json({
        success: true,
        active: false,
      });
    }
  } catch (error) {
    console.error("Error getting timer status:", error);
    res.status(500).json({ message: "Failed to get timer status" });
  }
});

// Deadman status endpoint for checking if deadman was triggered
router.get("/deadman-status", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Check if deadman switch was triggered (would have been removed from activeDeadmanSwitches)
    const history = deadmanActivationHistory.get(userId);

    if (history && history.triggered) {
      res.json({
        success: true,
        triggered: true,
        triggeredAt: history.triggeredAt,
        emailsSent: history.emailsSent,
      });
    } else {
      res.json({
        success: true,
        triggered: false,
      });
    }
  } catch (error) {
    console.error("Error getting deadman status:", error);
    res.status(500).json({ message: "Failed to get deadman status" });
  }
});

// Activate deadman switch (encrypted database)
router.post("/activate", authenticateToken, async (req, res) => {
  try {
    console.log("🔥 ACTIVATION ENDPOINT HIT - START OF FUNCTION");
    console.log("🔥 RAW req.body =", req.body);
    console.log("🔥 req.body keys =", Object.keys(req.body));

    const userId = req.user.userId;
    const userEmail = req.user.email;
    const { checkinMethod, checkinInterval, inactivityPeriod, password } =
      req.body;

    console.log("🔥 EXTRACTED VALUES:");
    console.log("  checkinInterval =", checkinInterval);
    console.log("  typeof =", typeof checkinInterval);
    console.log("  JSON.stringify =", JSON.stringify(checkinInterval));

    console.log(`🚀 ACTIVATION: Request from ${userEmail}`);
    console.log(
      `📋 ACTIVATION: RAW REQUEST BODY =`,
      JSON.stringify(req.body, null, 2),
    );
    console.log(`📋 ACTIVATION: checkinMethod = "${checkinMethod}"`);
    console.log(`📋 ACTIVATION: checkinInterval = "${checkinInterval}"`);
    console.log(`📋 ACTIVATION: inactivityPeriod = "${inactivityPeriod}"`);
    console.log(
      `📋 ACTIVATION: typeof checkinInterval = "${typeof checkinInterval}"`,
    );
    console.log(
      `🔍 ACTIVATION: Raw req.body =`,
      JSON.stringify(req.body, null, 2),
    );

    // Password required for encryption/decryption
    if (!password) {
      console.log("❌ ACTIVATION: No password provided");
      return res
        .status(400)
        .json({ message: "Password required for encryption" });
    }

    // Get user's salt and current encrypted data
    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);
    const emails = userData.emails || [];

    // Calculate timer intervals
    console.log(`🔍 DEBUG: Received checkinInterval: "${checkinInterval}"`);
    console.log(`🔍 DEBUG: Received inactivityPeriod: "${inactivityPeriod}"`);

    // INLINE DEBUG TEST
    console.log(
      `🧪 INLINE TEST: About to call getIntervalMs("${checkinInterval}")`,
    );
    const checkinIntervalMs = getIntervalMs(checkinInterval);
    console.log(
      `🧪 INLINE TEST: getIntervalMs("${checkinInterval}") returned: ${checkinIntervalMs}`,
      `🧪 INLINE TEST: That equals ${checkinIntervalMs / 1000 / 60} minutes`,
    );

    const inactivityMs = getInactivityMs(inactivityPeriod);
    console.log(
      `🔍 DEBUG: Calculated checkinIntervalMs: ${checkinIntervalMs} (${checkinIntervalMs / 1000 / 60} minutes)`,
    );
    console.log(
      `🔍 DEBUG: Calculated inactivityMs: ${inactivityMs} (${inactivityMs / 1000 / 60} minutes)`,
    );

    // Verify the calculations are correct
    if (checkinIntervalMs === 7200000) {
      console.warn(
        `⚠️ WARNING: Check-in interval defaulted to 2 hours! Original value was "${checkinInterval}"`,
      );
    }
    if (inactivityMs === 7200000) {
      console.warn(
        `⚠️ WARNING: Inactivity period defaulted to 2 hours! Original value was "${inactivityPeriod}"`,
      );
    }

    // Validate that inactivity period is greater than check-in interval
    if (inactivityMs <= checkinIntervalMs) {
      return res.status(400).json({
        message: "Inactivity period must be longer than check-in interval",
      });
    }

    // Create encrypted deadman session in database
    const sessionData = await userService.createDeadmanSession(userId, {
      checkinInterval: checkinIntervalMs,
      inactivityTimeout: inactivityMs,
    });

    // Store settings in encrypted user data
    const updatedSettings = {
      checkinMethod,
      checkinInterval,
      inactivityPeriod,
      sessionToken: sessionData.sessionToken,
    };

    await userService.updateUserData(userId, password, user.salt, {
      emails: emails,
      settings: updatedSettings,
      checkinTokens: userData.checkinTokens || {},
    });

    // Store the deadman switch data in memory for active timers
    const now = Date.now();
    const switchData = {
      userEmail,
      userId,
      sessionToken: sessionData.sessionToken,
      settings: {
        checkinMethod,
        checkinInterval,
        inactivityPeriod,
        emails,
      },
      lastActivity: new Date(),
      nextCheckin: now + checkinIntervalMs,
      deadmanActivation: now + inactivityMs,
      checkinTimer: null,
      deadmanTimer: null,
    };

    console.log(`🔄 DEBUG: Creating switchData for ${userEmail}`);
    console.log(`📧 DEBUG: Emails in switchData: ${emails.length}`);
    emails.forEach((email, i) => {
      console.log(`📧 DEBUG: Email ${i + 1}: ${email.to || email.address}`);
    });

    // Set up check-in timer
    console.log(
      `⏰ DEBUG: Setting up check-in timer for ${userEmail} with interval ${checkinIntervalMs}ms`,
    );
    switchData.checkinTimer = setInterval(async () => {
      try {
        console.log(
          `🔍 PERIODIC CHECK-IN: Timer fired for ${userEmail} at ${new Date().toISOString()}`,
        );

        // Safety check: Don't send check-in emails if deadman switch is no longer active
        if (!activeDeadmanSwitches.has(userEmail)) {
          console.log(
            `⚠️ PERIODIC CHECK-IN: Deadman switch no longer active for ${userEmail}, stopping timer`,
          );
          clearInterval(switchData.checkinTimer);
          return;
        }

        // Verify switchData still exists
        const currentSwitchData = activeDeadmanSwitches.get(userEmail);
        if (!currentSwitchData) {
          console.error(
            `❌ PERIODIC CHECK-IN: Switch data missing for ${userEmail}, stopping timer`,
          );
          clearInterval(switchData.checkinTimer);
          return;
        }

        console.log(
          `✅ PERIODIC CHECK-IN: Switch data verified for ${userEmail}`,
        );

        // Generate unique check-in token
        const checkinToken = crypto.randomBytes(32).toString("hex");
        checkinTokens.set(checkinToken, userEmail);

        // Update session activity in database
        if (sessionData && sessionData.sessionToken) {
          try {
            await userService.updateSessionActivity(sessionData.sessionToken);
            console.log(
              `📝 PERIODIC CHECK-IN: Database session updated for ${userEmail}`,
            );
          } catch (error) {
            console.error(
              `Failed to update session activity during periodic check-in for ${userEmail}:`,
              error,
            );
          }
        }

        console.log(`📧 PERIODIC CHECK-IN: Sending email to ${userEmail}`);

        // Send actual check-in email (non-blocking)
        console.log(
          `📧 DEBUG: About to call sendCheckinEmail for ${userEmail}`,
        );
        console.log(`📧 DEBUG: Check-in token: ${checkinToken}`);
        console.log(`📧 DEBUG: emailService available: ${!!emailService}`);

        emailService
          .sendCheckinEmail(userEmail, checkinToken)
          .then((emailSent) => {
            if (!emailSent) {
              console.error(
                `❌ PERIODIC CHECK-IN: Failed to send check-in email to ${userEmail}`,
              );
            } else {
              console.log(
                `✅ PERIODIC CHECK-IN: Email sent successfully to ${userEmail}`,
              );
              console.log(
                `📧 DEBUG: Email sent at ${new Date().toISOString()}`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `❌ PERIODIC CHECK-IN: Error sending check-in email to ${userEmail}:`,
              error,
            );
          });

        // Update next check-in time
        const nextCheckinNow = Date.now();
        switchData.nextCheckinTime = new Date(
          nextCheckinNow + checkinIntervalMs,
        );
        switchData.nextCheckin = nextCheckinNow + checkinIntervalMs;
        // Deadman activation time should NOT be reset here
        console.log(
          `📧 PERIODIC CHECK-IN: Email sent for ${userEmail}, next check-in in ${checkinIntervalMs / 1000 / 60} minutes`,
        );
      } catch (error) {
        console.error(
          `❌ PERIODIC CHECK-IN: Critical error in timer callback for ${userEmail}:`,
          error,
        );
        // Don't clear the timer on error, let it retry next time
      }
    }, checkinIntervalMs);

    // Set up deadman timer with support for large timeout values
    // JavaScript setTimeout has a maximum delay of ~24.8 days (2,147,483,647 ms)
    const MAX_TIMEOUT = 2147483647; // Max setTimeout value

    if (inactivityMs <= MAX_TIMEOUT) {
      // Standard setTimeout for periods <= 24.8 days
      switchData.deadmanTimer = setTimeout(async () => {
        await executeDeadmanActivation(userEmail, emails);
      }, inactivityMs);
    } else {
      // For longer periods, use interval checking
      console.log(
        `⚠️ LARGE TIMEOUT: Using interval checking for ${userEmail} (${inactivityMs}ms > ${MAX_TIMEOUT}ms)`,
      );

      switchData.deadmanTimer = setInterval(async () => {
        const now = Date.now();
        const timeRemaining = switchData.deadmanActivation - now;

        console.log(
          `🔍 LARGE TIMEOUT CHECK: ${userEmail} - ${timeRemaining}ms remaining`,
        );

        if (timeRemaining <= 0) {
          // Time has expired, trigger deadman
          clearInterval(switchData.deadmanTimer);
          await executeDeadmanActivation(userEmail, emails);
        }
      }, 60000); // Check every minute for large timeouts
    }

    // Store the active switch
    activeDeadmanSwitches.set(userEmail, switchData);

    // Store emails in memory for deadman activation
    userEmails.set(userEmail, emails);

    // Save timer state to database for persistence
    try {
      await userService.saveTimerState(userId, {
        nextCheckin: switchData.nextCheckin,
        deadmanActivation: switchData.deadmanActivation,
        lastActivity: switchData.lastActivity,
      });
      console.log(`💾 PERSISTENCE: Timer state saved for ${userEmail}`);
    } catch (error) {
      console.error(
        `❌ PERSISTENCE: Failed to save timer state for ${userEmail}:`,
        error,
      );
    }

    res.status(200).json({
      success: true,
      message: "Deadman switch activated successfully",
      settings: {
        checkinIntervalMinutes: checkinIntervalMs / 1000 / 60,
        deadmanTimerMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error("❌ ACTIVATION ERROR:", error);
    console.error("❌ ACTIVATION ERROR STACK:", error.stack);
    res.status(500).json({
      message: "Failed to activate deadman switch",
      error: error.message,
    });
  }
});

// Helper function to execute deadman activation (extracted for reuse)
async function executeDeadmanActivation(userEmail, emails) {
  try {
    console.log(
      `🚨 DEADMAN TIMER EXPIRED: Starting email send process for ${userEmail}`,
    );
    console.log(`   - Emails to send: ${emails.length}`);
    console.log(
      `   - Email addresses: ${emails.map((e) => e.to || e.address).join(", ")}`,
    );

    // Send actual deadman emails (non-blocking)
    emailService
      .sendDeadmanEmails(userEmail, emails)
      .then((emailsSent) => {
        if (!emailsSent) {
          console.error(
            `❌ DEADMAN EMAILS FAILED: No emails sent for ${userEmail}`,
          );
          // Still record activation even if email failed
          deadmanActivationHistory.set(userEmail, {
            triggered: true,
            timestamp: new Date().toISOString(),
            emailsSent: 0,
            reason: "inactivity_timeout",
            status: "email_failed",
          });
        } else {
          console.log(
            `✅ DEADMAN EMAILS SUCCESS: Emails sent for ${userEmail}`,
          );
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
          `❌ DEADMAN EMAILS ERROR: Failed to send emails for ${userEmail}:`,
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

    // Record activation immediately (before email result)
    deadmanActivationHistory.set(userEmail, {
      triggered: true,
      timestamp: new Date().toISOString(),
      emailsSent: emails.length,
      reason: "inactivity_timeout",
      status: "pending",
    });

    console.log(
      `🚨 DEADMAN ACTIVATED: Cleaning up timers and data for ${userEmail}`,
    );

    // Clean up after activation (do cleanup immediately)
    // Clear check-in timer to stop further check-in emails
    const currentSwitchData = activeDeadmanSwitches.get(userEmail);
    if (currentSwitchData && currentSwitchData.checkinTimer) {
      clearInterval(currentSwitchData.checkinTimer);
      console.log(
        `🔄 DEADMAN CLEANUP: Cleared check-in timer for ${userEmail}`,
      );
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

    // Remove from active switches
    activeDeadmanSwitches.delete(userEmail);

    console.log(
      `✅ DEADMAN CLEANUP: All timers and data cleared for ${userEmail}`,
    );
  } catch (error) {
    console.error(`Error in deadman timer callback:`, error);
  }
}

// Deactivate deadman switch
router.post("/deactivate", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🔄 DEACTIVATE: Request from ${userEmail}`);

    if (!activeDeadmanSwitches.has(userEmail)) {
      console.log(`❌ DEACTIVATE: No active switch found for ${userEmail}`);
      return res.status(400).json({
        message: "No active deadman switch found for this user",
      });
    }

    // Get the active switch data
    const switchData = activeDeadmanSwitches.get(userEmail);
    console.log(`✅ DEACTIVATE: Found active switch for ${userEmail}`);

    // Clear all timers
    if (switchData.checkinTimer) {
      clearInterval(switchData.checkinTimer);
      console.log(`🔄 DEACTIVATE: Cleared check-in timer for ${userEmail}`);
    }
    if (switchData.deadmanTimer) {
      // Clear timeout or interval depending on which was used
      clearTimeout(switchData.deadmanTimer);
      clearInterval(switchData.deadmanTimer);
      console.log(`🔄 DEACTIVATE: Cleared deadman timer for ${userEmail}`);
    }

    // Clear any check-in tokens for this user
    const tokensToDelete = [];
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        tokensToDelete.push(token);
      }
    }
    tokensToDelete.forEach((token) => checkinTokens.delete(token));
    console.log(
      `🔄 DEACTIVATE: Cleared ${tokensToDelete.length} check-in tokens for ${userEmail}`,
    );

    // Clear user emails
    userEmails.delete(userEmail);

    // Deactivate session in database
    try {
      await userService.deactivateSession(switchData.userId);
      console.log(
        `💾 PERSISTENCE: Session deactivated in database for ${userEmail}`,
      );
    } catch (error) {
      console.error(
        `❌ PERSISTENCE: Failed to deactivate session for ${userEmail}:`,
        error,
      );
    }

    // Remove from active switches
    activeDeadmanSwitches.delete(userEmail);
    console.log(
      `✅ DEACTIVATE: Successfully deactivated deadman switch for ${userEmail}`,
    );

    res.status(200).json({
      success: true,
      message: "Deadman switch deactivated successfully",
    });
  } catch (error) {
    console.error(
      `❌ DEACTIVATE: Error deactivating deadman switch for ${req.user?.email}:`,
      error,
    );
    res.status(500).json({
      success: false,
      message: "Failed to deactivate deadman switch",
      error: error.message,
    });
  }
});

// Simple test endpoint without authentication
router.get("/test-intervals", (req, res) => {
  try {
    console.log("🧪 TEST-INTERVALS: Endpoint hit");
    const testResults = {
      "1-minutes": getIntervalMs("1-minutes"),
      "1-minute": getIntervalMs("1-minute"),
      "2-hours": getIntervalMs("2-hours"),
      "3-minutes": getInactivityMs("3-minutes"),
    };
    console.log("🧪 TEST-INTERVALS: Results =", testResults);
    res.json({
      success: true,
      testResults,
      expectedResults: {
        "1-minutes": 60000,
        "1-minute": 60000,
        "2-hours": 7200000,
        "3-minutes": 180000,
      },
    });
  } catch (error) {
    console.error("❌ TEST-INTERVALS ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/debug-activation", authenticateToken, (req, res) => {
  try {
    const { checkinMethod, checkinInterval, inactivityPeriod, password } =
      req.body;

    console.log("🔍 DEBUG-ACTIVATION: Raw request body =", req.body);
    console.log(`🔍 DEBUG-ACTIVATION: checkinInterval = "${checkinInterval}"`);
    console.log(
      `🔍 DEBUG-ACTIVATION: inactivityPeriod = "${inactivityPeriod}"`,
    );

    const checkinIntervalMs = getIntervalMs(checkinInterval);
    const inactivityMs = getInactivityMs(inactivityPeriod);

    console.log(
      `🔍 DEBUG-ACTIVATION: Calculated checkinIntervalMs = ${checkinIntervalMs}ms (${checkinIntervalMs / 1000 / 60} minutes)`,
    );
    console.log(
      `🔍 DEBUG-ACTIVATION: Calculated inactivityMs = ${inactivityMs}ms (${inactivityMs / 1000 / 60} minutes)`,
    );

    res.json({
      success: true,
      received: {
        checkinMethod,
        checkinInterval,
        inactivityPeriod,
        hasPassword: !!password,
      },
      calculated: {
        checkinIntervalMs,
        inactivityMs,
        checkinMinutes: checkinIntervalMs / 1000 / 60,
        inactivityMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error("❌ DEBUG-ACTIVATION ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to clear all active switches and start fresh
router.post("/debug-clear-all", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🧹 DEBUG-CLEAR-ALL: Request from ${userEmail}`);

    let clearedCount = 0;

    // Clear active switches
    for (const [email, switchData] of activeDeadmanSwitches.entries()) {
      console.log(`🧹 Clearing active switch for ${email}`);

      // Clear timers
      if (switchData.checkinTimer) {
        clearInterval(switchData.checkinTimer);
        console.log(`   ✅ Cleared check-in timer`);
      }
      if (switchData.deadmanTimer) {
        clearTimeout(switchData.deadmanTimer);
        console.log(`   ✅ Cleared deadman timer`);
      }

      activeDeadmanSwitches.delete(email);
      clearedCount++;
    }

    // Clear check-in tokens
    const tokenCount = checkinTokens.size;
    checkinTokens.clear();

    // Clear user emails
    const emailCount = userEmails.size;
    userEmails.clear();

    // Clear activation history
    const historyCount = deadmanActivationHistory.size;
    deadmanActivationHistory.clear();

    console.log(`🧹 DEBUG-CLEAR-ALL: Cleanup complete`);
    console.log(`   - Cleared ${clearedCount} active switches`);
    console.log(`   - Cleared ${tokenCount} check-in tokens`);
    console.log(`   - Cleared ${emailCount} user email entries`);
    console.log(`   - Cleared ${historyCount} activation history entries`);

    res.json({
      success: true,
      message: "All active switches and data cleared",
      cleared: {
        activeSwitches: clearedCount,
        checkinTokens: tokenCount,
        userEmails: emailCount,
        activationHistory: historyCount,
      },
    });
  } catch (error) {
    console.error("❌ DEBUG-CLEAR-ALL ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to show current active switches
router.get("/debug-active-switches", (req, res) => {
  try {
    const switches = [];
    const now = Date.now();

    for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
      const timeToNextCheckin = switchData.nextCheckin - now;
      const timeToDeadman = switchData.deadmanActivation - now;

      switches.push({
        userEmail,
        settings: switchData.settings,
        timeToNextCheckin: `${Math.round(timeToNextCheckin / 1000 / 60)} minutes`,
        timeToDeadman: `${Math.round(timeToDeadman / 1000 / 60)} minutes`,
        hasCheckinTimer: !!switchData.checkinTimer,
        hasDeadmanTimer: !!switchData.deadmanTimer,
        lastActivity: switchData.lastActivity,
      });
    }

    res.json({
      success: true,
      activeSwitches: switches,
      totalActive: switches.length,
      checkinTokens: checkinTokens.size,
      userEmails: userEmails.size,
    });
  } catch (error) {
    console.error("❌ DEBUG-ACTIVE-SWITCHES ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to clear expired database sessions
router.post("/debug-clear-expired", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.userId;
    console.log(`🧹 DEBUG-CLEAR-EXPIRED: Request from ${userEmail}`);

    // Clear from memory first
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      console.log(`🧹 Cleared active switch from memory`);
    }

    // Clear from database
    try {
      await userService.deleteDeadmanSession(userId);
      console.log(`🧹 Cleared database session`);
    } catch (error) {
      console.log(`🧹 No database session to clear or error:`, error.message);
    }

    // Clear related data
    userEmails.delete(userEmail);
    deadmanActivationHistory.delete(userEmail);

    // Clear check-in tokens for this user
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        checkinTokens.delete(token);
      }
    }

    console.log(`🧹 DEBUG-CLEAR-EXPIRED: Complete cleanup for ${userEmail}`);

    res.json({
      success: true,
      message: "Expired sessions and data cleared for user",
      userEmail: userEmail,
    });
  } catch (error) {
    console.error("❌ DEBUG-CLEAR-EXPIRED ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug status endpoint to check active switches
router.get("/debug-status", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🔍 DEBUG-STATUS: Request from ${userEmail}`);

    const activeSwitch = activeDeadmanSwitches.get(userEmail);
    const userTokens = [];
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        userTokens.push(token);
      }
    }

    res.json({
      success: true,
      userEmail,
      hasActiveSwitch: activeDeadmanSwitches.has(userEmail),
      switchData: activeSwitch
        ? {
            hasCheckinTimer: !!activeSwitch.checkinTimer,
            hasDeadmanTimer: !!activeSwitch.deadmanTimer,
            lastActivity: activeSwitch.lastActivity,
            nextCheckin: activeSwitch.nextCheckin,
            deadmanActivation: activeSwitch.deadmanActivation,
            settings: activeSwitch.settings,
          }
        : null,
      activeTokensCount: userTokens.length,
      totalActiveSwitches: activeDeadmanSwitches.size,
      hasUserEmails: userEmails.has(userEmail),
      userEmailsCount: userEmails.has(userEmail)
        ? userEmails.get(userEmail).length
        : 0,
    });
  } catch (error) {
    console.error(`❌ DEBUG-STATUS: Error for ${req.user?.email}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear all database sessions for testing
router.post("/clear-sessions", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    console.log(`🧹 CLEAR-SESSIONS: Request from ${userEmail}`);

    // Clear in-memory data
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      console.log(
        `🧹 CLEAR-SESSIONS: Cleared in-memory switch for ${userEmail}`,
      );
    }

    // Clear database sessions
    await userService.deactivateSession(userId);
    console.log(
      `🧹 CLEAR-SESSIONS: Cleared database sessions for ${userEmail}`,
    );

    // Clear other data
    userEmails.delete(userEmail);
    const tokensToDelete = [];
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        tokensToDelete.push(token);
      }
    }
    tokensToDelete.forEach((token) => checkinTokens.delete(token));

    console.log(`✅ CLEAR-SESSIONS: All data cleared for ${userEmail}`);

    res.json({
      success: true,
      message: "All sessions and data cleared successfully",
    });
  } catch (error) {
    console.error(`❌ CLEAR-SESSIONS: Error for ${req.user?.email}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual recovery endpoint for lost deadman switches
router.post("/recover", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    const { password } = req.body;

    console.log(
      `🔄 RECOVERY: Attempting to recover deadman switch for ${userEmail}`,
    );

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password required to decrypt user data",
      });
    }

    // Check if there's already an active switch
    if (activeDeadmanSwitches.has(userEmail)) {
      console.log(`⚠️ RECOVERY: Active switch already exists for ${userEmail}`);
      return res.json({
        success: true,
        message: "Deadman switch is already active",
        alreadyActive: true,
      });
    }

    // Get user data from database
    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);

    if (!userData.settings || !userData.settings.sessionToken) {
      console.log(
        `❌ RECOVERY: No saved deadman switch settings found for ${userEmail}`,
      );
      return res.status(400).json({
        success: false,
        message: "No saved deadman switch configuration found",
      });
    }

    const settings = userData.settings;
    const emails = userData.emails || [];

    // Calculate remaining time based on last activity
    const now = Date.now();
    const checkinIntervalMs = getIntervalMs(settings.checkinInterval);
    const inactivityMs = getInactivityMs(settings.inactivityPeriod);

    // Recreate the switch data
    const switchData = {
      userEmail,
      userId,
      sessionToken: settings.sessionToken,
      settings: {
        checkinMethod: settings.checkinMethod,
        checkinInterval: settings.checkinInterval,
        inactivityPeriod: settings.inactivityPeriod,
        emails,
      },
      lastActivity: new Date(),
      nextCheckin: now + checkinIntervalMs,
      deadmanActivation: now + inactivityMs,
      checkinTimer: null,
      deadmanTimer: null,
    };

    // Recreate check-in timer
    switchData.checkinTimer = setInterval(async () => {
      try {
        console.log(
          `🔍 PERIODIC CHECK-IN: Timer fired for ${userEmail} (recovered)`,
        );

        if (!activeDeadmanSwitches.has(userEmail)) {
          console.log(
            `⚠️ PERIODIC CHECK-IN: Deadman switch no longer active for ${userEmail}, stopping timer`,
          );
          clearInterval(switchData.checkinTimer);
          return;
        }

        const checkinToken = crypto.randomBytes(32).toString("hex");
        checkinTokens.set(checkinToken, userEmail);

        if (switchData.sessionToken) {
          try {
            await userService.updateSessionActivity(switchData.sessionToken);
          } catch (error) {
            console.error(
              `Failed to update session activity during recovered check-in for ${userEmail}:`,
              error,
            );
          }
        }

        emailService
          .sendCheckinEmail(userEmail, checkinToken)
          .then((emailSent) => {
            if (!emailSent) {
              console.error(
                `❌ PERIODIC CHECK-IN: Failed to send recovered check-in email to ${userEmail}`,
              );
            } else {
              console.log(
                `✅ PERIODIC CHECK-IN: Recovered email sent successfully to ${userEmail}`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `❌ PERIODIC CHECK-IN: Error sending recovered check-in email to ${userEmail}:`,
              error,
            );
          });

        const nextCheckinNow = Date.now();
        switchData.nextCheckinTime = new Date(
          nextCheckinNow + checkinIntervalMs,
        );
        switchData.nextCheckin = nextCheckinNow + checkinIntervalMs;
        console.log(
          `📧 PERIODIC CHECK-IN: Recovered email sent for ${userEmail}, next check-in in ${checkinIntervalMs / 1000 / 60} minutes`,
        );
      } catch (error) {
        console.error(
          `❌ PERIODIC CHECK-IN: Critical error in recovered timer callback for ${userEmail}:`,
          error,
        );
      }
    }, checkinIntervalMs);

    // Recreate deadman timer
    switchData.deadmanTimer = setTimeout(async () => {
      try {
        console.log(
          `🚨 DEADMAN TIMER EXPIRED: Starting email send process for ${userEmail} (recovered)`,
        );
        console.log(`   - Emails to send: ${emails.length}`);

        const deadmanEmails = userEmails.get(userEmail) || emails;

        emailService
          .sendDeadmanEmails(userEmail, deadmanEmails)
          .then((emailsSent) => {
            if (!emailsSent) {
              console.error(
                `❌ DEADMAN EMAILS FAILED: No emails sent for ${userEmail} (recovered)`,
              );
            } else {
              console.log(
                `✅ DEADMAN EMAILS SUCCESS: Emails sent for ${userEmail} (recovered)`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `❌ DEADMAN EMAILS ERROR: Failed to send emails for ${userEmail} (recovered):`,
              error,
            );
          });

        console.log(
          `🚨 DEADMAN ACTIVATED: Cleaning up timers and data for ${userEmail} (recovered)`,
        );

        const currentSwitchData = activeDeadmanSwitches.get(userEmail);
        if (currentSwitchData && currentSwitchData.checkinTimer) {
          clearInterval(currentSwitchData.checkinTimer);
          console.log(
            `🔄 DEADMAN CLEANUP: Cleared check-in timer for ${userEmail} (recovered)`,
          );
        }

        userEmails.delete(userEmail);
        const tokensToDelete = [];
        for (const [token, email] of checkinTokens.entries()) {
          if (email === userEmail) {
            tokensToDelete.push(token);
          }
        }
        tokensToDelete.forEach((token) => checkinTokens.delete(token));
        activeDeadmanSwitches.delete(userEmail);

        console.log(
          `✅ DEADMAN CLEANUP: All timers and data cleared for ${userEmail} (recovered)`,
        );
      } catch (error) {
        console.error(
          `Error in recovered deadman timer callback for ${userEmail}:`,
          error,
        );
      }
    }, inactivityMs);

    // Store the recovered switch
    activeDeadmanSwitches.set(userEmail, switchData);
    userEmails.set(userEmail, emails);

    console.log(`📊 DEBUG: After activation:`);
    console.log(
      `📊 DEBUG: activeDeadmanSwitches size: ${activeDeadmanSwitches.size}`,
    );
    console.log(`📊 DEBUG: userEmails size: ${userEmails.size}`);
    console.log(
      `📊 DEBUG: userEmails for ${userEmail}: ${userEmails.get(userEmail)?.length || 0} emails`,
    );

    console.log(
      `✅ RECOVERY: Successfully recovered deadman switch for ${userEmail}`,
    );

    res.json({
      success: true,
      message: "Deadman switch recovered successfully",
      settings: {
        checkinIntervalMinutes: checkinIntervalMs / 1000 / 60,
        deadmanTimerMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error(
      `❌ RECOVERY: Error recovering deadman switch for ${req.user?.email}:`,
      error,
    );
    res.status(500).json({
      success: false,
      message: "Failed to recover deadman switch",
      error: error.message,
    });
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
// Removed duplicate timer-status endpoint - using the first one that returns absolute timestamps

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

// Check-in endpoint - handles check-in link clicks
router.get("/checkin/:token", async (req, res) => {
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

      // Update session activity in database if session token exists
      if (switchData.sessionToken) {
        try {
          await userService.updateSessionActivity(switchData.sessionToken);
          console.log(
            `✅ CHECK-IN BUTTON CLICKED: Database session activity updated for ${userEmail}`,
          );
        } catch (error) {
          console.error(
            `Failed to update session activity for ${userEmail}:`,
            error,
          );
        }
      }

      // Reset check-in timer
      if (switchData.checkinTimer) {
        clearInterval(switchData.checkinTimer);
        console.log(
          `🔄 CHECK-IN BUTTON: Cleared existing check-in timer for ${userEmail}`,
        );
      }

      // Reset deadman timer
      if (switchData.deadmanTimer) {
        clearTimeout(switchData.deadmanTimer);
        console.log(
          `🔄 CHECK-IN BUTTON: Cleared existing deadman timer for ${userEmail}`,
        );
      } else {
        console.log(
          `⚠️ CHECK-IN BUTTON: No deadman timer to clear for ${userEmail}`,
        );
      }

      // Recreate check-in timer
      const checkinIntervalMs = getIntervalMs(
        switchData.settings.checkinInterval,
      );
      const now = Date.now();
      switchData.nextCheckinTime = new Date(now + checkinIntervalMs);
      switchData.nextCheckin = now + checkinIntervalMs;
      console.log(
        `⏰ CHECK-IN BUTTON: Created new check-in timer for ${userEmail} (${checkinIntervalMs / 1000 / 60} minutes)`,
      );
      switchData.checkinTimer = setInterval(async () => {
        try {
          console.log(
            `🔍 PERIODIC CHECK-IN: Timer fired for ${userEmail} (from check-in button)`,
          );

          // Safety check: Don't send check-in emails if deadman switch is no longer active
          if (!activeDeadmanSwitches.has(userEmail)) {
            console.log(
              `⚠️ PERIODIC CHECK-IN: Deadman switch no longer active for ${userEmail}, stopping timer`,
            );
            clearInterval(switchData.checkinTimer);
            return;
          }

          // Verify switchData still exists
          const currentSwitchData = activeDeadmanSwitches.get(userEmail);
          if (!currentSwitchData) {
            console.error(
              `❌ PERIODIC CHECK-IN: Switch data missing for ${userEmail}, stopping timer`,
            );
            clearInterval(switchData.checkinTimer);
            return;
          }

          console.log(
            `✅ PERIODIC CHECK-IN: Switch data verified for ${userEmail}`,
          );

          const checkinToken = crypto.randomBytes(32).toString("hex");
          checkinTokens.set(checkinToken, userEmail);

          // Update session activity in database during periodic check-ins
          if (switchData.sessionToken) {
            try {
              await userService.updateSessionActivity(switchData.sessionToken);
              console.log(
                `📝 PERIODIC CHECK-IN: Database session updated for ${userEmail}`,
              );
            } catch (error) {
              console.error(
                `Failed to update session activity during periodic check-in for ${userEmail}:`,
                error,
              );
            }
          }

          console.log(`📧 PERIODIC CHECK-IN: Sending email to ${userEmail}`);

          emailService
            .sendCheckinEmail(userEmail, checkinToken)
            .then((emailSent) => {
              if (!emailSent) {
                console.error(
                  `❌ PERIODIC CHECK-IN: Failed to send check-in email to ${userEmail}`,
                );
              } else {
                console.log(
                  `✅ PERIODIC CHECK-IN: Email sent successfully to ${userEmail}`,
                );
              }
            })
            .catch((error) => {
              console.error(
                `❌ PERIODIC CHECK-IN: Error sending check-in email to ${userEmail}:`,
                error,
              );
            });

          // Update next check-in time
          const nextCheckinNow = Date.now();
          switchData.nextCheckinTime = new Date(
            nextCheckinNow + checkinIntervalMs,
          );
          switchData.nextCheckin = nextCheckinNow + checkinIntervalMs;
          // Deadman activation time should NOT be reset here
          console.log(
            `📧 PERIODIC CHECK-IN: Email sent for ${userEmail}, next check-in in ${checkinIntervalMs / 1000 / 60} minutes`,
          );
        } catch (error) {
          console.error(
            `❌ PERIODIC CHECK-IN: Critical error in timer callback for ${userEmail}:`,
            error,
          );
          // Don't clear the timer on error, let it retry next time
        }
      }, checkinIntervalMs);

      // Recreate deadman timer
      const inactivityMs = getInactivityMs(
        switchData.settings.inactivityPeriod,
      );
      switchData.deadmanActivation = now + inactivityMs;
      console.log(
        `⏰ CHECK-IN BUTTON: Created new deadman timer for ${userEmail} (${inactivityMs / 1000 / 60} minutes)`,
      );
      console.log(
        `🔍 DEBUG: CHECK-IN BUTTON deadman activation set to: ${switchData.deadmanActivation} (current time: ${now})`,
      );
      switchData.deadmanTimer = setTimeout(async () => {
        try {
          // Get emails from both memory and switchData (fallback)
          let emails = userEmails.get(userEmail) || [];
          if (emails.length === 0 && switchData.settings.emails) {
            emails = switchData.settings.emails;
            console.log(
              `Using fallback emails from switchData for ${userEmail}: ${emails.length} emails`,
            );
          }

          console.log(
            `Deadman timer expired for ${userEmail}, sending ${emails.length} emails`,
          );

          // Record activation immediately (before email sending)
          deadmanActivationHistory.set(userEmail, {
            triggered: true,
            timestamp: new Date().toISOString(),
            emailsSent: emails.length,
            reason: "inactivity_timeout",
            status: "pending",
          });

          if (emails.length === 0) {
            console.error(
              `❌ DEADMAN ACTIVATION: No emails configured for ${userEmail}`,
            );
            deadmanActivationHistory.set(userEmail, {
              triggered: true,
              timestamp: new Date().toISOString(),
              emailsSent: 0,
              reason: "inactivity_timeout",
              status: "no_emails_configured",
            });
          } else {
            console.log(
              `🚨 DEADMAN TIMER EXPIRED: Starting email send process for ${userEmail}`,
            );
            console.log(`   - Emails to send: ${emails.length}`);
            console.log(
              `   - Email addresses: ${emails.map((e) => e.to || e.address).join(", ")}`,
            );

            emailService
              .sendDeadmanEmails(userEmail, emails)
              .then((emailsSent) => {
                if (!emailsSent) {
                  console.error(
                    `❌ DEADMAN EMAILS FAILED: No emails sent for ${userEmail}`,
                  );
                  // Update activation history with failure status
                  deadmanActivationHistory.set(userEmail, {
                    triggered: true,
                    timestamp: new Date().toISOString(),
                    emailsSent: 0,
                    reason: "inactivity_timeout",
                    status: "email_failed",
                  });
                } else {
                  console.log(
                    `✅ DEADMAN EMAILS SUCCESS: Successfully sent deadman emails for ${userEmail}`,
                  );
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
                  `❌ DEADMAN EMAILS ERROR: Failed to send emails for ${userEmail}:`,
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
          }

          console.log(
            `🚨 DEADMAN ACTIVATED: Cleaning up timers and data for ${userEmail}`,
          );

          // Clean up after activation (do cleanup immediately)
          // Clear check-in timer to stop further check-in emails
          const currentSwitchData = activeDeadmanSwitches.get(userEmail);
          if (currentSwitchData && currentSwitchData.checkinTimer) {
            clearInterval(currentSwitchData.checkinTimer);
            console.log(
              `🔄 DEADMAN CLEANUP: Cleared check-in timer for ${userEmail}`,
            );
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

          // Remove from active switches
          activeDeadmanSwitches.delete(userEmail);

          console.log(
            `✅ DEADMAN CLEANUP: All timers and data cleared for ${userEmail}`,
          );
        } catch (error) {
          console.error(`Error in deadman timer callback:`, error);
        }
      }, inactivityMs);
    }

    // Remove used token
    checkinTokens.delete(token);
    console.log(
      `🎯 CHECK-IN COMPLETE: Both timers successfully reset for ${userEmail}`,
    );

    // Save updated timer state to database for persistence
    try {
      await userService.saveTimerState(switchData.userId, {
        nextCheckin: switchData.nextCheckin,
        deadmanActivation: switchData.deadmanActivation,
        lastActivity: switchData.lastActivity,
      });
      console.log(
        `💾 PERSISTENCE: Timer state saved after check-in for ${userEmail}`,
      );
    } catch (error) {
      console.error(
        `❌ PERSISTENCE: Failed to save timer state after check-in for ${userEmail}:`,
        error,
      );
    }

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

// Debug endpoints for troubleshooting
router.get("/debug/active-switches", authenticateToken, (req, res) => {
  const userEmail = req.user.email;
  const switchData = activeDeadmanSwitches.get(userEmail);

  res.json({
    userEmail,
    hasActiveSwitch: !!switchData,
    switchData: switchData
      ? {
          lastActivity: switchData.lastActivity,
          nextCheckin: switchData.nextCheckinTime,
          hasCheckinTimer: !!switchData.checkinTimer,
          hasDeadmanTimer: !!switchData.deadmanTimer,
          sessionToken: switchData.sessionToken,
          emailCount: switchData.settings.emails
            ? switchData.settings.emails.length
            : 0,
        }
      : null,
    checkinTokens: Array.from(checkinTokens.entries()).filter(
      ([token, email]) => email === userEmail,
    ).length,
    userEmailsCount: (userEmails.get(userEmail) || []).length,
  });
});

router.get("/debug/activation-history", authenticateToken, (req, res) => {
  const userEmail = req.user.email;
  const history = deadmanActivationHistory.get(userEmail);

  res.json({
    userEmail,
    activationHistory: history || null,
  });
});

router.post("/debug/test-email", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const testResult = await emailService.testEmailConnection();

    if (testResult.success) {
      // Try sending a test check-in email
      const testToken = "test-token-" + Date.now();
      const emailSent = await emailService.sendCheckinEmail(
        userEmail,
        testToken,
      );

      res.json({
        emailService: testResult,
        testEmailSent: emailSent,
        message: emailSent
          ? "Test email sent successfully"
          : "Failed to send test email",
      });
    } else {
      res.json({
        emailService: testResult,
        testEmailSent: false,
        message: "Email service connection failed",
      });
    }
  } catch (error) {
    res.status(500).json({
      error: error.message,
      message: "Error testing email service",
    });
  }
});

// Nuclear reset endpoint - wipes everything completely
router.post("/nuclear-reset", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.userId;

    console.log(`💥 NUCLEAR-RESET: Starting complete wipe for ${userEmail}`);

    // 1. Clear ALL in-memory data for ALL users (nuclear approach)
    console.log(`💥 NUCLEAR-RESET: Clearing all memory maps`);
    activeDeadmanSwitches.clear();
    userEmails.clear();
    checkinTokens.clear();
    deadmanActivationHistory.clear();

    // 2. Clear database session
    try {
      await userService.deactivateSession(userId);
      console.log(`💥 NUCLEAR-RESET: Database session deactivated`);
    } catch (error) {
      console.log(`💥 NUCLEAR-RESET: No database session to deactivate`);
    }

    // 3. Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log(`💥 NUCLEAR-RESET: Forced garbage collection`);
    }

    console.log(`💥 NUCLEAR-RESET: Complete nuclear reset completed`);
    console.log(
      `💥 NUCLEAR-RESET: All systems cleared - ready for fresh start`,
    );

    res.json({
      success: true,
      message:
        "NUCLEAR RESET COMPLETE. All deadman switch data wiped. Server memory cleared. You can now start completely fresh.",
      warning:
        "This cleared ALL deadman switches for ALL users. Use with caution.",
    });
  } catch (error) {
    console.error("❌ NUCLEAR-RESET ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Simple endpoint to force deactivation and clear all data
router.post("/force-clear", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.userId;
    const { password } = req.body;

    console.log(`🧹 FORCE-CLEAR: Request from ${userEmail}`);

    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for database clearing" });
    }

    // Clear active switch from memory
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      console.log(`🧹 FORCE-CLEAR: Cleared active switch from memory`);
    }

    // Clear all related data
    userEmails.delete(userEmail);
    deadmanActivationHistory.delete(userEmail);

    // Clear check-in tokens for this user
    for (const [token, email] of checkinTokens.entries()) {
      if (email === userEmail) {
        checkinTokens.delete(token);
      }
    }

    // Clear database emails by updating user data with empty emails
    try {
      const userData = await userService.getUserData(userId, password, null);
      if (userData) {
        // Create updated user data with empty emails
        const updatedUserData = {
          ...userData,
          deadmanSettings: {
            ...userData.deadmanSettings,
            emails: [],
          },
        };

        // Update the database
        await userService.updateUserData(
          userId,
          password,
          null,
          updatedUserData,
        );
        console.log(`🧹 FORCE-CLEAR: Cleared emails from database`);
      }
    } catch (error) {
      console.log(
        `🧹 FORCE-CLEAR: Error clearing database emails:`,
        error.message,
      );
    }

    // Deactivate database session
    try {
      await userService.deactivateSession(userId);
      console.log(`🧹 FORCE-CLEAR: Deactivated database session`);
    } catch (error) {
      console.log(`🧹 FORCE-CLEAR: No database session to deactivate`);
    }

    console.log(`🧹 FORCE-CLEAR: Complete cleanup for ${userEmail}`);

    res.json({
      success: true,
      message:
        "All deadman switch data cleared including database emails. You can now start fresh.",
    });
  } catch (error) {
    console.error("❌ FORCE-CLEAR ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
