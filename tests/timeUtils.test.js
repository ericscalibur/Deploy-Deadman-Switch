const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  getIntervalMs,
  getInactivityMs,
  validateTimeInterval,
  getIntervalName,
  getInactivityName,
} = require("../utils/timeUtils");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

describe("getIntervalMs", () => {
  test("returns 2 hours as default when no value given", () => {
    assert.equal(getIntervalMs(null), 2 * HOUR);
    assert.equal(getIntervalMs(undefined), 2 * HOUR);
    assert.equal(getIntervalMs(""), 2 * HOUR);
  });

  test("handles legacy format", () => {
    assert.equal(getIntervalMs("1-minute"), MIN);
    assert.equal(getIntervalMs("2-hours"), 2 * HOUR);
    assert.equal(getIntervalMs("2-days"), 2 * DAY);
    assert.equal(getIntervalMs("2-weeks"), 2 * WEEK);
  });

  test("handles custom value-unit format", () => {
    assert.equal(getIntervalMs("5-minutes"), 5 * MIN);
    assert.equal(getIntervalMs("3-hours"), 3 * HOUR);
    assert.equal(getIntervalMs("7-days"), 7 * DAY);
    assert.equal(getIntervalMs("1-week"), WEEK);
  });

  test("returns default for out-of-range values", () => {
    assert.equal(getIntervalMs("100-minutes"), 2 * HOUR); // exceeds max 60
    assert.equal(getIntervalMs("999-hours"), 2 * HOUR);   // exceeds max 24
  });

  test("returns default for invalid format", () => {
    assert.equal(getIntervalMs("invalid"), 2 * HOUR);
    assert.equal(getIntervalMs("0-hours"), 2 * HOUR);
    assert.equal(getIntervalMs("-1-hours"), 2 * HOUR);
  });

  test("does not allow months (only for inactivity)", () => {
    // "month" is not in the interval multipliers; falls back to hours multiplier
    // so 1 * hours = 1 HOUR, which is within range and returned as-is
    assert.equal(getIntervalMs("1-month"), HOUR);
  });
});

describe("getInactivityMs", () => {
  test("returns 1 day as default when no value given", () => {
    assert.equal(getInactivityMs(null), DAY);
    assert.equal(getInactivityMs(undefined), DAY);
  });

  test("handles legacy format", () => {
    assert.equal(getInactivityMs("2-minutes"), 2 * MIN);
    assert.equal(getInactivityMs("12-hours"), 12 * HOUR);
    assert.equal(getInactivityMs("1-day"), DAY);
    assert.equal(getInactivityMs("3-days"), 3 * DAY);
    assert.equal(getInactivityMs("1-week"), WEEK);
    assert.equal(getInactivityMs("1-month"), MONTH);
  });

  test("handles custom value-unit format", () => {
    assert.equal(getInactivityMs("6-hours"), 6 * HOUR);
    assert.equal(getInactivityMs("14-days"), 14 * DAY);
    assert.equal(getInactivityMs("3-months"), 3 * MONTH);
  });

  test("returns default for out-of-range values", () => {
    assert.equal(getInactivityMs("13-months"), DAY); // exceeds max 12
    assert.equal(getInactivityMs("366-days"), DAY);  // exceeds max 365
  });
});

describe("validateTimeInterval", () => {
  test("rejects missing value", () => {
    assert.equal(validateTimeInterval(null).isValid, false);
    assert.equal(validateTimeInterval("").isValid, false);
  });

  test("rejects invalid format", () => {
    const r = validateTimeInterval("nounits");
    assert.equal(r.isValid, false);
    assert.match(r.error, /Invalid format/);
  });

  test("rejects non-positive numbers", () => {
    assert.equal(validateTimeInterval("0-hours").isValid, false);
    assert.equal(validateTimeInterval("-5-hours").isValid, false);
    assert.equal(validateTimeInterval("abc-hours").isValid, false);
  });

  test("rejects unknown units", () => {
    const r = validateTimeInterval("5-years");
    assert.equal(r.isValid, false);
    assert.match(r.error, /Invalid unit/);
  });

  test("rejects months for check-in interval", () => {
    const r = validateTimeInterval("1-months", false);
    assert.equal(r.isValid, false);
    assert.match(r.error, /Months are only allowed/);
  });

  test("allows months for inactivity period", () => {
    assert.equal(validateTimeInterval("3-months", true).isValid, true);
  });

  test("rejects values exceeding unit max", () => {
    const r = validateTimeInterval("25-hours");
    assert.equal(r.isValid, false);
    assert.match(r.error, /Maximum value/);
  });

  test("accepts valid intervals", () => {
    assert.equal(validateTimeInterval("30-minutes").isValid, true);
    assert.equal(validateTimeInterval("12-hours").isValid, true);
    assert.equal(validateTimeInterval("7-days").isValid, true);
    assert.equal(validateTimeInterval("4-weeks").isValid, true);
  });
});

describe("getIntervalName", () => {
  test("converts ms to readable name", () => {
    assert.equal(getIntervalName(WEEK), "1-weeks");
    assert.equal(getIntervalName(2 * DAY), "2-days");
    assert.equal(getIntervalName(3 * HOUR), "3-hours");
    assert.equal(getIntervalName(30 * MIN), "30-minutes");
  });

  test("falls back to hours for sub-minute values", () => {
    // 90 seconds is not divisible by any whole unit (minute = 60s)
    const result = getIntervalName(90 * 1000);
    assert.match(result, /-hours$/);
  });
});

describe("getInactivityName", () => {
  test("converts ms to readable name", () => {
    assert.equal(getInactivityName(3 * MONTH), "3-months");
    assert.equal(getInactivityName(2 * WEEK), "2-weeks");
    assert.equal(getInactivityName(5 * DAY), "5-days");
    assert.equal(getInactivityName(6 * HOUR), "6-hours");
  });

  test("falls back to days for sub-minute values", () => {
    // 90 seconds is not divisible by any whole unit
    const result = getInactivityName(90 * 1000);
    assert.match(result, /-days$/);
  });
});
