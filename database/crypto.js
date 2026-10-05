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

// ---- Key derivation (v2.3.0: separate keys for login and for data) ----
//
// Before v2.3.0 the stored password hash WAS the AES key: hashPassword()
// returned the PBKDF2 output and encryptData() used the same output as the
// key, so anyone holding the database (a backup, a stolen disk) could
// base64-decode users.password_hash and decrypt every user's data without
// knowing a password. Now one PBKDF2 "master" is split with HKDF into two
// independent keys: a login verifier (stored, prefixed "v2$") and a data key
// (never stored). Legacy hashes and legacy blobs are still read; a user's
// data is re-encrypted and their hash replaced at their next login
// (userService.authenticateUser).

const HASH_V2_PREFIX = "v2$";

// PBKDF2 is deliberately slow and runs on the event loop when synchronous.
// Most requests derive the same master several times (one per encrypted
// field), so a short-lived cache keyed by sha256(salt|password) keeps the
// server responsive; entries expire after five minutes.
const MASTER_CACHE_TTL_MS = 5 * 60 * 1000;
const MASTER_CACHE_MAX = 32;
const masterCache = new Map();

function masterCacheKey(password, salt) {
  return crypto
    .createHash("sha256")
    .update(String(salt))
    .update("\0")
    .update(String(password))
    .digest("hex");
}

function cacheMaster(k, master) {
  masterCache.set(k, { master, at: Date.now() });
  if (masterCache.size > MASTER_CACHE_MAX) {
    masterCache.delete(masterCache.keys().next().value);
  }
}

function cachedMaster(k) {
  const hit = masterCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > MASTER_CACHE_TTL_MS) {
    masterCache.delete(k);
    return null;
  }
  return hit.master;
}

/**
 * PBKDF2 master derived from the password. Not itself a key for anything
 * new: in v2 it only feeds HKDF. (Legacy data and hashes used it directly.)
 */
function deriveKey(password, salt) {
  const k = masterCacheKey(password, salt);
  const hit = cachedMaster(k);
  if (hit) return hit;
  const master = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, "base64"),
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256",
  );
  cacheMaster(k, master);
  return master;
}

/** Same as deriveKey, without blocking the event loop (login/signup). */
function deriveKeyAsync(password, salt) {
  const k = masterCacheKey(password, salt);
  const hit = cachedMaster(k);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      Buffer.from(salt, "base64"),
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      "sha256",
      (err, master) => {
        if (err) return reject(err);
        cacheMaster(k, master);
        resolve(master);
      },
    );
  });
}

function hkdf(master, salt, info) {
  return Buffer.from(
    crypto.hkdfSync("sha256", master, Buffer.from(salt, "base64"), info, KEY_LENGTH),
  );
}

function dataKeyFromMaster(master, salt) {
  return hkdf(master, salt, "deploy-v2-data-encryption");
}

function verifierFromMaster(master, salt) {
  return hkdf(master, salt, "deploy-v2-login-verifier");
}

/**
 * Hash password for database storage (v2: an HKDF verifier, independent of
 * the data key).
 * @returns {string} "v2$" + base64 verifier
 */
function hashPassword(password, salt) {
  return HASH_V2_PREFIX + verifierFromMaster(deriveKey(password, salt), salt).toString("base64");
}

async function hashPasswordAsync(password, salt) {
  const master = await deriveKeyAsync(password, salt);
  return HASH_V2_PREFIX + verifierFromMaster(master, salt).toString("base64");
}

/** True when the stored hash predates v2 (it is the legacy data key). */
function needsRehash(storedHash) {
  return !String(storedHash || "").startsWith(HASH_V2_PREFIX);
}

function compareWithMaster(master, storedHash, salt) {
  const stored = String(storedHash || "");
  const expected = needsRehash(stored)
    ? master // legacy: the stored hash was the master itself
    : verifierFromMaster(master, salt);
  const given = Buffer.from(
    needsRehash(stored) ? stored : stored.slice(HASH_V2_PREFIX.length),
    "base64",
  );
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/**
 * Verify password against stored hash (v2 verifier or legacy hash).
 * @returns {boolean} True if password matches
 */
function verifyPassword(password, storedHash, salt) {
  return compareWithMaster(deriveKey(password, salt), storedHash, salt);
}

async function verifyPasswordAsync(password, storedHash, salt) {
  return compareWithMaster(await deriveKeyAsync(password, salt), storedHash, salt);
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

    // v2 data key (HKDF of the PBKDF2 master) — never the stored hash.
    const key = dataKeyFromMaster(deriveKey(password, salt), salt);

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
      v: 2,
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

    // v2 blobs use the HKDF data key; blobs written before v2.3.0 carry no
    // `v` and were encrypted under the PBKDF2 master directly.
    const master = deriveKey(password, salt);
    const key = encryptedData.v === 2 ? dataKeyFromMaster(master, salt) : master;

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
 * SECRET_KEY also signs JWTs. It lives only in the environment (.env), never in
 * the database, so a stolen DB file cannot be decrypted with it.
 *
 * The key is accepted in whatever encoding it was generated in, because the
 * project has historically produced it two ways: generate_secret.py emits
 * base64, and the Start9 configurator emits hex. Anything else is hashed down
 * to 32 bytes so encryption keeps working regardless of how the operator made
 * the key. Resolution is deterministic — a given SECRET_KEY always yields the
 * same 32-byte key, so envelopes stay decryptable across restarts.
 * @returns {Buffer} 32-byte AES key
 */
function getServerKey() {
  const secret = process.env.SECRET_KEY;
  if (!secret) {
    throw new Error("SECRET_KEY is not set; cannot derive server key");
  }
  const trimmed = secret.trim();

  // Base64 of exactly 32 bytes (generate_secret.py, auto-generated key).
  const asBase64 = Buffer.from(trimmed, "base64");
  if (asBase64.length === KEY_LENGTH) {
    return asBase64;
  }

  // Hex of exactly 32 bytes (Start9 configurator, common manual method). A
  // 64-char hex string base64-decodes to 48 bytes, so it never matches above.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Any other non-empty value: derive a stable 32-byte key by hashing it.
  return crypto.createHash("sha256").update(secret).digest();
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
  deriveKeyAsync,
  hashPasswordAsync,
  verifyPasswordAsync,
  needsRehash,
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
