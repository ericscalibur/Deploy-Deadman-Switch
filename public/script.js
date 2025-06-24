// This is a comment
document.addEventListener("DOMContentLoaded", async () => {
  const loginForm = document.getElementById("login-form");
  const loginPage = document.getElementById("login-page");
  const setupPage = document.getElementById("setup-page");
  const newEmailButton = document.getElementById("new-email-button");
  const signupLoginButton = document.getElementById("signup-login-button");
  const authButton = document.getElementById("auth-button");
  const logoutButton = document.getElementById("logout-button");
  const saveSettingsButton = document.getElementById("save-settings-button");

  const emailsTableBody = document.querySelector("#emails-table tbody");

  // Function to handle login/signup button click
  if (authButton) {
    authButton.addEventListener("click", async (event) => {
      event.preventDefault();
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      const mode = authButton.dataset.mode;
      const url = mode === "login" ? "/auth/login" : "/auth/signup";

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, password }),
        });

        const data = await response.json();

        if (response.ok) {
          // Store the token (e.g., in localStorage or a cookie)
          localStorage.setItem("token", data.token);

          if (mode === "signup") {
            // After successful signup, revert to login mode
            switchToLoginMode();
            alert("User created successfully! Please log in.");
          } else {
            // Hide the login page and show the setup page
            loginPage.style.display = "none";
            setupPage.style.display = "block";
            // Sync emails from localStorage to backend on login
            await syncEmailsToBackend();
            // Load emails when setup page is shown
            loadEmails();
            // Restore form selections
            restoreFormSelections();
            // Initialize countdown timers
            loadSavedActivity();
            if (deadmanSwitchActivated) {
              logActivity(); // Log current login as activity
            }
            await startCountdownTimers();
          }
        } else {
          alert(
            data.message ||
              (mode === "login" ? "Login failed" : "Signup failed"),
          );
        }
      } catch (error) {
        console.error(`Error during ${mode}:`, error);
        alert(`${mode === "login" ? "Login" : "Signup"} failed`);
      }
    });
  }

  // Function to switch to login mode
  function switchToLoginMode() {
    authButton.dataset.mode = "login";
    authButton.textContent = "Login";
    authButton.classList.remove("signup-mode");
    authButton.classList.add("login-mode");
    signupLoginButton.textContent = "Sign Up";
  }

  // Function to switch to signup mode
  function switchToSignupMode() {
    authButton.dataset.mode = "signup";
    authButton.textContent = "Submit";
    authButton.classList.remove("login-mode");
    authButton.classList.add("signup-mode");
    signupLoginButton.textContent = "Login";
  }

  let isToggling = false;

  signupLoginButton.addEventListener("click", (event) => {
    event.preventDefault();

    if (isToggling) {
      return;
    }

    isToggling = true;
    const mode = authButton.dataset.mode;

    if (mode === "login") {
      switchToSignupMode();
    } else {
      switchToLoginMode();
    }

    setTimeout(() => {
      isToggling = false;
    }, 300);
  });

  // Function to handle logout button click
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      // Remove the token from localStorage
      localStorage.removeItem("token");

      // Hide setup page and show login page
      setupPage.style.display = "none";
      loginPage.style.display = "block";

      // Reset form fields
      document.getElementById("email").value = "";
      document.getElementById("password").value = "";

      // Reset to login mode
      switchToLoginMode();
    });
  }

  // Function to handle activation
  async function activateDeadmanSwitch() {
    // Validate that all required settings are selected
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );
    const emails = JSON.parse(localStorage.getItem("emails") || "[]");

    // Check if user has made all required selections
    if (!savedFormData.checkinMethod) {
      alert("Please select a check-in method");
      return;
    }
    if (!savedFormData.checkinInterval) {
      alert("Please select a check-in interval");
      return;
    }
    if (!savedFormData.inactivityPeriod) {
      alert("Please select an inactivity period");
      return;
    }
    if (emails.length === 0) {
      alert(
        "❌ NO BENEFICIARY EMAILS CONFIGURED!\n\n" +
          "You must add at least one beneficiary email before activating the deadman switch.\n\n" +
          "Steps:\n" +
          "1. Click '+New' button below\n" +
          "2. Enter the recipient's email address\n" +
          "3. Enter your message content\n" +
          "4. Save the email\n" +
          "5. Then activate the deadman switch\n\n" +
          "Without beneficiary emails, the deadman switch has no one to notify!",
      );
      return;
    }

    // Additional validation: Check if emails were saved to backend
    try {
      const token = localStorage.getItem("token");
      const response = await fetch("/deadman/emails", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const backendData = await response.json();
        if (!backendData.emails || backendData.emails.length === 0) {
          alert(
            "⚠️ EMAILS NOT SAVED TO SERVER!\n\n" +
              "Your emails are stored locally but not on the server.\n" +
              "Please:\n" +
              "1. Click '+New' to add emails again\n" +
              "2. Make sure they save successfully\n" +
              "3. Then activate the deadman switch\n\n" +
              "This ensures your beneficiary emails will be sent when needed.",
          );
          return;
        }
      }
    } catch (error) {
      // Could not verify backend email storage
    }

    // Confirm activation
    const confirmed = confirm(
      "Are you sure you want to activate the Deadman Switch?\n\n" +
        `• Check-in emails will be sent every ${savedFormData.checkinInterval.replace("-", " ")}\n` +
        `• If you don't respond for ${savedFormData.inactivityPeriod.replace("-", " ")}, your ${emails.length} configured email(s) will be sent\n\n` +
        "This will start immediately. Continue?",
    );

    if (!confirmed) return;

    try {
      const token = localStorage.getItem("token");
      const response = await fetch("/deadman/activate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          checkinMethod: savedFormData.checkinMethod,
          checkinInterval: savedFormData.checkinInterval,
          inactivityPeriod: savedFormData.inactivityPeriod,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        alert(
          "Deadman Switch activated successfully! Check-in emails will begin shortly.",
        );
        // Set activation flag and restart timers with fresh data
        deadmanSwitchActivated = true;
        localStorage.setItem("deadmanSwitchActivated", "true");
        logActivity();
        await startCountdownTimers();
        // Update button state to deactivate functionality
        updateButtonState("active");
      } else {
        const errorData = await response.json();
        alert(
          "Failed to activate Deadman Switch: " +
            (errorData.message || "Unknown error"),
        );
      }
    } catch (error) {
      console.error("Error activating deadman switch:", error);
      alert("Failed to activate deadman switch");
    }
  }

  // Set up save settings button with proper onclick handler
  if (saveSettingsButton) {
    saveSettingsButton.onclick = activateDeadmanSwitch;
  }

  // Function to handle new email button click
  newEmailButton.addEventListener("click", () => {
    // Redirect to the edit email page (you'll need to create this page)
    window.location.href = "/edit-email.html"; // Assuming you'll create edit-email.html
  });

  // Function to populate the emails table
  function populateEmailsTable(emails) {
    emailsTableBody.innerHTML = ""; // Clear existing rows

    if (emails.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.textContent =
        "No emails added yet. Click +New to add your first email.";
      cell.style.fontStyle = "italic";
      cell.style.color = "#666";
      row.appendChild(cell);
      emailsTableBody.appendChild(row);
      return;
    }

    emails.forEach((email, index) => {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.textContent = `${index + 1}. ${email.address}`;
      cell.style.cursor = "pointer";
      cell.addEventListener("click", () => {
        // Redirect to the edit email page with the email data
        window.location.href = `/edit-email.html?index=${index}`;
      });
      row.appendChild(cell);
      emailsTableBody.appendChild(row);
    });
  }

  // Load emails from localStorage and populate the table
  function loadEmails() {
    const emails = JSON.parse(localStorage.getItem("emails") || "[]");
    populateEmailsTable(emails);
  }

  // Function to save form selections
  function saveFormSelections() {
    const formData = {
      checkinMethod: document.querySelector(
        'input[name="checkin-method"]:checked',
      )?.value,
      checkinInterval: document.querySelector(
        'input[name="checkin-interval"]:checked',
      )?.value,
      inactivityPeriod: document.querySelector(
        'input[name="inactivity-period"]:checked',
      )?.value,
    };
    localStorage.setItem("formSelections", JSON.stringify(formData));
  }

  // Function to restore form selections
  function restoreFormSelections() {
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );

    if (savedFormData.checkinMethod) {
      const checkinMethodInput = document.querySelector(
        `input[name="checkin-method"][value="${savedFormData.checkinMethod}"]`,
      );
      if (checkinMethodInput) checkinMethodInput.checked = true;
    }

    if (savedFormData.checkinInterval) {
      const checkinIntervalInput = document.querySelector(
        `input[name="checkin-interval"][value="${savedFormData.checkinInterval}"]`,
      );
      if (checkinIntervalInput) checkinIntervalInput.checked = true;
    }

    if (savedFormData.inactivityPeriod) {
      const inactivityPeriodInput = document.querySelector(
        `input[name="inactivity-period"][value="${savedFormData.inactivityPeriod}"]`,
      );
      if (inactivityPeriodInput) inactivityPeriodInput.checked = true;
    }
  }

  // Initially load emails
  loadEmails();

  // Countdown timer variables
  let checkinInterval = null;
  let deadmanInterval = null;
  let nextCheckinTime = null;
  let deadmanActivationTime = null;
  let lastActivityTime = new Date();
  let deadmanSwitchActivated = false;

  // Function to get interval in milliseconds based on user selection
  function getIntervalMs(intervalValue) {
    switch (intervalValue) {
      case "1-minute":
        return 1 * 60 * 1000; // 1 minute (testing)
      case "2-hours":
        return 2 * 60 * 60 * 1000;
      case "2-days":
        return 2 * 24 * 60 * 60 * 1000;
      case "2-weeks":
        return 2 * 7 * 24 * 60 * 60 * 1000;
      default:
        return 2 * 60 * 60 * 1000; // Default to 2 hours
    }
  }

  // Function to get inactivity period in milliseconds based on user selection
  function getInactivityMs(periodValue) {
    switch (periodValue) {
      case "3-minutes":
        return 3 * 60 * 1000; // 3 minutes (testing)
      case "1-day":
        return 1 * 24 * 60 * 60 * 1000;
      case "1-month":
        return 30 * 24 * 60 * 60 * 1000;
      case "3-months":
        return 3 * 30 * 24 * 60 * 60 * 1000;
      case "6-months":
        return 6 * 30 * 24 * 60 * 60 * 1000;
      case "9-months":
        return 9 * 30 * 24 * 60 * 60 * 1000;
      default:
        return 1 * 24 * 60 * 60 * 1000; // Default to 1 day
    }
  }

  // Function to format time as HH:MM:SS
  function formatTime(ms) {
    if (ms <= 0) return "00:00:00";

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  // Function to update countdown displays
  function updateCountdowns() {
    const now = new Date().getTime();

    // Update check-in countdown
    const checkinElement = document.getElementById("checkin-countdown");
    if (checkinElement) {
      if (!deadmanSwitchActivated || !nextCheckinTime) {
        checkinElement.textContent = "00:00:00";
      } else {
        const timeLeft = nextCheckinTime - now;
        checkinElement.textContent = formatTime(timeLeft);

        if (timeLeft <= 0) {
          // Don't recalculate locally - wait for backend sync
          checkinElement.textContent = "00:00:00";
        }
      }
    }

    // Update deadman countdown
    const deadmanElement = document.getElementById("deadman-countdown");
    if (deadmanElement) {
      if (!deadmanSwitchActivated || !deadmanActivationTime) {
        deadmanElement.textContent = "00:00:00";
      } else {
        const timeLeft = deadmanActivationTime - now;
        deadmanElement.textContent = formatTime(timeLeft);

        if (timeLeft <= 0) {
          deadmanElement.textContent = "ACTIVATED";
          deadmanElement.style.color = "#d9534f";
        }
      }
    }

    // Update last activity display
    const lastActivityElement = document.getElementById("last-activity");
    if (lastActivityElement) {
      if (!deadmanSwitchActivated) {
        lastActivityElement.textContent = "Not activated";
      } else {
        lastActivityElement.textContent = lastActivityTime.toLocaleString();
      }
    }
  }

  // Function to sync with backend timer status
  async function syncWithBackend() {
    try {
      const token = localStorage.getItem("token");
      if (!token) return;

      const response = await fetch("/deadman/timer-status", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();

        if (data.active) {
          // Update frontend with backend data
          deadmanSwitchActivated = true;
          lastActivityTime = new Date(data.lastActivity);

          // Calculate timers based on backend data
          const now = Date.now();
          nextCheckinTime = now + data.nextCheckin;
          deadmanActivationTime = now + data.deadmanActivation;

          // Update localStorage to keep in sync
          localStorage.setItem("deadmanSwitchActivated", "true");
          localStorage.setItem("lastActivity", data.lastActivity);

          // Update button to show deactivate option
          updateButtonState("active");
        } else {
          // No active deadman switch on backend - check if it was triggered
          await checkDeadmanStatus();
          // If deadman was triggered, we need to reload emails after localStorage clear
          if (!deadmanSwitchActivated) {
            loadEmails();
          }
        }
      } else {
        const errorText = await response.text();
        console.error("Timer-status error:", response.status, errorText);
      }
    } catch (error) {
      console.error("Sync error:", error);
    }
  }

  // Function to calculate next check-in time
  function calculateNextCheckin() {
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );
    if (savedFormData.checkinInterval) {
      const intervalMs = getIntervalMs(savedFormData.checkinInterval);
      nextCheckinTime = new Date().getTime() + intervalMs;
    }
  }

  // Function to calculate deadman activation time
  function calculateDeadmanActivation() {
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );
    if (savedFormData.inactivityPeriod) {
      const inactivityMs = getInactivityMs(savedFormData.inactivityPeriod);
      deadmanActivationTime = lastActivityTime.getTime() + inactivityMs;
    }
  }

  // Function to start countdown timers
  async function startCountdownTimers() {
    // Clear any existing intervals
    if (checkinInterval) clearInterval(checkinInterval);
    if (deadmanInterval) clearInterval(deadmanInterval);

    // Sync with backend first to get real timer data
    await syncWithBackend();

    // Only calculate times if deadman switch is activated and backend sync failed
    if (
      deadmanSwitchActivated &&
      (!nextCheckinTime || !deadmanActivationTime)
    ) {
      calculateNextCheckin();
      calculateDeadmanActivation();
    }

    // Update display immediately
    updateCountdowns();

    // Start updating every second
    checkinInterval = setInterval(updateCountdowns, 1000);

    // Sync with backend every 30 seconds to stay current
    setInterval(syncWithBackend, 30000);
  }

  // Function to log activity (resets deadman timer)
  function logActivity() {
    lastActivityTime = new Date();
    calculateDeadmanActivation();
    localStorage.setItem("lastActivity", lastActivityTime.toISOString());

    // Send activity to backend if deadman switch is active
    if (deadmanSwitchActivated) {
      sendActivityToBackend();
    }
  }

  // Function to send activity to backend
  async function sendActivityToBackend() {
    try {
      const token = localStorage.getItem("token");
      await fetch("/deadman/activity", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          timestamp: lastActivityTime.toISOString(),
        }),
      });
    } catch (error) {
      // Could not send activity to backend
    }
  }

  // Function to load saved activity time
  function loadSavedActivity() {
    const savedActivity = localStorage.getItem("lastActivity");
    const savedActivated = localStorage.getItem("deadmanSwitchActivated");

    deadmanSwitchActivated = savedActivated === "true";

    if (savedActivity) {
      lastActivityTime = new Date(savedActivity);
    } else {
      // If no saved activity, use current time and save it
      lastActivityTime = new Date();
      localStorage.setItem("lastActivity", lastActivityTime.toISOString());
    }
  }

  // Check if the user is already logged in (e.g., by checking for a token in localStorage)
  const token = localStorage.getItem("token");
  if (token) {
    loginPage.style.display = "none";
    setupPage.style.display = "block";
    // Sync emails from localStorage to backend on login
    await syncEmailsToBackend();
    // Load emails when setup page is shown
    loadEmails();
    // Restore form selections
    restoreFormSelections();
    // Initialize countdown timers
    loadSavedActivity();
    if (deadmanSwitchActivated) {
      // Check deadman status and update button accordingly
      await checkDeadmanStatus();
    }
    await startCountdownTimers();
  } else {
    loginPage.style.display = "block";
    setupPage.style.display = "none";
  }

  // Add event listeners to save form selections when they change
  document.addEventListener("change", async (event) => {
    if (
      event.target.matches(
        'input[name="checkin-method"], input[name="checkin-interval"], input[name="inactivity-period"]',
      )
    ) {
      saveFormSelections();
      // Restart timers when settings change
      await startCountdownTimers();
    }
  });

  // Function to sync emails from localStorage to backend
  async function syncEmailsToBackend() {
    try {
      const localEmails = JSON.parse(localStorage.getItem("emails") || "[]");

      if (localEmails.length === 0) {
        return;
      }

      const token = localStorage.getItem("token");

      // Get current backend emails
      const getResponse = await fetch("/deadman/emails", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      let backendEmails = [];
      if (getResponse.ok) {
        const data = await getResponse.json();
        backendEmails = data.emails || [];
      }

      // If backend has fewer emails than frontend, sync them
      if (backendEmails.length < localEmails.length) {
        // Send each local email to backend
        for (let i = 0; i < localEmails.length; i++) {
          const email = localEmails[i];

          // Check if this email already exists in backend
          const exists = backendEmails.some(
            (be) =>
              be.address === email.address && be.content === email.content,
          );

          if (!exists) {
            const syncResponse = await fetch("/deadman/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                emailAddress: email.address,
                emailContent: email.content,
                emailIndex: null, // Add as new
              }),
            });

            if (!syncResponse.ok) {
              console.error(`Failed to sync email ${i + 1} to backend`);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error syncing emails to backend:", error);
    }
  }

  // Add comprehensive activity tracking
  const activityEvents = ["click", "keypress", "scroll", "mousemove"];
  // Function to check if deadman switch was triggered
  async function checkDeadmanStatus() {
    try {
      const token = localStorage.getItem("token");
      const response = await fetch("/deadman/deadman-status", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.triggered) {
          // Deadman was triggered - clear all local data and update UI
          deadmanSwitchActivated = false;
          localStorage.removeItem("deadmanSwitchActivated");
          localStorage.removeItem("lastActivity");
          // Clear local storage
          localStorage.removeItem("emails");
          localStorage.removeItem("formSelections");

          // Reload emails (should be empty now)
          loadEmails();

          updateButtonState("triggered");
        } else {
          // No deadman switch active
          deadmanSwitchActivated = false;
          localStorage.setItem("deadmanSwitchActivated", "false");
          updateButtonState("inactive");
        }
      }
    } catch (error) {
      console.error("Error checking deadman status:", error);
    }
  }

  // Function to update button state based on deadman status
  function updateButtonState(state) {
    if (!saveSettingsButton) return;

    switch (state) {
      case "active":
        saveSettingsButton.textContent = "Deactivate Deadman Switch";
        saveSettingsButton.style.backgroundColor = "#d9534f";
        saveSettingsButton.onclick = deactivateDeadmanSwitch;
        break;
      case "triggered":
        saveSettingsButton.textContent = "Reset - Clear All Data";
        saveSettingsButton.style.backgroundColor = "#f0ad4e";
        saveSettingsButton.onclick = resetDeadmanData;
        break;
      case "inactive":
      default:
        saveSettingsButton.textContent =
          "Save Settings & Activate Deadman Switch";
        saveSettingsButton.style.backgroundColor = "#d9534f";
        saveSettingsButton.onclick = activateDeadmanSwitch;
        break;
    }
  }

  // Function to deactivate deadman switch
  async function deactivateDeadmanSwitch() {
    const confirmed = confirm(
      "Are you sure you want to deactivate the Deadman Switch?\n\n" +
        "This will stop all check-in emails and cancel the deadman switch.",
    );

    if (!confirmed) return;

    try {
      const token = localStorage.getItem("token");
      const response = await fetch("/deadman/deactivate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        alert("Deadman Switch deactivated successfully!");
        // Reset local state
        deadmanSwitchActivated = false;
        localStorage.removeItem("deadmanSwitchActivated");
        localStorage.removeItem("lastActivity");

        // Update button state
        updateButtonState("inactive");

        // Reset countdown displays
        await startCountdownTimers();
      } else {
        const data = await response.json();
        alert(data.message || "Failed to deactivate deadman switch");
      }
    } catch (error) {
      console.error("Error deactivating deadman switch:", error);
      alert("Failed to deactivate deadman switch");
    }
  }

  // Function to reset deadman data after activation
  async function resetDeadmanData() {
    const confirmed = confirm(
      "Are you sure you want to reset all deadman switch data?\n\n" +
        "This will permanently delete:\n" +
        "• All configured emails\n" +
        "• All deadman switch settings\n" +
        "• All check-in tokens\n\n" +
        "You can then configure a new deadman switch from scratch.",
    );

    if (!confirmed) return;

    try {
      const token = localStorage.getItem("token");
      const response = await fetch("/deadman/reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        alert(
          "Deadman switch data has been reset successfully!\n\nYou can now configure a new deadman switch.",
        );

        // Clear local storage
        localStorage.removeItem("deadmanSwitchActivated");
        localStorage.removeItem("lastActivity");
        localStorage.removeItem("emails");
        localStorage.removeItem("formSelections");

        // Reset local state
        deadmanSwitchActivated = false;

        // Update button state
        updateButtonState("inactive");

        // Reload emails (should be empty now)
        loadEmails();

        // Reset countdown displays
        await startCountdownTimers();
      } else {
        const data = await response.json();
        alert(
          "Failed to reset deadman data: " + (data.message || "Unknown error"),
        );
      }
    } catch (error) {
      console.error("Error resetting deadman data:", error);
      alert("Failed to reset deadman data");
    }
  }

  // Activity should only be logged for:
  // 1. User logins (already handled)
  // 2. Check-in email link clicks (handled in backend)
});
