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

  // Close a session. With `fired`, also record that the switch actually
  // fired (as opposed to being aborted or superseded) and how many trigger
  // emails were delivered, so the fired state can be shown after a restart.
  async markSessionTriggered(sessionToken, fired = null) {
    return new Promise((resolve, reject) => {
      const sql = fired
        ? "UPDATE deadman_sessions SET is_active = 0, triggered_at = CURRENT_TIMESTAMP, triggered_emails_sent = ? WHERE session_token = ?"
        : "UPDATE deadman_sessions SET is_active = 0 WHERE session_token = ?";
      const params = fired
        ? [fired.emailsSent || 0, sessionToken]
        : [sessionToken];
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  // Most recent fire record for a user, or null if the switch has never
  // fired (or the record was cleared by a reset / new deployment).
  async getLastTriggeredSession(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT triggered_at, triggered_emails_sent
           FROM deadman_sessions
          WHERE user_id = ? AND triggered_at IS NOT NULL
          ORDER BY triggered_at DESC
          LIMIT 1`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  }

  // Forget that the switch fired (operator reset, or a fresh deployment).
  async clearTriggeredHistory(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE deadman_sessions SET triggered_at = NULL WHERE user_id = ?",
        [userId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
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
  // keeps the FIRST send time across resends. (warning_ack_token is unused
  // since v2.2.0 — acks arrive as reply codes keyed by session — and is
  // left in place: SQLite columns are never dropped.)
  async setWarningSent(sessionToken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE deadman_sessions
                 SET warning_sent_at = COALESCE(warning_sent_at, CURRENT_TIMESTAMP)
                 WHERE session_token = ? AND is_active = 1`,
        [sessionToken],
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

  // Start a new ping cycle for this beneficiary (ack cleared). The code that
  // answers it lives in reply_codes (kind ping-ack, ref = this row's id);
  // ping_token is unused since v2.2.0 and left in place.
  async saveBeneficiaryPingSent(userId, emailHash) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO beneficiary_pings (user_id, email_hash, ping_sent_at, ack_at, operator_alerted_at)
                 VALUES (?, ?, CURRENT_TIMESTAMP, NULL, NULL)
                 ON CONFLICT(user_id, email_hash) DO UPDATE SET
                     ping_sent_at = CURRENT_TIMESTAMP,
                     ack_at = NULL,
                     operator_alerted_at = NULL`,
        [userId, emailHash],
        function (err) {
          if (err) reject(err);
          else resolve(true);
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

  // ---- Reply codes (v2.2.0) ----
  // The code a reader types back IS the token; only its hash is stored.
  // Rows are never deleted while the user exists: a used or retired code
  // must stay recognisable so a stale reply can be answered with "that code
  // has expired" rather than silence.

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  // Issue a fresh code. Returns the plaintext code exactly once — it is not
  // stored and cannot be recovered afterwards.
  //
  // Beneficiary kinds (ping-ack, warning-ack): exactly one live code per
  // slot — every live code with the same (user_id, kind, ref, recipient) is
  // retired first.
  //
  // Operator kinds (arming, checkin): previous codes STAY live. Retiring on
  // issue turned any reply that crossed a check-in tick into "expired" —
  // seen live 2026-09-18: the operator answered the older of two emails a
  // few seconds after the newer one went out, was told it had expired, and
  // the switch fired on a living operator who had replied three times. All
  // outstanding codes went to the same inbox for the same purpose, so
  // keeping them live costs nothing; a successful check-in retires them
  // all (see routes performCheckin), and at most MAX_LIVE_OPERATOR_CODES
  // are outstanding — the oldest beyond that are retired.
  async issueCode({ kind, userId, recipientHash = null, ref = null }) {
    const codes = require("../utils/codes");
    if (!["arming", "checkin", "ping-ack", "warning-ack"].includes(kind)) {
      throw new Error(`Unknown reply-code kind: ${kind}`);
    }
    const operatorKind = kind === "arming" || kind === "checkin";
    if (!operatorKind) {
      await this.retireCodes({ userId, kind, ref, recipientHash });
    }

    // The UNIQUE on code_hash makes a collision an insert error rather than
    // a silent overwrite; retry with a new code (astronomically rare).
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = codes.generateCode();
      const hash = codes.hashCode(code);
      try {
        const { lastID } = await this._run(
          `INSERT INTO reply_codes (code_hash, kind, user_id, recipient_hash, ref)
           VALUES (?, ?, ?, ?, ?)`,
          [hash, kind, userId, recipientHash, ref],
        );
        if (operatorKind) await this._capLiveOperatorCodes(userId);
        return { id: lastID, code, hash };
      } catch (err) {
        if (err.code !== "SQLITE_CONSTRAINT_UNIQUE" && !/UNIQUE/i.test(err.message)) {
          throw err;
        }
      }
    }
    throw new Error("Could not issue a unique reply code");
  }

  // Keep at most MAX_LIVE_OPERATOR_CODES arming/check-in codes live per
  // operator (oldest retired first).
  async _capLiveOperatorCodes(userId) {
    const rows = await this._all(
      `SELECT id FROM reply_codes
        WHERE user_id = ? AND kind IN ('arming', 'checkin')
          AND used_at IS NULL AND retired_at IS NULL
        ORDER BY id DESC`,
      [userId],
    );
    const excess = rows.slice(UserService.MAX_LIVE_OPERATOR_CODES).map((r) => r.id);
    if (excess.length) {
      await this._run(
        `UPDATE reply_codes SET retired_at = CURRENT_TIMESTAMP WHERE id IN (${excess.map(() => "?").join(",")})`,
        excess,
      );
    }
    return excess.length;
  }

  // Retire every live code matching the given slot. Any of kind/ref/
  // recipientHash may be omitted to widen the match; `kinds` (array) may be
  // given instead of `kind`. Returns the number retired.
  async retireCodes({ userId, kind = null, kinds = null, ref = null, recipientHash = null }) {
    const where = ["user_id = ?", "used_at IS NULL", "retired_at IS NULL"];
    const params = [userId];
    if (kinds && kinds.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    } else if (kind) {
      where.push("kind = ?");
      params.push(kind);
    }
    if (ref !== null && ref !== undefined) {
      where.push("ref = ?");
      params.push(String(ref));
    }
    if (recipientHash) {
      where.push("recipient_hash = ?");
      params.push(recipientHash);
    }
    const { changes } = await this._run(
      `UPDATE reply_codes SET retired_at = CURRENT_TIMESTAMP WHERE ${where.join(" AND ")}`,
      params,
    );
    return changes;
  }

  // The row for a hash if that code is live (neither used nor retired).
  async findLiveCode(hash) {
    return this._get(
      `SELECT rc.*, u.email AS user_email
         FROM reply_codes rc
         JOIN users u ON rc.user_id = u.id
        WHERE rc.code_hash = ? AND rc.used_at IS NULL AND rc.retired_at IS NULL`,
      [hash],
    );
  }

  // The row for a hash in any state — used to recognise a stale code.
  async findCodeByHash(hash) {
    return this._get(
      `SELECT rc.*, u.email AS user_email
         FROM reply_codes rc
         JOIN users u ON rc.user_id = u.id
        WHERE rc.code_hash = ?`,
      [hash],
    );
  }

  // The live code (if any) for a slot. ref may be omitted.
  async liveCodeFor(userId, kind, ref = null, recipientHash = null) {
    const where = ["user_id = ?", "kind = ?", "used_at IS NULL", "retired_at IS NULL"];
    const params = [userId, kind];
    if (ref !== null && ref !== undefined) {
      where.push("ref = ?");
      params.push(String(ref));
    }
    if (recipientHash) {
      where.push("recipient_hash = ?");
      params.push(recipientHash);
    }
    return this._get(
      `SELECT * FROM reply_codes WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 1`,
      params,
    );
  }

  // Every live code that was sent to this address (any kind, any user),
  // newest first — the wrong-guess path needs to know whether a sender holds
  // a live code at all before it answers.
  async liveCodesForRecipientHash(recipientHash) {
    return this._all(
      `SELECT rc.*, u.email AS user_email
         FROM reply_codes rc
         JOIN users u ON rc.user_id = u.id
        WHERE rc.recipient_hash = ? AND rc.used_at IS NULL AND rc.retired_at IS NULL
        ORDER BY rc.id DESC`,
      [recipientHash],
    );
  }

  async markCodeUsed(id) {
    const { changes } = await this._run(
      "UPDATE reply_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL",
      [id],
    );
    return changes > 0;
  }

  async retireCode(id) {
    const { changes } = await this._run(
      "UPDATE reply_codes SET retired_at = CURRENT_TIMESTAMP WHERE id = ? AND retired_at IS NULL",
      [id],
    );
    return changes > 0;
  }

  // Increment the wrong-guess counter on a live code; returns the new count.
  async bumpFailedAttempts(id) {
    await this._run(
      "UPDATE reply_codes SET failed_attempts = failed_attempts + 1 WHERE id = ?",
      [id],
    );
    const row = await this._get(
      "SELECT failed_attempts FROM reply_codes WHERE id = ?",
      [id],
    );
    return row ? row.failed_attempts : 0;
  }

  // ---- Service settings (key/value) ----
  // Shared with the Start9 config blob under key "config"; the inbound mail
  // poller keeps its per-folder cursor here (imap:<folder>:uidvalidity,
  // imap:<folder>:lastuid), plus imap:down_since and migrated_reply_codes.

  async getSetting(key) {
    const row = await this._get("SELECT value FROM settings WHERE key = ?", [key]);
    return row ? row.value : null;
  }

  async setSetting(key, value) {
    await this._run(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [key, value === null || value === undefined ? null : String(value)],
    );
  }

  async deleteSetting(key) {
    await this._run("DELETE FROM settings WHERE key = ?", [key]);
  }

  // ---- Beneficiary ping rows by id (reply-code era) ----

  // Make sure a ping row exists for this address so a ping-ack code can
  // reference its id BEFORE the email is sent. A row with ping_sent_at NULL
  // still reads as "never contacted" to pingAction(), so the send-then-commit
  // idempotency the serial queue relies on is unchanged.
  async ensureBeneficiaryPingRow(userId, emailHash) {
    await this._run(
      `INSERT OR IGNORE INTO beneficiary_pings (user_id, email_hash) VALUES (?, ?)`,
      [userId, emailHash],
    );
    return this.getBeneficiaryPing(userId, emailHash);
  }

  // Beneficiary answered the ping with its code. Returns the row (joined
  // with the operator's email) as it was BEFORE ack_at was stamped, or null.
  async ackBeneficiaryPingById(pingId) {
    const row = await this._get(
      `SELECT bp.*, u.email
         FROM beneficiary_pings bp
         JOIN users u ON bp.user_id = u.id
        WHERE bp.id = ?`,
      [pingId],
    );
    if (!row) return null;
    await this._run(
      "UPDATE beneficiary_pings SET ack_at = COALESCE(ack_at, CURRENT_TIMESTAMP) WHERE id = ?",
      [row.id],
    );
    return row;
  }

  // Every ping that went out and was never answered — the upgrade path
  // re-sends these with a code, since their old link can no longer be used.
  async getUnansweredBeneficiaryPings() {
    return this._all(
      `SELECT * FROM beneficiary_pings WHERE ping_sent_at IS NOT NULL AND ack_at IS NULL`,
    );
  }

  // Beneficiary answered the pre-fire warning with its code (keyed by the
  // session the warning belongs to). Returns the session row or null.
  async ackWarningBySession(sessionToken) {
    const session = await this._get(
      `SELECT ds.*, u.email
         FROM deadman_sessions ds
         JOIN users u ON ds.user_id = u.id
        WHERE ds.session_token = ? AND ds.is_active = 1`,
      [sessionToken],
    );
    if (!session) return null;
    await this._run(
      "UPDATE deadman_sessions SET warning_ack_at = COALESCE(warning_ack_at, CURRENT_TIMESTAMP) WHERE id = ?",
      [session.id],
    );
    return session;
  }

  // How the last check-in arrived ("reply" | "dashboard") and when.
  async setLastCheckinVia(sessionToken, via) {
    await this._run(
      "UPDATE deadman_sessions SET last_checkin_via = ?, last_checkin_at = CURRENT_TIMESTAMP WHERE session_token = ?",
      [via, sessionToken],
    );
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
    // `this` inside sqlite3's run callback is the Statement, not the
    // service — capture the handle first or COMMIT/ROLLBACK throw.
    const db = this.db;
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        db.run("DELETE FROM audit_log WHERE user_id = ?", [userId]);
        db.run("DELETE FROM reply_codes WHERE user_id = ?", [userId]);
        db.run("DELETE FROM beneficiary_pings WHERE user_id = ?", [userId]);
        db.run("DELETE FROM deadman_sessions WHERE user_id = ?", [userId]);
        db.run("DELETE FROM encrypted_user_data WHERE user_id = ?", [
          userId,
        ]);
        db.run("DELETE FROM users WHERE id = ?", [userId], function (err) {
          if (err) {
            db.run("ROLLBACK");
            reject(err);
          } else {
            db.run("COMMIT", (commitErr) => {
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

UserService.MAX_LIVE_OPERATOR_CODES = 5;

module.exports = UserService;
