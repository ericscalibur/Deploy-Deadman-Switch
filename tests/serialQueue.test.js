const test = require("node:test");
const assert = require("node:assert");
const { createSerialQueue } = require("../utils/serialQueue");

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("createSerialQueue", async (t) => {
  await t.test("does not overlap work for the same key", async () => {
    const q = createSerialQueue();
    let active = 0;
    let maxActive = 0;

    const job = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(20);
      active -= 1;
    };

    await Promise.all([q.run("u1", job), q.run("u1", job), q.run("u1", job)]);
    assert.strictEqual(maxActive, 1, "same-key work must never run concurrently");
  });

  await t.test("regression: second pass observes the first pass's write", async () => {
    // The duplicate-beneficiary-email bug in shape: the decision to act is
    // "yes" until a record of acting exists, and that record is written only
    // after the slow part finishes. Unserialized, both passes act.
    const q = createSerialQueue();
    const contacted = new Set();
    let sends = 0;

    const contactPass = async (address) => {
      if (contacted.has(address)) return;
      await tick(15); // the send
      sends += 1;
      contacted.add(address); // the record, written only after the send
    };

    await Promise.all([
      q.run("op", () => contactPass("ben@example.com")),
      q.run("op", () => contactPass("ben@example.com")),
      q.run("op", () => contactPass("ben@example.com")),
    ]);

    assert.strictEqual(sends, 1, "a recipient must be contacted exactly once");
  });

  await t.test("runs different keys concurrently", async () => {
    const q = createSerialQueue();
    let active = 0;
    let maxActive = 0;
    const job = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(20);
      active -= 1;
    };

    await Promise.all([q.run("a", job), q.run("b", job), q.run("c", job)]);
    assert.strictEqual(maxActive, 3, "distinct keys should not block each other");
  });

  await t.test("a rejected pass does not cancel the next one", async () => {
    const q = createSerialQueue();
    let ran = false;

    const failing = q.run("u1", async () => {
      throw new Error("send failed");
    });
    await assert.rejects(failing, /send failed/, "caller still sees the error");

    await q.run("u1", async () => {
      ran = true;
    });
    assert.ok(ran, "later work must still run after a failure");
  });

  await t.test("does not retain keys after work settles", async () => {
    const q = createSerialQueue();
    await q.run("u1", async () => {});
    await tick(5);
    assert.strictEqual(q.size(), 0, "queue must not leak one entry per key");
  });
});
