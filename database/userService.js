const sqlite3 = require("sqlite3").verbose();
const crypto = require("./crypto");

class UserService {
  constructor() {
    this.db = null;
  }

  // Initialize database connection
  async connect() {
    // Read DB_PATH at connect time so env vars are already set
    const { DB_PATH } = require("./init");
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          reject(err);
        } else {
          // Enable foreign keys
          this.db.run("PRAGMA foreign_keys = ON;");
          resolve();
        }
      });
    });
  }

  // Close database connection
  async close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  // Create new user with encrypted data
  async createUser(email, password, userData = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const salt = crypto.generateSalt();
        const passwordHash = crypto.hashPassword(password, salt);

        // Insert user
        const db = this.db;
        db.run(
          "INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?)",
          [email, passwordHash, salt],
          function (err) {
            if (err) {
              if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
                reject(new Error("User already exists"));
              } else {
                reject(err);
              }
            } else {
              const userId = this.lastID;

              // Create initial encrypted user data if provided
              if (Object.keys(userData).length > 0) {
                const emails = userData.emails || [];
                const settings = userData.settings || {};
                const checkinTokens = userData.checkinTokens || {};

                try {
                  const encryptedEmails = crypto.encryptEmails(
                    emails,
                    password,
                    salt,
                  );
                  const encryptedSettings = crypto.encryptSettings(
                    settings,
                    password,
                    salt,
                  );
                  const encryptedTokens = crypto.encryptData(
                    checkinTokens,
                    password,
                    salt,
                  );

                  // Use the same IV for all data for this user
                  const iv = encryptedEmails.iv;

                  db.run(
                    "INSERT INTO encrypted_user_data (user_id, encrypted_emails, encrypted_settings, encrypted_checkin_tokens, iv) VALUES (?, ?, ?, ?, ?)",
                    [
                      userId,
                      JSON.stringify(encryptedEmails),
                      JSON.stringify(encryptedSettings),
                      JSON.stringify(encryptedTokens),
                      iv,
                    ],
                    (err) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve({ userId, email, salt });
                      }
                    },
                  );
                } catch (encryptErr) {
                  reject(encryptErr);
                }
              } else {
                resolve({ userId, email, salt });
              }
            }
          },
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  // Authenticate user and return user data
  async authenticateUser(email, password) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT id, email, password_hash, salt, last_login FROM users WHERE email = ? AND is_active = 1",
        [email],
        async (err, user) => {
          if (err) {
            reject(err);
          } else if (!user) {
            reject(new Error("Invalid credentials"));
          } else {
            try {
              const isValid = crypto.verifyPassword(
                password,
                user.password_hash,
                user.salt,
              );

              if (isValid) {
                // Update last login
                this.db.run(
                  "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?",
                  [user.id],
                );

                // Get encrypted user data
                const userData = await this.getUserData(
                  user.id,
                  password,
                  user.salt,
                );

                resolve({
                  userId: user.id,
                  email: user.email,
                  salt: user.salt,
                  lastLogin: user.last_login,
                  ...userData,
                });
              } else {
                reject(new Error("Invalid credentials"));
              }
            } catch (authError) {
              reject(authError);
            }
          }
        },
      );
    });
  }

  // Get decrypted user data
  async getUserData(userId, password, salt) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT encrypted_emails, encrypted_settings, encrypted_checkin_tokens, iv FROM encrypted_user_data WHERE user_id = ?",
        [userId],
        (err, data) => {
          if (err) {
            reject(err);
          } else if (!data) {
            // No data exists yet, return empty defaults
            resolve({
              emails: [],
              settings: {},
              checkinTokens: {},
            });
          } else {
            try {
              let emails = [];
              let settings = {};
              let checkinTokens = {};

              if (data.encrypted_emails) {
                const encryptedEmails = JSON.parse(data.encrypted_emails);
                emails = crypto.decryptEmails(encryptedEmails, password, salt);
              }

              if (data.encrypted_settings) {
                const encryptedSettings = JSON.parse(data.encrypted_settings);
                settings = crypto.decryptSettings(
                  encryptedSettings,
                  password,
                  salt,
                );
              }

              if (data.encrypted_checkin_tokens) {
                const encryptedTokens = JSON.parse(
                  data.encrypted_checkin_tokens,
                );
                const tokensString = crypto.decryptData(
                  encryptedTokens,
                  password,
                  salt,
                );
                checkinTokens = JSON.parse(tokensString);
              }

              resolve({
                emails,
                settings,
                checkinTokens,
              });
            } catch (decryptError) {
              reject(
                new Error("Failed to decrypt user data - invalid password"),
              );
            }
          }
        },
      );
    });
  }

  // Update user's encrypted data
  async updateUserData(userId, password, salt, userData) {
    return new Promise((resolve, reject) => {
      try {
        const { emails = [], settings = {}, checkinTokens = {} } = userData;

        const encryptedEmails = crypto.encryptEmails(emails, password, salt);
        const encryptedSettings = crypto.encryptSettings(
          settings,
          password,
          salt,
        );
        const encryptedTokens = crypto.encryptData(
          checkinTokens,
          password,
          salt,
        );

        const iv = encryptedEmails.iv;

        // Check if user data exists
        this.db.get(
          "SELECT id FROM encrypted_user_data WHERE user_id = ?",
          [userId],
          (err, existing) => {
            if (err) {
              reject(err);
            } else if (existing) {
              // Update existing data
              this.db.run(
                "UPDATE encrypted_user_data SET encrypted_emails = ?, encrypted_settings = ?, encrypted_checkin_tokens = ?, iv = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?",
                [
                  JSON.stringify(encryptedEmails),
                  JSON.stringify(encryptedSettings),
                  JSON.stringify(encryptedTokens),
                  iv,
                  userId,
                ],
                (updateErr) => {
                  if (updateErr) {
                    reject(updateErr);
                  } else {
                    resolve();
                  }
                },
              );
            } else {
              // Insert new data
              this.db.run(
                "INSERT INTO encrypted_user_data (user_id, encrypted_emails, encrypted_settings, encrypted_checkin_tokens, iv) VALUES (?, ?, ?, ?, ?)",
                [
                  userId,
                  JSON.stringify(encryptedEmails),
                  JSON.stringify(encryptedSettings),
                  JSON.stringify(encryptedTokens),
                  iv,
                ],
                (insertErr) => {
                  if (insertErr) {
                    reject(insertErr);
                  } else {
                    resolve();
                  }
                },
              );
            }
          },
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  // Create active deadman session
  async createDeadmanSession(userId, settings) {
    return new Promise((resolve, reject) => {
      const sessionToken = crypto.generateSessionToken();
      const { checkinInterval, inactivityTimeout } = settings;

      this.db.run(
        "INSERT INTO deadman_sessions (user_id, session_token, checkin_interval_ms, inactivity_timeout_ms, last_activity, activated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [userId, sessionToken, checkinInterval, inactivityTimeout],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve({
              sessionId: this.lastID,
              sessionToken,
              checkinInterval,
              inactivityTimeout,
            });
          }
        },
      );
    });
  }

  // Persist the SECRET_KEY-encrypted delivery envelope for an active session so
  // the switch can fire unattended after a server restart (when the user's
  // password is not available to decrypt the primary, password-encrypted copy).
  async saveServerRecoverableEmails(sessionToken, encryptedBlob) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE deadman_sessions SET server_encrypted_emails = ? WHERE session_token = ?",
        [encryptedBlob, sessionToken],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        },
      );
    });
  }

  // Update deadman session activity
  async updateSessionActivity(sessionToken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE deadman_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_token = ? AND is_active = 1",
        [sessionToken],
        function (err) {
          if (err) {
            reject(err);
          } else if (this.changes === 0) {
            reject(new Error("Session not found or inactive"));
          } else {
            resolve();
          }
        },
      );
    });
  }

  // Get active deadman session
  async getActiveSession(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM deadman_sessions WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1",
        [userId],
        (err, session) => {
          if (err) {
            reject(err);
          } else {
            resolve(session);
          }
        },
      );
    });
  }

  // Deactivate deadman session
  async deactivateSession(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE deadman_sessions SET is_active = 0 WHERE user_id = ? AND is_active = 1",
        [userId],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        },
      );
    });
  }

  // Save timer state for persistence
  async saveTimerState(userId, timerState) {
    return new Promise((resolve, reject) => {
      const { nextCheckin, deadmanActivation, lastActivity } = timerState;

      this.db.run(
        `UPDATE deadman_sessions
                 SET last_activity = ?,
                     expires_at = ?
                 WHERE user_id = ? AND is_active = 1`,
        [lastActivity, new Date(deadmanActivation).toISOString(), userId],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        },
      );
    });
  }

  // Get all sessions that still need recovery on startup: every session that
  // has not been triggered/closed (is_active = 1), INCLUDING ones whose
  // deadline already passed while the server was down — recovery must fire
  // those, not ignore them.
  async getAllRecoverableSessions() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ds.*, u.email
                 FROM deadman_sessions ds
                 JOIN users u ON ds.user_id = u.id
                 WHERE ds.is_active = 1`,
        [],
        (err, sessions) => {
          if (err) {
            reject(err);
          } else {
            resolve(sessions || []);
          }
        },
      );
    });
  }

  // Get all active (not-yet-expired) deadman sessions
  async getAllActiveSessions() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ds.*, u.email
                 FROM deadman_sessions ds
                 JOIN users u ON ds.user_id = u.id
                 WHERE ds.is_active = 1 AND ds.expires_at > CURRENT_TIMESTAMP`,
        [],
        (err, sessions) => {
          if (err) {
            reject(err);
          } else {
            resolve(sessions || []);
          }
        },
      );
    });
  }

  // Check if session is still valid (not expired)
  async isSessionValid(sessionToken) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM deadman_sessions
                 WHERE session_token = ? AND is_active = 1 AND expires_at > CURRENT_TIMESTAMP`,
        [sessionToken],
        (err, session) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!session);
          }
        },
      );
    });
  }

  // Mark session as expired/triggered
  async markSessionTriggered(sessionToken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE deadman_sessions SET is_active = 0 WHERE session_token = ?",
        [sessionToken],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        },
      );
    });
  }

  // ---- Pre-fire warning escalation state (Issue #1/#2) ----

  // Persist the consecutive-missed-check-in counter so escalation state
  // survives a server restart.
  async setMissedCheckins(sessionToken, count) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE deadman_sessions SET missed_checkins = ? WHERE session_token = ? AND is_active = 1",
        [count, sessionToken],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        },
      );
    });
  }

  // Record that the beneficiary pre-fire warning went out. warning_sent_at
  // keeps the FIRST send time across resends (escalation resends reuse the
  // same ack token).
  async setWarningSent(sessionToken, ackToken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE deadman_sessions
                 SET warning_ack_token = ?,
                     warning_sent_at = COALESCE(warning_sent_at, CURRENT_TIMESTAMP)
                 WHERE session_token = ? AND is_active = 1`,
        [ackToken, sessionToken],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        },
      );
    });
  }

  // Operator checked in after a warning went out: reset the whole
  // escalation state so a future lapse starts a fresh cycle.
  async clearWarningState(sessionToken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE deadman_sessions
                 SET missed_checkins = 0,
                     warning_sent_at = NULL,
                     warning_ack_at = NULL,
                     warning_ack_token = NULL
                 WHERE session_token = ?`,
        [sessionToken],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        },
      );
    });
  }

  // Beneficiary clicked the warning acknowledgment link. Returns the session
  // row (with operator email) or null if the token is unknown.
  async ackWarningByToken(ackToken) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT ds.*, u.email
                 FROM deadman_sessions ds
                 JOIN users u ON ds.user_id = u.id
                 WHERE ds.warning_ack_token = ? AND ds.is_active = 1`,
        [ackToken],
        (err, session) => {
          if (err) return reject(err);
          if (!session) return resolve(null);
          this.db.run(
            "UPDATE deadman_sessions SET warning_ack_at = COALESCE(warning_ack_at, CURRENT_TIMESTAMP) WHERE id = ?",
            [session.id],
            (updateErr) => {
              if (updateErr) reject(updateErr);
              else resolve(session);
            },
          );
        },
      );
    });
  }

  // ---- Beneficiary channel liveness pings (Issue #2) ----
  // Addresses are keyed by SHA-256 hash only; plaintext never lands here.

  async getBeneficiaryPing(userId, emailHash) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM beneficiary_pings WHERE user_id = ? AND email_hash = ?",
        [userId, emailHash],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  }

  // Start a new ping cycle for this beneficiary (fresh token, ack cleared).
  async saveBeneficiaryPingSent(userId, emailHash, pingToken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO beneficiary_pings (user_id, email_hash, ping_token, ping_sent_at, ack_at, operator_alerted_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL, NULL)
                 ON CONFLICT(user_id, email_hash) DO UPDATE SET
                     ping_token = excluded.ping_token,
                     ping_sent_at = CURRENT_TIMESTAMP,
                     ack_at = NULL,
                     operator_alerted_at = NULL`,
        [userId, emailHash, pingToken],
        function (err) {
          if (err) reject(err);
          else resolve(true);
        },
      );
    });
  }

  // Beneficiary replied to the liveness ping. Returns the ping row (joined
  // with the operator's email for the confirmation page) or null.
  async ackBeneficiaryPingByToken(pingToken) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT bp.*, u.email
                 FROM beneficiary_pings bp
                 JOIN users u ON bp.user_id = u.id
                 WHERE bp.ping_token = ?`,
        [pingToken],
        (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          this.db.run(
            "UPDATE beneficiary_pings SET ack_at = COALESCE(ack_at, CURRENT_TIMESTAMP) WHERE id = ?",
            [row.id],
            (updateErr) => {
              if (updateErr) reject(updateErr);
              else resolve(row);
            },
          );
        },
      );
    });
  }

  // Remember that the operator was already alerted about this unacked ping
  // so the daily sweep doesn't re-alert every day.
  async markPingOperatorAlerted(pingId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE beneficiary_pings SET operator_alerted_at = CURRENT_TIMESTAMP WHERE id = ?",
        [pingId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        },
      );
    });
  }

  // Log audit event
  async logAudit(userId, action, details, ipAddress, userAgent) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "INSERT INTO audit_log (user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)",
        [userId, action, details, ipAddress, userAgent],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }

  // Get user by ID
  async getUserById(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT id, email, salt, created_at, last_login, is_active FROM users WHERE id = ?",
        [userId],
        (err, user) => {
          if (err) {
            reject(err);
          } else {
            resolve(user);
          }
        },
      );
    });
  }

  // Delete user and all associated data
  async deleteUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run("BEGIN TRANSACTION");

        this.db.run("DELETE FROM audit_log WHERE user_id = ?", [userId]);
        this.db.run("DELETE FROM deadman_sessions WHERE user_id = ?", [userId]);
        this.db.run("DELETE FROM encrypted_user_data WHERE user_id = ?", [
          userId,
        ]);
        this.db.run("DELETE FROM users WHERE id = ?", [userId], function (err) {
          if (err) {
            this.db.run("ROLLBACK");
            reject(err);
          } else {
            this.db.run("COMMIT", (commitErr) => {
              if (commitErr) {
                reject(commitErr);
              } else {
                resolve(this.changes > 0);
              }
            });
          }
        });
      });
    });
  }
}

module.exports = UserService;
