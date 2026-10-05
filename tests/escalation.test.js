const { test } = require("node:test");
const assert = require("node:assert");
const {
  MIN_WARNING_MISSED_CHECKINS,
  effectiveWarningThreshold,
  warningPossible,
  warningAction,
  pingAction,
  inboundHoldDecision,
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

test("threshold never drops below two — the first check-in email is not a miss", () => {
  assert.strictEqual(MIN_WARNING_MISSED_CHECKINS, 2);
  // Dale's config: daily check-ins, 2-day deadline -> one tick before fire.
  // Warning at tick 1 would go out with the very first check-in email.
  assert.strictEqual(
    effectiveWarningThreshold({
      threshold: DEFAULT_WARNING_MISSED_CHECKINS,
      checkinIntervalMs: DAY,
      inactivityMs: 2 * DAY,
    }),
    2,
  );
  assert.strictEqual(
    warningPossible({ threshold: DEFAULT_WARNING_MISSED_CHECKINS, checkinIntervalMs: DAY, inactivityMs: 2 * DAY }),
    false,
  );
  // 3-minute check-ins, 8-minute deadline: ticks at 3 and 6 -> warn at 6
  assert.strictEqual(
    effectiveWarningThreshold({ threshold: DEFAULT_WARNING_MISSED_CHECKINS, checkinIntervalMs: 3 * MIN, inactivityMs: 8 * MIN }),
    2,
  );
  assert.strictEqual(
    warningPossible({ threshold: DEFAULT_WARNING_MISSED_CHECKINS, checkinIntervalMs: 3 * MIN, inactivityMs: 8 * MIN }),
    true,
  );
  // Exactly twice the interval: the only tick is the first email -> no warning
  assert.strictEqual(
    warningPossible({ threshold: DEFAULT_WARNING_MISSED_CHECKINS, checkinIntervalMs: MIN, inactivityMs: 2 * MIN }),
    false,
  );
  // Just over twice: two ticks fit -> warning on the second
  assert.strictEqual(
    warningPossible({ threshold: DEFAULT_WARNING_MISSED_CHECKINS, checkinIntervalMs: MIN, inactivityMs: 2 * MIN + 1 }),
    true,
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

// ---- inboundHoldDecision (reply-by-email fail-safe) ----

const CAP = 7 * DAY;
const T0 = Date.UTC(2026, 9, 1);
const holdBase = { enabled: true, configured: true, capMs: CAP };

test("no outage → not held", () => {
  assert.strictEqual(inboundHoldDecision({ ...holdBase, downSince: null, lastCheckinSentAt: T0, now: T0 }).held, false);
});

test("outage that began before the last check-in email → held", () => {
  const r = inboundHoldDecision({ ...holdBase, downSince: T0, lastCheckinSentAt: T0 + 1000, now: T0 + DAY });
  assert.strictEqual(r.held, true);
});

test("outage that began after the last check-in email → not held", () => {
  const r = inboundHoldDecision({ ...holdBase, downSince: T0 + 2000, lastCheckinSentAt: T0, now: T0 + DAY });
  assert.strictEqual(r.held, false);
  assert.strictEqual(r.reason, "outage-after-last-email");
});

test("hold expires at exactly the cap and says so", () => {
  const args = { ...holdBase, downSince: T0, lastCheckinSentAt: T0 + 1000 };
  assert.strictEqual(inboundHoldDecision({ ...args, now: T0 + CAP - 1 }).held, true);
  const r = inboundHoldDecision({ ...args, now: T0 + CAP });
  assert.strictEqual(r.held, false);
  assert.strictEqual(r.capExpired, true);
});

test("IMAP not configured or disabled → never held (upgrade never freezes a switch)", () => {
  const args = { downSince: T0, lastCheckinSentAt: T0 + 1000, now: T0 + DAY, capMs: CAP };
  assert.strictEqual(inboundHoldDecision({ ...args, enabled: true, configured: false }).held, false);
  assert.strictEqual(inboundHoldDecision({ ...args, enabled: false, configured: true }).held, false);
});

test("accepts ISO strings and Dates for the timestamps", () => {
  const r = inboundHoldDecision({
    ...holdBase,
    downSince: new Date(T0).toISOString(),
    lastCheckinSentAt: new Date(T0 + 1000),
    now: T0 + DAY,
  });
  assert.strictEqual(r.held, true);
});
