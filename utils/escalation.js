// Pure decision logic for beneficiary escalation (Issues #1 and #2).
// Kept free of I/O so the timing rules — the part that only gets exercised
// months apart in production — can be unit tested.

// How many consecutive check-in intervals may elapse with no operator
// response before the beneficiary pre-fire warning goes out. With the
// reference configuration (2-week check-ins, 3-month inactivity) the default
// of 5 puts the warning at ~10 weeks, roughly 30 days before the trigger.
const DEFAULT_WARNING_MISSED_CHECKINS = 5;

// Annual liveness ping cadence and how long an unanswered ping waits before
// the operator is alerted that the beneficiary address may be dead.
const DEFAULT_PING_INTERVAL_DAYS = 365;
const DEFAULT_PING_ACK_GRACE_DAYS = 30;

// A "missed" check-in is counted at the tick that SENDS a check-in email
// (the tick proves a full interval passed since the last response). So
// missed = 1 means "the first check-in email has just gone out" — the
// operator has not failed to answer anything yet. A warning is only truthful
// once at least one check-in email has gone a full interval unanswered,
// i.e. missed >= 2. Never warn below that, whatever the configuration.
const MIN_WARNING_MISSED_CHECKINS = 2;

// The configured threshold assumes the inactivity period holds many check-in
// intervals. When it does not (1-week check-ins with a 1-month deadline, or a
// compressed test run), a fixed count would never be reached and the switch
// would fire with no warning at all. Clamp the threshold so the warning goes
// out no later than the second-to-last tick before the deadline (leaving one
// tick for a resend) — but never below MIN_WARNING_MISSED_CHECKINS. With a
// deadline of two check-in intervals or less no truthful warning is possible
// and none is sent; warningPossible() lets the UI say so at deploy time.
function effectiveWarningThreshold({ threshold, checkinIntervalMs, inactivityMs }) {
  if (!checkinIntervalMs || !inactivityMs || inactivityMs <= checkinIntervalMs) {
    return Math.max(MIN_WARNING_MISSED_CHECKINS, threshold);
  }
  const ticksBeforeFire = Math.ceil(inactivityMs / checkinIntervalMs) - 1;
  return Math.max(
    MIN_WARNING_MISSED_CHECKINS,
    Math.min(threshold, ticksBeforeFire - 1),
  );
}

// Number of check-in ticks that occur strictly before the deadline.
function ticksBeforeFire({ checkinIntervalMs, inactivityMs }) {
  if (!checkinIntervalMs || !inactivityMs) return 0;
  return Math.max(0, Math.ceil(inactivityMs / checkinIntervalMs) - 1);
}

// Will a pre-fire warning ever be sent with these periods? False when the
// inactivity period is not more than twice the check-in interval.
function warningPossible({ threshold, checkinIntervalMs, inactivityMs }) {
  return (
    ticksBeforeFire({ checkinIntervalMs, inactivityMs }) >=
    effectiveWarningThreshold({ threshold, checkinIntervalMs, inactivityMs })
  );
}

// Decide what to do about the pre-fire warning at a periodic check-in tick.
// missedCheckins = consecutive intervals of operator silence (counted at
// tick time; the tick itself proves a full interval passed with no check-in).
// Returns 'send' both for the first send and for escalation resends — while
// the warning is unacknowledged it goes out again every tick; once the
// beneficiary acknowledges, resends stop.
function warningAction({ missedCheckins, threshold, warningAckAt }) {
  if (missedCheckins < threshold) return "none";
  if (warningAckAt) return "none";
  return "send";
}

// Decide what the daily sweep should do for one beneficiary address.
// All times are epoch milliseconds; null/undefined mean "never".
function pingAction({
  now,
  pingSentAt,
  ackAt,
  operatorAlertedAt,
  intervalMs,
  graceMs,
}) {
  if (!pingSentAt) return "send"; // never verified — start the first cycle
  if (!ackAt) {
    // Outstanding unanswered ping: after the grace window, tell the operator
    // once (while they are still around to fix the address). No new annual
    // pings while this one is unanswered — louder mail into a dead inbox is
    // noise into a void.
    if (now - pingSentAt >= graceMs && !operatorAlertedAt) {
      return "alert-operator";
    }
    return "none";
  }
  // Last cycle was acknowledged — start a new one when the year is up.
  if (now - pingSentAt >= intervalMs) return "send";
  return "none";
}

module.exports = {
  DEFAULT_WARNING_MISSED_CHECKINS,
  DEFAULT_PING_INTERVAL_DAYS,
  DEFAULT_PING_ACK_GRACE_DAYS,
  MIN_WARNING_MISSED_CHECKINS,
  effectiveWarningThreshold,
  ticksBeforeFire,
  warningPossible,
  warningAction,
  pingAction,
};
