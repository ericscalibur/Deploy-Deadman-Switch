# Value Constraints Implementation

This document demonstrates the new value constraints added to the Deploy Deadman Switch application.

## Overview

Value constraints have been implemented to prevent users from entering invalid time intervals that could cause issues with the deadman switch functionality.

## Constraint Rules

### Check-in Intervals
- **Minutes**: 1-60 (maximum 60 minutes)
- **Hours**: 1-24 (maximum 24 hours)  
- **Days**: 1-365 (maximum 365 days)
- **Weeks**: 1-52 (maximum 52 weeks)
- **Months**: NOT ALLOWED (months can only be used for inactivity periods)

### Inactivity Periods
- **Minutes**: 1-60 (maximum 60 minutes)
- **Hours**: 1-24 (maximum 24 hours)
- **Days**: 1-365 (maximum 365 days)
- **Weeks**: 1-52 (maximum 52 weeks)
- **Months**: 1-12 (maximum 12 months)

## Implementation Details

### Server-side Validation

The constraints are enforced in the `validateTimeInterval()` function in `routes/deadman-minimal.js`:

```javascript
// Example usage
const validation = validateTimeInterval('13-months', true);
// Returns: { isValid: false, error: 'Maximum value for months is 12. You entered 13.' }

const validation2 = validateTimeInterval('25-hours', false);
// Returns: { isValid: false, error: 'Maximum value for hours is 24. You entered 25.' }
```

### Client-side Validation

The frontend automatically:
1. Updates the `max` attribute on input fields based on selected unit
2. Shows alerts when users exceed limits
3. Automatically corrects values to the maximum allowed

### HTML Input Constraints

The number inputs have dynamic `max` attributes that change based on the selected time unit:

```html
<input type="number" id="checkin-value" min="1" max="60" />
<!-- max changes to 24 when "hours" is selected -->
<!-- max changes to 365 when "days" is selected -->
```

## Testing

Run the constraint tests with:

```bash
# Start the server first
node server.js

# In another terminal, run the tests
node test_constraints.js
```

## Example Scenarios

### Valid Inputs
- `2-hours` ✅ (check-in interval)
- `1-days` ✅ (inactivity period)
- `12-months` ✅ (inactivity period only)
- `52-weeks` ✅ (both check-in and inactivity)

### Invalid Inputs
- `61-minutes` ❌ Exceeds maximum of 60 minutes
- `25-hours` ❌ Exceeds maximum of 24 hours
- `366-days` ❌ Exceeds maximum of 365 days
- `53-weeks` ❌ Exceeds maximum of 52 weeks
- `13-months` ❌ Exceeds maximum of 12 months
- `6-months` ❌ Months not allowed for check-in intervals

### Error Responses

When invalid values are submitted, the server returns detailed error messages:

```json
{
  "message": "Invalid inactivity period: Maximum value for months is 12. You entered 13."
}
```

## User Experience

1. **Real-time validation**: Input fields show immediate feedback
2. **Automatic correction**: Values are clamped to valid ranges
3. **Clear error messages**: Users understand what went wrong and how to fix it
4. **Dynamic limits**: Max values change based on selected time unit

## Files Modified

- `routes/deadman-minimal.js`: Added `validateTimeInterval()` function and server-side validation
- `public/script.js`: Added client-side validation with dynamic max attributes
- `public/index.html`: Updated input max attributes
- `test_constraints.js`: Comprehensive test suite for all constraints

## Benefits

1. **Prevents system errors** from extremely large time values
2. **Improves user experience** with immediate feedback
3. **Ensures reasonable limits** for deadman switch functionality
4. **Maintains data integrity** with both client and server validation
5. **Provides clear guidance** on acceptable values

## Edge Cases Handled

- Empty or null values
- Non-numeric values
- Negative numbers
- Invalid time units
- Format errors (missing dash separator)
- Zero values
- Extremely large values that could cause integer overflow

The constraint system is robust and handles all common input validation scenarios while providing helpful feedback to users.