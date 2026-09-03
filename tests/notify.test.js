const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert");

const {
  isEnabled,
  notify,
  shouldSendThrottled,
} = require("../utils/notify");

describe("notify enable gate", () => {
  beforeEach(() => {
    delete process.env.NTFY_TOPIC;
  });

  test("disabled when NTFY_TOPIC is unset", () => {
    assert.strictEqual(isEnabled(), false);
  });

  test("disabled when NTFY_TOPIC is blank", () => {
    process.env.NTFY_TOPIC = "   ";
    assert.strictEqual(isEnabled(), false);
  });

  test("enabled when NTFY_TOPIC is set", () => {
    process.env.NTFY_TOPIC = "deploy-test-topic";
    assert.strictEqual(isEnabled(), true);
  });

  test("notify resolves false (and does not throw) when disabled", async () => {
    const result = await notify("should go nowhere");
    assert.strictEqual(result, false);
  });
});

describe("shouldSendThrottled", () => {
  test("first send for a key is allowed", () => {
    const map = new Map();
    assert.strictEqual(shouldSendThrottled(map, "k", 1000, 5000), true);
  });

  test("repeat inside the interval is suppressed", () => {
    const map = new Map();
    shouldSendThrottled(map, "k", 1000, 5000);
    assert.strictEqual(shouldSendThrottled(map, "k", 1000, 5500), false);
  });

  test("repeat after the interval is allowed", () => {
    const map = new Map();
    shouldSendThrottled(map, "k", 1000, 5000);
    assert.strictEqual(shouldSendThrottled(map, "k", 1000, 6000), true);
  });

  test("suppressed attempts do not extend the window", () => {
    const map = new Map();
    shouldSendThrottled(map, "k", 1000, 5000);
    shouldSendThrottled(map, "k", 1000, 5900); // suppressed
    assert.strictEqual(shouldSendThrottled(map, "k", 1000, 6000), true);
  });

  test("keys are independent", () => {
    const map = new Map();
    shouldSendThrottled(map, "a", 1000, 5000);
    assert.strictEqual(shouldSendThrottled(map, "b", 1000, 5000), true);
  });
});
