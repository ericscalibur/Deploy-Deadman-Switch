const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
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
