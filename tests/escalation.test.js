const { test } = require("node:test");
const assert = require("node:assert");
const {
  effectiveWarningThreshold,
  warningAction,
  pingAction,
  DEFAULT_WARNING_MISSED_CHECKINS,
  DEFAULT_PING_INTERVAL_DAYS,
  DEFAULT_PING_ACK_GRACE_DAYS,
} = require("../utils/escalation");

const DAY = 24 * 60 * 60 * 1000;
const YEAR_MS = DEFAULT_PING_INTERVAL_DAYS * DAY;
const GRACE_MS = DEFAULT_PING_ACK_GRACE_DAYS * DAY;

// ---- warningAction (pre-fire warning, Issue #1) ----

test("no warning below the missed-check-in threshold", () => {
  for (let missed = 0; missed < DEFAULT_WARNING_MISSED_CHECKINS; missed++) {
    assert.strictEqual(
      warningAction({
        missedCheckins: missed,
        threshold: DEFAULT_WARNING_MISSED_CHECKINS,
        warningAckAt: null,
      }),
      "none",
    );
  }
});

test("warning fires exactly at the threshold", () => {
  assert.strictEqual(
    warningAction({
      missedCheckins: DEFAULT_WARNING_MISSED_CHECKINS,
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      warningAckAt: null,
    }),
    "send",
  );
});

test("unacknowledged warning keeps escalating on later ticks", () => {
  assert.strictEqual(
    warningAction({
      missedCheckins: DEFAULT_WARNING_MISSED_CHECKINS + 3,
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      warningAckAt: null,
    }),
    "send",
  );
});

test("acknowledged warning stops resends", () => {
  assert.strictEqual(
    warningAction({
      missedCheckins: DEFAULT_WARNING_MISSED_CHECKINS + 3,
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      warningAckAt: new Date(),
    }),
    "none",
  );
});

test("custom threshold is respected", () => {
  assert.strictEqual(
    warningAction({ missedCheckins: 2, threshold: 2, warningAckAt: null }),
    "send",
  );
  assert.strictEqual(
    warningAction({ missedCheckins: 1, threshold: 2, warningAckAt: null }),
    "none",
  );
});

// ---- effectiveWarningThreshold (threshold vs. available ticks) ----

const MIN = 60 * 1000;
const WEEK = 7 * DAY;

test("reference config (2-week check-ins, 3-month inactivity) keeps the default", () => {
  assert.strictEqual(
    effectiveWarningThreshold({
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      checkinIntervalMs: 2 * WEEK,
      inactivityMs: 90 * DAY,
    }),
    DEFAULT_WARNING_MISSED_CHECKINS,
  );
});

test("short inactivity periods clamp the threshold so a warning still fires", () => {
  // 1-week check-ins, 30-day deadline: ticks at day 7/14/21/28 -> warn at 21
  assert.strictEqual(
    effectiveWarningThreshold({
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      checkinIntervalMs: WEEK,
      inactivityMs: 30 * DAY,
    }),
    3,
  );
  // 1-minute check-ins, 5-minute deadline: ticks at 1..4 -> warn at 3
  assert.strictEqual(
    effectiveWarningThreshold({
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      checkinIntervalMs: MIN,
      inactivityMs: 5 * MIN,
    }),
    3,
  );
});

test("threshold never drops below one tick", () => {
  assert.strictEqual(
    effectiveWarningThreshold({
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      checkinIntervalMs: MIN,
      inactivityMs: 2 * MIN,
    }),
    1,
  );
  assert.strictEqual(
    effectiveWarningThreshold({
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      checkinIntervalMs: MIN,
      inactivityMs: 90 * 1000,
    }),
    1,
  );
});

test("missing interval data falls back to the configured threshold", () => {
  assert.strictEqual(
    effectiveWarningThreshold({ threshold: 5 }),
    5,
  );
});

// ---- pingAction (annual liveness ping, Issue #2) ----

const base = {
  intervalMs: YEAR_MS,
  graceMs: GRACE_MS,
  operatorAlertedAt: null,
};

test("never-pinged address gets a ping immediately", () => {
  assert.strictEqual(
    pingAction({ ...base, now: 1000, pingSentAt: null, ackAt: null }),
    "send",
  );
});

test("recently pinged, unacked, inside grace: wait", () => {
  const sent = 1000;
  assert.strictEqual(
    pingAction({
      ...base,
      now: sent + GRACE_MS - 1,
      pingSentAt: sent,
      ackAt: null,
    }),
    "none",
  );
});

test("unacked past grace window: alert the operator once", () => {
  const sent = 1000;
  const late = sent + GRACE_MS + DAY;
  assert.strictEqual(
    pingAction({ ...base, now: late, pingSentAt: sent, ackAt: null }),
    "alert-operator",
  );
  // Operator already alerted -> no repeat alert, and no new pings into a
  // possibly-dead inbox.
  assert.strictEqual(
    pingAction({
      ...base,
      now: late + 10 * DAY,
      pingSentAt: sent,
      ackAt: null,
      operatorAlertedAt: late,
    }),
    "none",
  );
});

test("acked cycle: next ping when the year is up, not before", () => {
  const sent = 1000;
  const acked = sent + DAY;
  assert.strictEqual(
    pingAction({
      ...base,
      now: sent + YEAR_MS - DAY,
      pingSentAt: sent,
      ackAt: acked,
    }),
    "none",
  );
  assert.strictEqual(
    pingAction({
      ...base,
      now: sent + YEAR_MS,
      pingSentAt: sent,
      ackAt: acked,
    }),
    "send",
  );
});
