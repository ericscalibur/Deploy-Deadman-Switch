const sqlite3 = require('sqlite3').verbose();
const crypto = require('./crypto');
const { DB_PATH } = require('./init');

class UserService {
    constructor() {
        this.db = null;
    }

    // Initialize database connection
    async connect() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(DB_PATH, (err) => {
                if (err) {
                    reject(err);
                } else {
                    // Enable foreign keys
                    this.db.run('PRAGMA foreign_keys = ON;');
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
                this.db.run(
                    'INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?)',
                    [email, passwordHash, salt],
                    function(err) {
                        if (err) {
                            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                                reject(new Error('User already exists'));
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
                                    const encryptedEmails = crypto.encryptEmails(emails, password, salt);
                                    const encryptedSettings = crypto.encryptSettings(settings, password, salt);
                                    const encryptedTokens = crypto.encryptData(checkinTokens, password, salt);

                                    // Use the same IV for all data for this user
                                    const iv = encryptedEmails.iv;

                                    this.db.run(
                                        'INSERT INTO encrypted_user_data (user_id, encrypted_emails, encrypted_settings, encrypted_checkin_tokens, iv) VALUES (?, ?, ?, ?, ?)',
                                        [
                                            userId,
                                            JSON.stringify(encryptedEmails),
                                            JSON.stringify(encryptedSettings),
                                            JSON.stringify(encryptedTokens),
                                            iv
                                        ],
                                        (err) => {
                                            if (err) {
                                                reject(err);
                                            } else {
                                                resolve({ userId, email, salt });
                                            }
                                        }
                                    );
                                } catch (encryptErr) {
                                    reject(encryptErr);
                                }
                            } else {
                                resolve({ userId, email, salt });
                            }
                        }
                    }
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
                'SELECT id, email, password_hash, salt, last_login FROM users WHERE email = ? AND is_active = 1',
                [email],
                async (err, user) => {
                    if (err) {
                        reject(err);
                    } else if (!user) {
                        reject(new Error('Invalid credentials'));
                    } else {
                        try {
                            const isValid = crypto.verifyPassword(password, user.password_hash, user.salt);

                            if (isValid) {
                                // Update last login
                                this.db.run(
                                    'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
                                    [user.id]
                                );

                                // Get encrypted user data
                                const userData = await this.getUserData(user.id, password, user.salt);

                                resolve({
                                    userId: user.id,
                                    email: user.email,
                                    salt: user.salt,
                                    lastLogin: user.last_login,
                                    ...userData
                                });
                            } else {
                                reject(new Error('Invalid credentials'));
                            }
                        } catch (authError) {
                            reject(authError);
                        }
                    }
                }
            );
        });
    }

    // Get decrypted user data
    async getUserData(userId, password, salt) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT encrypted_emails, encrypted_settings, encrypted_checkin_tokens, iv FROM encrypted_user_data WHERE user_id = ?',
                [userId],
                (err, data) => {
                    if (err) {
                        reject(err);
                    } else if (!data) {
                        // No data exists yet, return empty defaults
                        resolve({
                            emails: [],
                            settings: {},
                            checkinTokens: {}
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
                                settings = crypto.decryptSettings(encryptedSettings, password, salt);
                            }

                            if (data.encrypted_checkin_tokens) {
                                const encryptedTokens = JSON.parse(data.encrypted_checkin_tokens);
                                const tokensString = crypto.decryptData(encryptedTokens, password, salt);
                                checkinTokens = JSON.parse(tokensString);
                            }

                            resolve({
                                emails,
                                settings,
                                checkinTokens
                            });
                        } catch (decryptError) {
                            reject(new Error('Failed to decrypt user data - invalid password'));
                        }
                    }
                }
            );
        });
    }

    // Update user's encrypted data
    async updateUserData(userId, password, salt, userData) {
        return new Promise((resolve, reject) => {
            try {
                const { emails = [], settings = {}, checkinTokens = {} } = userData;

                const encryptedEmails = crypto.encryptEmails(emails, password, salt);
                const encryptedSettings = crypto.encryptSettings(settings, password, salt);
                const encryptedTokens = crypto.encryptData(checkinTokens, password, salt);

                const iv = encryptedEmails.iv;

                // Check if user data exists
                this.db.get(
                    'SELECT id FROM encrypted_user_data WHERE user_id = ?',
                    [userId],
                    (err, existing) => {
                        if (err) {
                            reject(err);
                        } else if (existing) {
                            // Update existing data
                            this.db.run(
                                'UPDATE encrypted_user_data SET encrypted_emails = ?, encrypted_settings = ?, encrypted_checkin_tokens = ?, iv = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                                [
                                    JSON.stringify(encryptedEmails),
                                    JSON.stringify(encryptedSettings),
                                    JSON.stringify(encryptedTokens),
                                    iv,
                                    userId
                                ],
                                (updateErr) => {
                                    if (updateErr) {
                                        reject(updateErr);
                                    } else {
                                        resolve();
                                    }
                                }
                            );
                        } else {
                            // Insert new data
                            this.db.run(
                                'INSERT INTO encrypted_user_data (user_id, encrypted_emails, encrypted_settings, encrypted_checkin_tokens, iv) VALUES (?, ?, ?, ?, ?)',
                                [
                                    userId,
                                    JSON.stringify(encryptedEmails),
                                    JSON.stringify(encryptedSettings),
                                    JSON.stringify(encryptedTokens),
                                    iv
                                ],
                                (insertErr) => {
                                    if (insertErr) {
                                        reject(insertErr);
                                    } else {
                                        resolve();
                                    }
                                }
                            );
                        }
                    }
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
                'INSERT INTO deadman_sessions (user_id, session_token, checkin_interval_ms, inactivity_timeout_ms, last_activity, activated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
                [userId, sessionToken, checkinInterval, inactivityTimeout],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({
                            sessionId: this.lastID,
                            sessionToken,
                            checkinInterval,
                            inactivityTimeout
                        });
                    }
                }
            );
        });
    }

    // Update deadman session activity
    async updateSessionActivity(sessionToken) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE deadman_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_token = ? AND is_active = 1',
                [sessionToken],
                function(err) {
                    if (err) {
                        reject(err);
                    } else if (this.changes === 0) {
                        reject(new Error('Session not found or inactive'));
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    // Get active deadman session
    async getActiveSession(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM deadman_sessions WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1',
                [userId],
                (err, session) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(session);
                    }
                }
            );
        });
    }

    // Deactivate deadman session
    async deactivateSession(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE deadman_sessions SET is_active = 0 WHERE user_id = ? AND is_active = 1',
                [userId],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes > 0);
                    }
                }
            );
        });
    }

    // Log audit event
    async logAudit(userId, action, details, ipAddress, userAgent) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO audit_log (user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
                [userId, action, details, ipAddress, userAgent],
                (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    // Get user by ID
    async getUserById(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT id, email, salt, created_at, last_login, is_active FROM users WHERE id = ?',
                [userId],
                (err, user) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(user);
                    }
                }
            );
        });
    }

    // Delete user and all associated data
    async deleteUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                this.db.run('DELETE FROM audit_log WHERE user_id = ?', [userId]);
                this.db.run('DELETE FROM deadman_sessions WHERE user_id = ?', [userId]);
                this.db.run('DELETE FROM encrypted_user_data WHERE user_id = ?', [userId]);
                this.db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
                    if (err) {
                        this.db.run('ROLLBACK');
                        reject(err);
                    } else {
                        this.db.run('COMMIT', (commitErr) => {
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
