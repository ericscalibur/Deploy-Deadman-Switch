const crypto = require("crypto");

// Encryption configuration
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000; // OWASP recommended minimum

/**
 * Generate a cryptographically secure random salt
 * @returns {string} Base64 encoded salt
 */
function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH).toString("base64");
}

/**
 * Generate a cryptographically secure random IV
 * @returns {Buffer} Initialization Vector
 */
function generateIV() {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Derive encryption key from password using PBKDF2
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {Buffer} Derived key
 */
function deriveKey(password, salt) {
  const saltBuffer = Buffer.from(salt, "base64");
  return crypto.pbkdf2Sync(
    password,
    saltBuffer,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256",
  );
}

/**
 * Hash password for database storage
 * @param {string} password - Plain text password
 * @param {string} salt - Base64 encoded salt
 * @returns {string} Base64 encoded password hash
 */
function hashPassword(password, salt) {
  const key = deriveKey(password, salt);
  return key.toString("base64");
}

/**
 * Verify password against stored hash
 * @param {string} password - Plain text password to verify
 * @param {string} storedHash - Base64 encoded stored hash
 * @param {string} salt - Base64 encoded salt
 * @returns {boolean} True if password matches
 */
function verifyPassword(password, storedHash, salt) {
  const hash = hashPassword(password, salt);
  return crypto.timingSafeEqual(
    Buffer.from(hash, "base64"),
    Buffer.from(storedHash, "base64"),
  );
}

/**
 * Encrypt data using AES-256-GCM with password-derived key
 * @param {string|object} data - Data to encrypt (will be JSON stringified if object)
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {object} Encrypted data with IV and auth tag
 */
function encryptData(data, password, salt) {
  try {
    // Convert data to string if it's an object
    const plaintext = typeof data === "string" ? data : JSON.stringify(data);

    // Derive encryption key from password
    const key = deriveKey(password, salt);

    // Generate random IV
    const iv = generateIV();

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(salt, "base64")); // Use salt as additional authenticated data

    // Encrypt data
    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    return {
      encrypted: encrypted,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      algorithm: ALGORITHM,
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt data using AES-256-GCM with password-derived key
 * @param {object} encryptedData - Object containing encrypted, iv, and authTag
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {string} Decrypted plaintext
 */
function decryptData(encryptedData, password, salt) {
  try {
    const { encrypted, iv, authTag } = encryptedData;

    // Derive decryption key from password
    const key = deriveKey(password, salt);

    // Create decipher
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(salt, "base64")); // Use salt as additional authenticated data
    decipher.setAuthTag(Buffer.from(authTag, "base64"));

    // Decrypt data
    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Encrypt user emails array
 * @param {array} emails - Array of email objects
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {object} Encrypted emails with metadata
 */
function encryptEmails(emails, password, salt) {
  if (!Array.isArray(emails)) {
    throw new Error("Emails must be an array");
  }

  return encryptData(emails, password, salt);
}

/**
 * Decrypt user emails array
 * @param {object} encryptedEmails - Encrypted emails object
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {array} Decrypted emails array
 */
function decryptEmails(encryptedEmails, password, salt) {
  const decryptedString = decryptData(encryptedEmails, password, salt);
  return JSON.parse(decryptedString);
}

/**
 * Encrypt deadman switch settings
 * @param {object} settings - Deadman switch configuration
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {object} Encrypted settings with metadata
 */
function encryptSettings(settings, password, salt) {
  if (typeof settings !== "object") {
    throw new Error("Settings must be an object");
  }

  return encryptData(settings, password, salt);
}

/**
 * Decrypt deadman switch settings
 * @param {object} encryptedSettings - Encrypted settings object
 * @param {string} password - User's password
 * @param {string} salt - Base64 encoded salt
 * @returns {object} Decrypted settings object
 */
function decryptSettings(encryptedSettings, password, salt) {
  const decryptedString = decryptData(encryptedSettings, password, salt);
  return JSON.parse(decryptedString);
}

/**
 * Resolve the server-held encryption key from SECRET_KEY.
 * SECRET_KEY is a base64-encoded 32-byte value (see generate_secret.py) also
 * used for JWT signing. This key lives only in the environment (.env), never in
 * the database, so a stolen DB file cannot be decrypted with it.
 * @returns {Buffer} 32-byte AES key
 */
function getServerKey() {
  const secret = process.env.SECRET_KEY;
  if (!secret) {
    throw new Error("SECRET_KEY is not set; cannot derive server key");
  }
  const key = Buffer.from(secret, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `SECRET_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * Encrypt data under the server-held key (SECRET_KEY), for data the server must
 * be able to recover unattended after a restart (e.g. the deadman delivery
 * envelope). Returns a single self-contained base64 blob string.
 *
 * Threat model: protects against theft of the database file / backups (the key
 * is not in the DB). It does NOT protect against full compromise of the running
 * server, which has SECRET_KEY. Keep true secrets in recipient-encrypted
 * payloads, not in data encrypted with this function.
 *
 * @param {string|object} data - Data to encrypt (JSON stringified if object)
 * @returns {string} Compact JSON blob: {v, iv, tag, data} (all base64)
 */
function encryptWithServerKey(data) {
  const plaintext = typeof data === "string" ? data : JSON.stringify(data);
  const key = getServerKey();
  const iv = generateIV();

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    data: encrypted,
  });
}

/**
 * Decrypt a blob produced by encryptWithServerKey.
 * @param {string} blob - The JSON blob string
 * @returns {string} Decrypted plaintext
 */
function decryptWithServerKey(blob) {
  const { iv, tag, data } = typeof blob === "string" ? JSON.parse(blob) : blob;
  const key = getServerKey();

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  let decrypted = decipher.update(data, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Encrypt an emails array under the server key and return a storable blob.
 * @param {array} emails - Array of email objects
 * @returns {string} Server-key blob string
 */
function encryptEmailsWithServerKey(emails) {
  if (!Array.isArray(emails)) {
    throw new Error("Emails must be an array");
  }
  return encryptWithServerKey(emails);
}

/**
 * Decrypt an emails blob produced by encryptEmailsWithServerKey.
 * @param {string} blob - Server-key blob string
 * @returns {array} Decrypted emails array
 */
function decryptEmailsWithServerKey(blob) {
  return JSON.parse(decryptWithServerKey(blob));
}

/**
 * Generate secure session token
 * @returns {string} Random session token
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Generate secure checkin token
 * @returns {string} Random checkin token
 */
function generateCheckinToken() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Validate encryption integrity
 * @param {object} encryptedData - Encrypted data object
 * @returns {boolean} True if data structure is valid
 */
function validateEncryptedData(encryptedData) {
  return (
    encryptedData &&
    typeof encryptedData.encrypted === "string" &&
    typeof encryptedData.iv === "string" &&
    typeof encryptedData.authTag === "string" &&
    encryptedData.algorithm === ALGORITHM
  );
}

/**
 * Securely clear sensitive data from memory
 * @param {Buffer|string} data - Data to clear
 */
function clearSensitiveData(data) {
  if (Buffer.isBuffer(data)) {
    data.fill(0);
  } else if (typeof data === "string") {
    // Note: Strings are immutable in JS, so this is best effort
    data = null;
  }
}

module.exports = {
  // Core encryption functions
  generateSalt,
  generateIV,
  deriveKey,
  encryptData,
  decryptData,

  // Password functions
  hashPassword,
  verifyPassword,

  // Specialized encryption for app data
  encryptEmails,
  decryptEmails,
  encryptSettings,
  decryptSettings,

  // Server-key encryption (for restart-recoverable delivery envelope)
  getServerKey,
  encryptWithServerKey,
  decryptWithServerKey,
  encryptEmailsWithServerKey,
  decryptEmailsWithServerKey,

  // Token generation
  generateSessionToken,
  generateCheckinToken,

  // Utility functions
  validateEncryptedData,
  clearSensitiveData,

  // Constants for external use
  PBKDF2_ITERATIONS,
  KEY_LENGTH,
  IV_LENGTH,
  SALT_LENGTH,
  ALGORITHM,
};
