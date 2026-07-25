const { test } = require("node:test");
const assert = require("node:assert");
const {
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
