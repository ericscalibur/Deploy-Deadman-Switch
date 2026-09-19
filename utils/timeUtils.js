// Hard ceilings the parsers enforce. validateTimeInterval() must reject
// anything above these, because the parsers below fall back to a default on
// out-of-range input rather than throwing — a value that passes validation
// but exceeds the ceiling would silently arm the switch with a different
// timer than the one the operator typed.
const MAX_CHECKIN_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weeks
const MAX_INACTIVITY_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// Floors (v2.2.2). 3-minute check-ins with a 9-minute deadline is the
// smallest configuration that lets a real end-to-end test run — deploy,
// arm by reply, answer a check-in, see the warning and the trigger — with
// enough room for mail delivery on each step; anything tighter races the
// mail. The sandbox harness (DEPLOY_TEST_HOOKS=1) may go down to 1 / 3.
const SANDBOX = process.env.DEPLOY_TEST_HOOKS === "1";
const MIN_CHECKIN_MS = (SANDBOX ? 1 : 3) * 60 * 1000;
const MIN_INACTIVITY_MS = (SANDBOX ? 3 : 9) * 60 * 1000;

const UNIT_MS = {
  minute: 60 * 1000,
  minutes: 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
};

// Helper function to get interval in milliseconds based on user selection
function getIntervalMs(intervalValue) {
  if (!intervalValue) {
    return 2 * 60 * 60 * 1000; // Default to 2 hours
  }

  // Handle legacy format for backward compatibility
  switch (intervalValue) {
    case "2-hours":
      return 2 * 60 * 60 * 1000;
    case "2-days":
      return 2 * 24 * 60 * 60 * 1000;
    case "2-weeks":
      return 2 * 7 * 24 * 60 * 60 * 1000;
  }

  // Handle new custom format: "value-unit"
  const parts = intervalValue.split("-");

  if (parts.length !== 2) {
    return 2 * 60 * 60 * 1000; // Default
  }

  const value = parseInt(parts[0], 10);
  const unit = parts[1];

  if (isNaN(value) || value < 1) {
    return 2 * 60 * 60 * 1000; // Default
  }

  // Granular value constraints based on unit type
  const unitConstraints = {
    minute: { max: 60, name: "minutes" },
    minutes: { max: 60, name: "minutes" },
    hour: { max: 24, name: "hours" },
    hours: { max: 24, name: "hours" },
    day: { max: 365, name: "days" },
    days: { max: 365, name: "days" },
    week: { max: 52, name: "weeks" },
    weeks: { max: 52, name: "weeks" },
  };

  // Check unit-specific constraints
  if (unitConstraints[unit] && value > unitConstraints[unit].max) {
    console.warn(
      `Check-in interval value ${value} exceeds maximum of ${unitConstraints[unit].max} for ${unitConstraints[unit].name}`,
    );
    return 2 * 60 * 60 * 1000; // Default to 2 hours
  }

  const multipliers = {
    minute: 60 * 1000,
    minutes: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };

  const ms = value * (multipliers[unit] || multipliers.hours);

  // Validation limits for check-in intervals
  const MIN_INTERVAL = MIN_CHECKIN_MS;
  const MAX_INTERVAL = MAX_CHECKIN_MS; // 4 weeks maximum

  if (ms < MIN_INTERVAL || ms > MAX_INTERVAL) {
    return 2 * 60 * 60 * 1000; // Default to 2 hours
  }

  return ms;
}

// Helper function to get inactivity period in milliseconds based on user selection
function getInactivityMs(periodValue) {
  if (!periodValue) return 24 * 60 * 60 * 1000; // Default to 1 day

  // Handle legacy format for backward compatibility
  switch (periodValue) {
    case "12-hours":
      return 12 * 60 * 60 * 1000;
    case "1-day":
      return 24 * 60 * 60 * 1000;
    case "3-days":
      return 3 * 24 * 60 * 60 * 1000;
    case "1-week":
      return 7 * 24 * 60 * 60 * 1000;
    case "1-month":
      return 30 * 24 * 60 * 60 * 1000;
  }

  // Handle new custom format: "value-unit"
  const parts = periodValue.split("-");
  if (parts.length !== 2) return 24 * 60 * 60 * 1000; // Default

  const value = parseInt(parts[0], 10);
  const unit = parts[1];

  if (isNaN(value) || value < 1) return 24 * 60 * 60 * 1000; // Default

  // Granular value constraints based on unit type
  const unitConstraints = {
    minute: { max: 60, name: "minutes" },
    minutes: { max: 60, name: "minutes" },
    hour: { max: 24, name: "hours" },
    hours: { max: 24, name: "hours" },
    day: { max: 365, name: "days" },
    days: { max: 365, name: "days" },
    week: { max: 52, name: "weeks" },
    weeks: { max: 52, name: "weeks" },
    month: { max: 12, name: "months" },
    months: { max: 12, name: "months" },
  };

  // Check unit-specific constraints
  if (unitConstraints[unit] && value > unitConstraints[unit].max) {
    console.warn(
      `Inactivity period value ${value} exceeds maximum of ${unitConstraints[unit].max} for ${unitConstraints[unit].name}`,
    );
    return 24 * 60 * 60 * 1000; // Default to 1 day
  }

  const multipliers = {
    minute: 60 * 1000,
    minutes: 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
  };

  const ms = value * (multipliers[unit] || multipliers.days);

  // Validation limits for inactivity periods
  const MIN_INACTIVITY = MIN_INACTIVITY_MS;
  // One calendar year. Expressed in days so that every way the UI lets a
  // user say "a year" (365 days, 52 weeks, 12 months) lands inside the range.
  const MAX_INACTIVITY = MAX_INACTIVITY_MS;

  if (ms < MIN_INACTIVITY || ms > MAX_INACTIVITY) {
    console.warn(
      `Inactivity period ${periodValue} out of range, using default`,
    );
    return 24 * 60 * 60 * 1000; // Default to 1 day
  }

  return ms;
}

// Function to validate time interval values based on unit constraints
function validateTimeInterval(intervalValue, isInactivityPeriod = false) {
  if (!intervalValue) {
    return { isValid: false, error: "Interval value is required" };
  }

  const parts = intervalValue.split("-");
  if (parts.length !== 2) {
    return {
      isValid: false,
      error: "Invalid format. Use 'value-unit' format (e.g., '2-hours')",
    };
  }

  const value = parseInt(parts[0], 10);
  const unit = parts[1];

  if (isNaN(value) || value < 1) {
    return { isValid: false, error: "Value must be a positive number" };
  }

  // Define constraints for each unit type
  const unitConstraints = {
    minute: { max: 60, name: "minutes" },
    minutes: { max: 60, name: "minutes" },
    hour: { max: 24, name: "hours" },
    hours: { max: 24, name: "hours" },
    day: { max: 365, name: "days" },
    days: { max: 365, name: "days" },
    week: { max: 52, name: "weeks" },
    weeks: { max: 52, name: "weeks" },
    month: { max: 12, name: "months" },
    months: { max: 12, name: "months" },
  };

  // Check if unit is valid
  if (!unitConstraints[unit]) {
    return {
      isValid: false,
      error: `Invalid unit '${unit}'. Valid units are: minutes, hours, days, weeks${isInactivityPeriod ? ", months" : ""}`,
    };
  }

  // Check if months are allowed (only for inactivity period)
  if ((unit === "month" || unit === "months") && !isInactivityPeriod) {
    return {
      isValid: false,
      error:
        "Months are only allowed for inactivity periods, not check-in intervals",
    };
  }

  // Check unit-specific constraints
  const constraint = unitConstraints[unit];
  if (value > constraint.max) {
    return {
      isValid: false,
      error: `Maximum value for ${constraint.name} is ${constraint.max}. You entered ${value}.`,
    };
  }

  // Check the floor and the ceiling the parser will actually honour.
  const ms = value * UNIT_MS[unit];
  if (!isInactivityPeriod && ms < MIN_CHECKIN_MS) {
    return {
      isValid: false,
      error: `Check-in interval cannot be shorter than ${MIN_CHECKIN_MS / 60000} minutes. You entered ${value} ${constraint.name}.`,
    };
  }
  if (isInactivityPeriod && ms < MIN_INACTIVITY_MS) {
    return {
      isValid: false,
      error: `Inactivity period cannot be shorter than ${MIN_INACTIVITY_MS / 60000} minutes. You entered ${value} ${constraint.name}.`,
    };
  }
  if (!isInactivityPeriod && ms > MAX_CHECKIN_MS) {
    return {
      isValid: false,
      error: `Check-in interval cannot be longer than 4 weeks (28 days). You entered ${value} ${constraint.name}.`,
    };
  }
  if (isInactivityPeriod && ms > MAX_INACTIVITY_MS) {
    return {
      isValid: false,
      error: `Inactivity period cannot be longer than 1 year (365 days). You entered ${value} ${constraint.name}.`,
    };
  }

  return { isValid: true };
}

// Convert milliseconds back to a check-in interval name
function getIntervalName(ms) {
  const units = [
    { name: "weeks", ms: 7 * 24 * 60 * 60 * 1000 },
    { name: "days", ms: 24 * 60 * 60 * 1000 },
    { name: "hours", ms: 60 * 60 * 1000 },
    { name: "minutes", ms: 60 * 1000 },
  ];

  for (const unit of units) {
    if (ms >= unit.ms && ms % unit.ms === 0) {
      const value = ms / unit.ms;
      return `${value}-${unit.name}`;
    }
  }

  // Fallback to hours
  const hours = Math.round(ms / (60 * 60 * 1000));
  return `${hours}-hours`;
}

// Convert milliseconds back to an inactivity period name
function getInactivityName(ms) {
  const units = [
    { name: "months", ms: 30 * 24 * 60 * 60 * 1000 },
    { name: "weeks", ms: 7 * 24 * 60 * 60 * 1000 },
    { name: "days", ms: 24 * 60 * 60 * 1000 },
    { name: "hours", ms: 60 * 60 * 1000 },
    { name: "minutes", ms: 60 * 1000 },
  ];

  for (const unit of units) {
    if (ms >= unit.ms && ms % unit.ms === 0) {
      const value = ms / unit.ms;
      return `${value}-${unit.name}`;
    }
  }

  // Fallback to days
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return `${days}-days`;
}

module.exports = {
  MIN_CHECKIN_MS,
  MIN_INACTIVITY_MS,
  MAX_CHECKIN_MS,
  MAX_INACTIVITY_MS,
  MAX_CHECKIN_MS,
  MAX_INACTIVITY_MS,
  getIntervalMs,
  getInactivityMs,
  validateTimeInterval,
  getIntervalName,
  getInactivityName,
};
