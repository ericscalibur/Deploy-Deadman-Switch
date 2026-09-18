// Persistence for reply codes, against a throwaway SQLite file.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-codes-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.SECRET_KEY = "dGVzdC1zZWNyZXQta2V5LXRlc3Qtc2VjcmV0LWtleS0=";

const { initializeDatabase } = require("../database/init");
const UserService = require("../database/userService");
const { hashCode, isValidCode } = require("../utils/codes");

const svc = new UserService();
let userId;

before(async () => {
  await initializeDatabase();
  await svc.connect();
  const u = await svc.createUser("op@example.com", "pw-1234", {});
  userId = u.userId;
});

after(async () => {
  await svc.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("issueCode / findLiveCode", () => {
  test("returns a valid plaintext code once and stores only its hash", async () => {
    const issued = await svc.issueCode({ kind: "checkin", userId, ref: "sess-1" });
    assert.ok(isValidCode(issued.code));
    assert.strictEqual(issued.hash, hashCode(issued.code));

    const row = await svc.findLiveCode(issued.hash);
    assert.ok(row);
    assert.strictEqual(row.kind, "checkin");
    assert.strictEqual(row.user_id, userId);
    assert.strictEqual(row.ref, "sess-1");
    assert.strictEqual(row.user_email, "op@example.com");
    assert.strictEqual(row.failed_attempts, 0);
    // Plaintext must not be anywhere in the row.
    for (const v of Object.values(row)) {
      assert.notStrictEqual(String(v), issued.code);
    }
  });

  test("issuing a new code for the same slot retires the previous one", async () => {
    const a = await svc.issueCode({ kind: "checkin", userId, ref: "sess-2" });
    const b = await svc.issueCode({ kind: "checkin", userId, ref: "sess-2" });
    assert.strictEqual(await svc.findLiveCode(a.hash), null);
    assert.ok(await svc.findLiveCode(b.hash));
    const stale = await svc.findCodeByHash(a.hash);
    assert.ok(stale.retired_at, "old code carries retired_at");
    assert.strictEqual(stale.used_at, null);
  });

  test("slots are independent across ref and recipient", async () => {
    const p1 = await svc.issueCode({ kind: "ping-ack", userId, ref: "7", recipientHash: "h1" });
    const p2 = await svc.issueCode({ kind: "ping-ack", userId, ref: "8", recipientHash: "h2" });
    assert.ok(await svc.findLiveCode(p1.hash));
    assert.ok(await svc.findLiveCode(p2.hash));
    const w1 = await svc.issueCode({ kind: "warning-ack", userId, ref: "sess-3", recipientHash: "h1" });
    const w2 = await svc.issueCode({ kind: "warning-ack", userId, ref: "sess-3", recipientHash: "h2" });
    assert.ok(await svc.findLiveCode(w1.hash));
    assert.ok(await svc.findLiveCode(w2.hash));
    // Same session + same recipient → previous retired.
    const w1b = await svc.issueCode({ kind: "warning-ack", userId, ref: "sess-3", recipientHash: "h1" });
    assert.strictEqual(await svc.findLiveCode(w1.hash), null);
    assert.ok(await svc.findLiveCode(w1b.hash));
    assert.ok(await svc.findLiveCode(w2.hash), "other recipient untouched");
  });

  test("rejects an unknown kind", async () => {
    await assert.rejects(() => svc.issueCode({ kind: "bogus", userId }));
  });
});

describe("markCodeUsed / retireCode / liveCodeFor", () => {
  test("a used code is no longer live but stays recognisable", async () => {
    const c = await svc.issueCode({ kind: "arming", userId, ref: "sess-4" });
    assert.ok(await svc.liveCodeFor(userId, "arming", "sess-4"));
    assert.strictEqual(await svc.markCodeUsed(c.id), true);
    assert.strictEqual(await svc.markCodeUsed(c.id), false, "idempotent");
    assert.strictEqual(await svc.findLiveCode(c.hash), null);
    assert.strictEqual(await svc.liveCodeFor(userId, "arming", "sess-4"), null);
    const row = await svc.findCodeByHash(c.hash);
    assert.ok(row.used_at);
  });

  test("retireCode retires one code", async () => {
    const c = await svc.issueCode({ kind: "checkin", userId, ref: "sess-5" });
    assert.strictEqual(await svc.retireCode(c.id), true);
    assert.strictEqual(await svc.findLiveCode(c.hash), null);
  });

  test("retireCodes by kinds retires every live operator code", async () => {
    const a = await svc.issueCode({ kind: "arming", userId, ref: "sess-6" });
    const b = await svc.issueCode({ kind: "checkin", userId, ref: "sess-6" });
    const p = await svc.issueCode({ kind: "ping-ack", userId, ref: "9", recipientHash: "h9" });
    const n = await svc.retireCodes({ userId, kinds: ["arming", "checkin", "warning-ack"] });
    assert.ok(n >= 2);
    assert.strictEqual(await svc.findLiveCode(a.hash), null);
    assert.strictEqual(await svc.findLiveCode(b.hash), null);
    assert.ok(await svc.findLiveCode(p.hash), "ping-ack untouched");
  });
});

describe("bumpFailedAttempts", () => {
  test("counts wrong guesses on a live code", async () => {
    const c = await svc.issueCode({ kind: "checkin", userId, ref: "sess-7" });
    assert.strictEqual(await svc.bumpFailedAttempts(c.id), 1);
    assert.strictEqual(await svc.bumpFailedAttempts(c.id), 2);
    assert.strictEqual(await svc.bumpFailedAttempts(c.id), 3);
    assert.strictEqual(await svc.bumpFailedAttempts(c.id), 4);
    assert.strictEqual(await svc.bumpFailedAttempts(c.id), 5);
    assert.ok(await svc.findLiveCode(c.hash), "counting alone does not retire");
  });
});

describe("settings", () => {
  test("get/set/delete round trip", async () => {
    assert.strictEqual(await svc.getSetting("imap:INBOX:lastuid"), null);
    await svc.setSetting("imap:INBOX:lastuid", 42);
    assert.strictEqual(await svc.getSetting("imap:INBOX:lastuid"), "42");
    await svc.setSetting("imap:INBOX:lastuid", 43);
    assert.strictEqual(await svc.getSetting("imap:INBOX:lastuid"), "43");
    await svc.deleteSetting("imap:INBOX:lastuid");
    assert.strictEqual(await svc.getSetting("imap:INBOX:lastuid"), null);
  });
});

describe("beneficiary pings by id", () => {
  test("ensureBeneficiaryPingRow creates a never-sent row once", async () => {
    const r1 = await svc.ensureBeneficiaryPingRow(userId, "hash-a");
    const r2 = await svc.ensureBeneficiaryPingRow(userId, "hash-a");
    assert.strictEqual(r1.id, r2.id);
    assert.strictEqual(r1.ping_sent_at, null);
    await svc.saveBeneficiaryPingSent(userId, "hash-a");
    const r3 = await svc.getBeneficiaryPing(userId, "hash-a");
    assert.strictEqual(r3.id, r1.id);
    assert.ok(r3.ping_sent_at);
    assert.strictEqual(r3.ack_at, null);
  });

  test("ackBeneficiaryPingById stamps ack_at and returns the prior row", async () => {
    const row = await svc.getBeneficiaryPing(userId, "hash-a");
    const before = await svc.ackBeneficiaryPingById(row.id);
    assert.strictEqual(before.ack_at, null);
    assert.strictEqual(before.email, "op@example.com");
    const again = await svc.ackBeneficiaryPingById(row.id);
    assert.ok(again.ack_at, "second ack sees the first");
    assert.strictEqual(await svc.ackBeneficiaryPingById(999999), null);
  });

  test("getUnansweredBeneficiaryPings lists sent-but-unacked rows only", async () => {
    await svc.ensureBeneficiaryPingRow(userId, "hash-b");
    await svc.saveBeneficiaryPingSent(userId, "hash-b");
    const rows = await svc.getUnansweredBeneficiaryPings();
    const hashes = rows.map((r) => r.email_hash);
    assert.ok(hashes.includes("hash-b"));
    assert.ok(!hashes.includes("hash-a"), "acked row excluded");
  });
});

describe("deleteUser cascades", () => {
  test("removes reply codes and ping rows", async () => {
    const u = await svc.createUser("gone@example.com", "pw", {});
    const c = await svc.issueCode({ kind: "checkin", userId: u.userId, ref: "s" });
    await svc.ensureBeneficiaryPingRow(u.userId, "hash-z");
    await svc.deleteUser(u.userId);
    assert.strictEqual(await svc.findCodeByHash(c.hash), null);
    assert.strictEqual(await svc.getBeneficiaryPing(u.userId, "hash-z"), null);
  });
});
