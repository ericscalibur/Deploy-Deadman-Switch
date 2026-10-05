const { test } = require("node:test");
const assert = require("node:assert");
const { createLoginGuard, FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS, MAX_CONCURRENT } = require("../utils/loginGuard");

test("first failures are free, then delays grow and cap", () => {
  let t = 0;
  const g = createLoginGuard({ now: () => t });
  for (let i = 1; i < FREE_FAILURES; i++) {
    g.recordFailure("Op@Example.com");
    assert.equal(g.retryAfter("op@example.com"), 0);
  }
  g.recordFailure("op@example.com");
  assert.equal(g.retryAfter("op@example.com"), BASE_DELAY_MS);
  g.recordFailure("op@example.com");
  assert.equal(g.retryAfter("op@example.com"), 2 * BASE_DELAY_MS);
  for (let i = 0; i < 20; i++) g.recordFailure("op@example.com");
  assert.equal(g.retryAfter("op@example.com"), MAX_DELAY_MS);
  t += MAX_DELAY_MS;
  assert.equal(g.retryAfter("op@example.com"), 0);
});

test("success resets the account; accounts are independent", () => {
  const g = createLoginGuard({ now: () => 0 });
  for (let i = 0; i < 10; i++) g.recordFailure("a@x.io");
  assert.ok(g.retryAfter("a@x.io") > 0);
  assert.equal(g.retryAfter("b@x.io"), 0);
  g.recordSuccess("a@x.io");
  assert.equal(g.retryAfter("a@x.io"), 0);
});

test("concurrency cap: acquire fails when full, release frees a slot once", () => {
  const g = createLoginGuard();
  const rel = [];
  for (let i = 0; i < MAX_CONCURRENT; i++) rel.push(g.acquire());
  assert.equal(g.acquire(), null);
  rel[0]();
  rel[0]();
  const again = g.acquire();
  assert.ok(again);
  assert.equal(g.acquire(), null);
});
