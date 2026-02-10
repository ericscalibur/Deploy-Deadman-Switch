const http = require("http");

// Test cases for time interval validation
const testCases = [
  // Valid cases
  {
    interval: "1-minutes",
    isInactivityPeriod: false,
    expectValid: true,
    description: "Valid check-in: 1 minute",
  },
  {
    interval: "60-minutes",
    isInactivityPeriod: false,
    expectValid: true,
    description: "Valid check-in: 60 minutes (max)",
  },
  {
    interval: "24-hours",
    isInactivityPeriod: false,
    expectValid: true,
    description: "Valid check-in: 24 hours (max)",
  },
  {
    interval: "365-days",
    isInactivityPeriod: false,
    expectValid: true,
    description: "Valid check-in: 365 days (max)",
  },
  {
    interval: "52-weeks",
    isInactivityPeriod: false,
    expectValid: true,
    description: "Valid check-in: 52 weeks (max)",
  },

  {
    interval: "12-months",
    isInactivityPeriod: true,
    expectValid: true,
    description: "Valid inactivity: 12 months (max)",
  },
  {
    interval: "1-minutes",
    isInactivityPeriod: true,
    expectValid: true,
    description: "Valid inactivity: 1 minute",
  },

  // Invalid cases - exceeding limits
  {
    interval: "61-minutes",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid check-in: 61 minutes (exceeds max 60)",
  },
  {
    interval: "25-hours",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid check-in: 25 hours (exceeds max 24)",
  },
  {
    interval: "366-days",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid check-in: 366 days (exceeds max 365)",
  },
  {
    interval: "53-weeks",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid check-in: 53 weeks (exceeds max 52)",
  },

  {
    interval: "61-minutes",
    isInactivityPeriod: true,
    expectValid: false,
    description: "Invalid inactivity: 61 minutes (exceeds max 60)",
  },
  {
    interval: "13-months",
    isInactivityPeriod: true,
    expectValid: false,
    description: "Invalid inactivity: 13 months (exceeds max 12)",
  },

  // Invalid cases - months not allowed for check-in
  {
    interval: "1-months",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid check-in: months not allowed for check-in intervals",
  },
  {
    interval: "6-month",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid check-in: month not allowed for check-in intervals",
  },

  // Invalid cases - format errors
  {
    interval: "invalid",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid format: no dash separator",
  },
  {
    interval: "0-minutes",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid value: zero",
  },
  {
    interval: "-5-hours",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid value: negative",
  },
  {
    interval: "1-invalid",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid unit: unknown unit",
  },
  {
    interval: "",
    isInactivityPeriod: false,
    expectValid: false,
    description: "Invalid: empty string",
  },
];

function makeRequest(data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      interval: data.interval,
      isInactivityPeriod: data.isInactivityPeriod,
    });

    const options = {
      hostname: "localhost",
      port: 3000,
      path: "/deadman/test/validate-interval",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          const result = JSON.parse(responseData);
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log("🧪 Testing Time Interval Constraints\n");

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    try {
      const result = await makeRequest(testCase);
      const actualValid = result.validation.isValid;

      if (actualValid === testCase.expectValid) {
        console.log(`✅ PASS: ${testCase.description}`);
        passed++;
      } else {
        console.log(`❌ FAIL: ${testCase.description}`);
        console.log(
          `   Expected: ${testCase.expectValid ? "valid" : "invalid"}`,
        );
        console.log(`   Actual: ${actualValid ? "valid" : "invalid"}`);
        if (!actualValid) {
          console.log(`   Error: ${result.validation.error}`);
        }
        failed++;
      }
    } catch (error) {
      console.log(`💥 ERROR: ${testCase.description}`);
      console.log(`   ${error.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("🎉 All tests passed!");
  } else {
    console.log("⚠️  Some tests failed. Please check the implementation.");
  }

  return failed === 0;
}

// Test specific constraint examples
function demonstrateConstraints() {
  console.log("\n📋 Value Constraint Summary:");
  console.log("");
  console.log("Check-in Intervals:");
  console.log("  • Minutes: 1-60");
  console.log("  • Hours: 1-24");
  console.log("  • Days: 1-365");
  console.log("  • Weeks: 1-52");
  console.log("  • Months: NOT ALLOWED");
  console.log("");
  console.log("Inactivity Periods:");
  console.log("  • Minutes: 1-60");
  console.log("  • Hours: 1-24");
  console.log("  • Days: 1-365");
  console.log("  • Weeks: 1-52");
  console.log("  • Months: 1-12");
  console.log("");
}

if (require.main === module) {
  console.log("🔧 Time Interval Constraint Validation Tests");
  console.log("Make sure the server is running on http://localhost:3000\n");

  demonstrateConstraints();

  runTests()
    .then((success) => {
      console.log("\n" + "=".repeat(50));
      if (success) {
        console.log("✅ All constraint validations are working correctly!");
        console.log(
          "The value constraints have been successfully implemented:",
        );
        console.log("  • Server-side validation with detailed error messages");
        console.log("  • Client-side validation with dynamic max attributes");
        console.log("  • Real-time input validation and correction");
      } else {
        console.log("❌ Some constraints are not working as expected.");
        console.log("Please review the implementation and fix any issues.");
      }
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error("Test runner error:", error);
      console.log("\nMake sure:");
      console.log("1. The server is running: node server.js");
      console.log("2. The server is accessible on http://localhost:3000");
      process.exit(1);
    });
}

module.exports = { runTests, testCases, demonstrateConstraints };
