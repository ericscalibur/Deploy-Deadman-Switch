const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  generateSalt,
  hashPassword,
  verifyPassword,
  encryptData,
  decryptData,
  encryptEmails,
  decryptEmails,
  encryptSettings,
  decryptSettings,
  generateSessionToken,
  generateCheckinToken,
  validateEncryptedData,
  encryptEmailsWithServerKey,
  decryptEmailsWithServerKey,
  ALGORITHM,
} = require("../database/crypto");

describe("generateSalt", () => {
  test("returns a non-empty base64 string", () => {
    const salt = generateSalt();
    assert.equal(typeof salt, "string");
    assert.ok(salt.length > 0);
    assert.ok(Buffer.from(salt, "base64").length > 0);
  });

  test("returns unique salts each call", () => {
    assert.notEqual(generateSalt(), generateSalt());
  });
});

describe("hashPassword / verifyPassword", () => {
  test("same password + salt produces consistent hash", () => {
    const salt = generateSalt();
    const h1 = hashPassword("correcthorsebatterystaple", salt);
    const h2 = hashPassword("correcthorsebatterystaple", salt);
    assert.equal(h1, h2);
  });

  test("different passwords produce different hashes", () => {
    const salt = generateSalt();
    assert.notEqual(
      hashPassword("password1", salt),
      hashPassword("password2", salt),
    );
  });

  test("verifyPassword returns true for correct password", () => {
    const salt = generateSalt();
    const password = "my-secure-password";
    const hash = hashPassword(password, salt);
    assert.equal(verifyPassword(password, hash, salt), true);
  });

  test("verifyPassword returns false for wrong password", () => {
    const salt = generateSalt();
    const hash = hashPassword("correct", salt);
    assert.equal(verifyPassword("wrong", hash, salt), false);
  });

  test("verifyPassword returns false for wrong salt", () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const hash = hashPassword("password", salt1);
    assert.equal(verifyPassword("password", hash, salt2), false);
  });
});

describe("encryptData / decryptData", () => {
  const password = "test-password";
  const salt = generateSalt();

  test("decrypts back to original string", () => {
    const plaintext = "hello world";
    const encrypted = encryptData(plaintext, password, salt);
    assert.equal(decryptData(encrypted, password, salt), plaintext);
  });

  test("decrypts back to original object (JSON)", () => {
    const obj = { foo: "bar", num: 42, arr: [1, 2, 3] };
    const encrypted = encryptData(obj, password, salt);
    const decrypted = JSON.parse(decryptData(encrypted, password, salt));
    assert.deepEqual(decrypted, obj);
  });

  test("produces different ciphertext each call (random IV)", () => {
    const e1 = encryptData("same plaintext", password, salt);
    const e2 = encryptData("same plaintext", password, salt);
    assert.notEqual(e1.encrypted, e2.encrypted);
    assert.notEqual(e1.iv, e2.iv);
  });

  test("encrypted output has expected fields", () => {
    const result = encryptData("data", password, salt);
    assert.ok(result.encrypted);
    assert.ok(result.iv);
    assert.ok(result.authTag);
    assert.equal(result.algorithm, ALGORITHM);
  });

  test("throws on decryption with wrong password", () => {
    const encrypted = encryptData("secret", password, salt);
    assert.throws(() => decryptData(encrypted, "wrong-password", salt));
  });

  test("throws on decryption with wrong salt", () => {
    const encrypted = encryptData("secret", password, salt);
    assert.throws(() => decryptData(encrypted, password, generateSalt()));
  });

  test("throws on tampered auth tag", () => {
    const encrypted = encryptData("secret", password, salt);
    const tagBytes = Buffer.from(encrypted.authTag, "base64");
    tagBytes[0] ^= 0xff;
    const tampered = { ...encrypted, authTag: tagBytes.toString("base64") };
    assert.throws(() => decryptData(tampered, password, salt));
  });
});

describe("encryptEmails / decryptEmails", () => {
  const password = "pass";
  const salt = generateSalt();
  const emails = [
    { to: "alice@example.com", subject: "Alert", body: "You've been idle." },
    { to: "bob@example.com", subject: "Alert", body: "Check in required." },
  ];

  test("round-trips an email array", () => {
    const encrypted = encryptEmails(emails, password, salt);
    const decrypted = decryptEmails(encrypted, password, salt);
    assert.deepEqual(decrypted, emails);
  });

  test("throws for non-array input", () => {
    assert.throws(() => encryptEmails("not-an-array", password, salt));
  });

  test("handles empty array", () => {
    const encrypted = encryptEmails([], password, salt);
    const decrypted = decryptEmails(encrypted, password, salt);
    assert.deepEqual(decrypted, []);
  });
});

describe("encryptSettings / decryptSettings", () => {
  const password = "pass";
  const salt = generateSalt();
  const settings = { checkinInterval: "2-hours", inactivityPeriod: "7-days" };

  test("round-trips a settings object", () => {
    const encrypted = encryptSettings(settings, password, salt);
    const decrypted = decryptSettings(encrypted, password, salt);
    assert.deepEqual(decrypted, settings);
  });

  test("throws for non-object input", () => {
    assert.throws(() => encryptSettings("string", password, salt));
  });
});

describe("token generation", () => {
  test("generateSessionToken returns unique hex strings", () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    assert.equal(typeof t1, "string");
    assert.notEqual(t1, t2);
    assert.ok(/^[0-9a-f]+$/.test(t1));
  });

  test("generateCheckinToken returns unique hex strings", () => {
    const t1 = generateCheckinToken();
    const t2 = generateCheckinToken();
    assert.equal(typeof t1, "string");
    assert.notEqual(t1, t2);
    assert.ok(/^[0-9a-f]+$/.test(t1));
  });
});

describe("validateEncryptedData", () => {
  test("returns true for valid structure", () => {
    const salt = generateSalt();
    const encrypted = encryptData("test", "password", salt);
    assert.equal(validateEncryptedData(encrypted), true);
  });

  test("returns falsy for missing fields", () => {
    assert.ok(!validateEncryptedData(null));
    assert.ok(!validateEncryptedData({}));
    assert.ok(!validateEncryptedData({ encrypted: "x", iv: "y" }));
  });

  test("returns false for wrong algorithm field", () => {
    const salt = generateSalt();
    const enc = encryptData("test", "pass", salt);
    assert.equal(validateEncryptedData({ ...enc, algorithm: "des" }), false);
  });
});

describe("server-key envelope (SECRET_KEY encoding)", () => {
  const original = process.env.SECRET_KEY;
  const recipients = [{ address: "a@b.com", content: "hi" }];

  function roundtrip(key) {
    process.env.SECRET_KEY = key;
    const blob = encryptEmailsWithServerKey(recipients);
    return decryptEmailsWithServerKey(blob);
  }

  test("accepts a base64 32-byte key (generate_secret.py / auto-generated)", () => {
    const out = roundtrip(crypto.randomBytes(32).toString("base64"));
    assert.deepEqual(out, recipients);
  });

  test("accepts a hex 32-byte key (Start9 configurator / manual setup)", () => {
    // A 64-char hex string base64-decodes to 48 bytes; this used to throw
    // "SECRET_KEY must decode to 32 bytes (got 48)" and skip the envelope.
    const out = roundtrip(crypto.randomBytes(32).toString("hex"));
    assert.deepEqual(out, recipients);
  });

  test("derives a stable key from any other passphrase", () => {
    const out = roundtrip("correct horse battery staple");
    assert.deepEqual(out, recipients);
  });

  test("throws when SECRET_KEY is unset", () => {
    delete process.env.SECRET_KEY;
    assert.throws(() => encryptEmailsWithServerKey(recipients), /SECRET_KEY/);
  });

  process.env.SECRET_KEY = original;
});

// ---- v2.3.0 key separation ----
describe("login verifier is independent of the data key", () => {
  const nodeCrypto = require("crypto");
  const c = require("../database/crypto");

  test("the stored hash cannot decrypt the user's data", () => {
    const salt = c.generateSalt();
    const stored = c.hashPassword("hunter2-long", salt);
    assert.ok(stored.startsWith("v2$"));
    const blob = c.encryptData({ secret: "beneficiary@example.com" }, "hunter2-long", salt);
    assert.equal(blob.v, 2);
    const keyFromHash = Buffer.from(stored.slice(3), "base64");
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", keyFromHash, Buffer.from(blob.iv, "base64"));
    decipher.setAAD(Buffer.from(salt, "base64"));
    decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
    assert.throws(() => {
      decipher.update(blob.encrypted, "base64", "utf8");
      decipher.final("utf8");
    });
    // …while the password still does.
    assert.match(c.decryptData(blob, "hunter2-long", salt), /beneficiary/);
  });

  test("legacy hashes (pre-2.3.0, the raw PBKDF2 key) still verify and are flagged", async () => {
    const salt = c.generateSalt();
    const legacy = c.deriveKey("old-pass", salt).toString("base64");
    assert.equal(c.needsRehash(legacy), true);
    assert.equal(c.verifyPassword("old-pass", legacy, salt), true);
    assert.equal(c.verifyPassword("wrong", legacy, salt), false);
    assert.equal(await c.verifyPasswordAsync("old-pass", legacy, salt), true);
    assert.equal(c.needsRehash(c.hashPassword("old-pass", salt)), false);
  });

  test("legacy blobs (no v field, keyed by the raw PBKDF2 key) still decrypt", () => {
    const salt = c.generateSalt();
    const key = c.deriveKey("old-pass", salt);
    const iv = nodeCrypto.randomBytes(16);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(salt, "base64"));
    let enc = cipher.update(JSON.stringify(["a@b.c"]), "utf8", "base64");
    enc += cipher.final("base64");
    const legacyBlob = { encrypted: enc, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), algorithm: "aes-256-gcm" };
    assert.deepEqual(c.decryptEmails(legacyBlob, "old-pass", salt), ["a@b.c"]);
  });

  test("a v2 hash of a different length never throws in comparison", () => {
    const salt = c.generateSalt();
    assert.equal(c.verifyPassword("x", "v2$AAAA", salt), false);
    assert.equal(c.verifyPassword("x", "AAAA", salt), false);
  });
});
