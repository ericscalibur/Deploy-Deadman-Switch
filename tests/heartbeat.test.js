const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const { isEnabled, mailHealthy, ping, rescheduleNtfyAlerts, tick } = require("../utils/heartbeat");

const healthyImap = { enabled: true, configured: true, downSince: null };

describe("heartbeat enable gate", () => {
  beforeEach(() => {
    delete process.env.HEARTBEAT_URL;
    delete process.env.WATCHDOG_NTFY_TOPIC;
  });

  test("disabled when both settings are unset or blank", () => {
    assert.strictEqual(isEnabled(), false);
    process.env.HEARTBEAT_URL = "   ";
    process.env.WATCHDOG_NTFY_TOPIC = "   ";
    assert.strictEqual(isEnabled(), false);
  });

  test("either setting enables it", () => {
    process.env.WATCHDOG_NTFY_TOPIC = "deploy-trusted";
    assert.strictEqual(isEnabled(), true);
    delete process.env.WATCHDOG_NTFY_TOPIC;
    process.env.HEARTBEAT_URL = "https://hc.example/ping/abc";
    assert.strictEqual(isEnabled(), true);
  });

  test("ping resolves false and does not throw when disabled", async () => {
    assert.strictEqual(await ping(), false);
  });
});

describe("mailHealthy", () => {
  test("healthy when SMTP and IMAP both work", () => {
    assert.strictEqual(mailHealthy(true, healthyImap), true);
  });

  test("unhealthy when SMTP is down", () => {
    assert.strictEqual(mailHealthy(false, healthyImap), false);
  });

  test("unhealthy while the mailbox can't be read", () => {
    assert.strictEqual(mailHealthy(true, { ...healthyImap, downSince: "2026-11-01T00:00:00Z" }), false);
  });

  test("an install without IMAP is judged on sending alone", () => {
    assert.strictEqual(mailHealthy(true, { enabled: true, configured: false, downSince: null }), true);
    assert.strictEqual(mailHealthy(true, { enabled: false }), true);
  });
});

describe("ntfy alerts", () => {
  let fetchMock;

  beforeEach(() => {
    delete process.env.HEARTBEAT_URL;
    delete process.env.NTFY_SERVER;
    process.env.WATCHDOG_NTFY_TOPIC = "deploy-trusted";
    fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }));
  });

  afterEach(() => {
    fetchMock.mock.restore();
    delete process.env.WATCHDOG_NTFY_TOPIC;
    delete process.env.NTFY_SERVER;
  });

  test("queues two delayed alerts, under ntfy's 3-day limit", async () => {
    assert.strictEqual(await rescheduleNtfyAlerts(), true);
    const calls = fetchMock.mock.calls.map((c) => c.arguments);
    assert.deepStrictEqual(calls.map(([, o]) => o.headers.In), ["24h", "60h"]);
    assert.deepStrictEqual(calls.map(([u]) => u), [
      "https://ntfy.sh/deploy-trusted/deploy-watchdog-first",
      "https://ntfy.sh/deploy-trusted/deploy-watchdog-second",
    ]);
  });

  test("uses the same IDs every time, so a new pair replaces the last", async () => {
    await rescheduleNtfyAlerts();
    await rescheduleNtfyAlerts();
    const urls = fetchMock.mock.calls.map((c) => c.arguments[0]);
    assert.strictEqual(new Set(urls).size, 2);
  });

  test("honours NTFY_SERVER", async () => {
    process.env.NTFY_SERVER = "https://ntfy.example/";
    await rescheduleNtfyAlerts();
    assert.ok(fetchMock.mock.calls[0].arguments[0].startsWith("https://ntfy.example/deploy-trusted/"));
  });

  test("broken mail queues nothing, so waiting alerts get delivered", async () => {
    assert.strictEqual(await tick(() => false, () => healthyImap), false);
    assert.strictEqual(fetchMock.mock.callCount(), 0);
  });

  test("a failed request resolves false and does not throw", async () => {
    fetchMock.mock.mockImplementation(async () => { throw new Error("network down"); });
    assert.strictEqual(await rescheduleNtfyAlerts(), false);
  });
});

describe("tick", () => {
  let fetchMock;

  beforeEach(() => {
    process.env.HEARTBEAT_URL = "https://hc.example/ping/abc";
    fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }));
  });

  afterEach(() => {
    fetchMock.mock.restore();
    delete process.env.HEARTBEAT_URL;
  });

  test("pings the URL with nothing attached when mail is healthy", async () => {
    assert.strictEqual(await tick(() => true, () => healthyImap), true);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.strictEqual(url, "https://hc.example/ping/abc");
    assert.strictEqual(options.body, undefined);
  });

  test("skips the ping when mail is broken, so the watchdog trips", async () => {
    assert.strictEqual(await tick(() => false, () => healthyImap), false);
    assert.strictEqual(fetchMock.mock.callCount(), 0);
  });

  test("a failed ping resolves false and does not throw", async () => {
    fetchMock.mock.mockImplementation(async () => { throw new Error("network down"); });
    assert.strictEqual(await tick(() => true, () => healthyImap), false);
  });
});
