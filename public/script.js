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
      const url = mode === "login" ? "/deadman/login" : "/deadman/signup";

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
          // Store only the password for encryption (token is now in HTTP-only cookie)
          localStorage.setItem("userPassword", password);

          if (mode === "signup") {
            // After successful signup, revert to login mode
            switchToLoginMode();
            alert("User created successfully! Please log in.");
          } else {
            // Hide the login page and show the setup page
            loginPage.style.display = "none";
            setupPage.style.display = "block";
            // Load emails from backend (source of truth; localStorage clears on Tor Browser exit)
            await loadEmailsFromBackend();
            // Restore form selections from localStorage (overwritten by syncWithBackend if switch is active)
            restoreFormSelections();
            // Initialize countdown timers (syncWithBackend inside will restore interval settings if active)
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
    logoutButton.addEventListener("click", async () => {
      try {
        // Call logout endpoint to clear HTTP-only cookie
        await fetch("/deadman/logout", {
          method: "POST",
          credentials: "include", // Include cookies
        });
      } catch (error) {}

      // Remove password from localStorage
      localStorage.removeItem("userPassword");
      localStorage.removeItem("deadmanSwitchActivated");
      localStorage.removeItem("lastActivity");

      // Hide setup page and show login page
      setupPage.style.display = "none";
      loginPage.style.display = "block";

      // Reset form fields
      document.getElementById("email").value = "";
      document.getElementById("password").value = "";
    });
  }

  // Function to handle deployment
  async function activateDeadmanSwitch() {
    // Snapshot current form values before reading localStorage
    saveFormSelections();

    // Validate that all required settings are selected
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );
    const emails = JSON.parse(localStorage.getItem("emails") || "[]");

    // Check if user has made all required selections
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
          "You must add at least one beneficiary email before deploying the deadman switch.\n\n" +
          "Steps:\n" +
          "1. Click '+New' button below\n" +
          "2. Enter the recipient's email address\n" +
          "3. Enter your message content\n" +
          "4. Save the email\n" +
          "5. Then deploy the deadman switch\n\n" +
          "Without beneficiary emails, the deadman switch has no one to notify!",
      );
      return;
    }

    // Additional validation: Check if emails were saved to backend
    try {
      const password = localStorage.getItem("userPassword");
      const response = await fetch(
        `/deadman/emails?password=${encodeURIComponent(password)}`,
        {
          method: "GET",
          credentials: "include", // Include HTTP-only cookie
        },
      );

      if (response.ok) {
        const backendData = await response.json();
        if (!backendData.emails || backendData.emails.length === 0) {
          alert(
            "⚠️ EMAILS NOT SAVED TO SERVER!\n\n" +
              "Your emails are stored locally but not on the server.\n" +
              "Please:\n" +
              "1. Click '+New' to add emails again\n" +
              "2. Make sure they save successfully\n" +
              "3. Then deploy the deadman switch\n\n" +
              "This ensures your beneficiary emails will be sent when needed.",
          );
          return;
        }
      }
    } catch (error) {
      // Could not verify backend email storage
    }

    // Format intervals for display
    const formatInterval = (interval) => {
      if (!interval) return "unknown";
      const [value, unit] = interval.split("-");
      return `${value} ${unit}`;
    };

    // Confirm deployment
    const confirmed = confirm(
      "Are you sure you want to deploy the Deadman Switch?\n\n" +
        `• Check-in emails will be sent every ${formatInterval(savedFormData.checkinInterval)}\n` +
        `• If you don't respond for ${formatInterval(savedFormData.inactivityPeriod)}, your ${emails.length} configured email(s) will be sent\n\n` +
        "The countdown does NOT start yet: you'll get a check-in email right away, and clicking its link arms the switch. Continue?",
    );

    if (!confirmed) return;

    // Hold the 5s sync off the button until the server has actually created
    // the switch, and say plainly that work is happening — over Tor this
    // request is not instant, and an idle-looking button invites a second
    // click on the one action that should never be issued twice.
    switchMutationInFlight = true;
    setButtonBusy("Deploying…");

    try {
      const password = localStorage.getItem("userPassword");
      const requestData = {
        checkinMethod: savedFormData.checkinMethod,
        checkinInterval: savedFormData.checkinInterval,
        inactivityPeriod: savedFormData.inactivityPeriod,
        password: password,
      };

      const response = await fetch("/deadman/activate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // Include HTTP-only cookie
        body: JSON.stringify(requestData),
      });

      if (response.ok) {
        const data = await response.json();
        alert(
          data.message ||
            "Switch deployed and PENDING. Click the link in the check-in email just sent to you to arm it and start the countdown.",
        );
        // Set activation flag and restart timers with fresh data. The
        // switch is pending until the first check-in email link is clicked.
        deadmanSwitchActivated = true;
        deadmanSwitchPending = data.pending !== false;
        localStorage.setItem("deadmanSwitchActivated", "true");
        // The recipient rows say "Save and Deploy to send first contact
        // emails" until a switch exists. Repaint now rather than leaving
        // that stale for up to the status-refresh interval.
        loadEmails({ force: true });
        logActivity();
        await startCountdownTimers();
        // Update button state to deactivate functionality
        updateButtonState("active");
      } else {
        const errorData = await response.json();
        alert(
          "Failed to deploy Deadman Switch: " +
            (errorData.message || "Unknown error"),
        );
      }
    } catch (error) {
      alert("Failed to deploy deadman switch");
    } finally {
      // Released even on failure, or the dashboard would stop syncing.
      switchMutationInFlight = false;
      clearButtonBusy();
      syncWithBackend();
    }
  }

  // Set up save settings button with proper onclick handler
  if (saveSettingsButton) {
    saveSettingsButton.onclick = activateDeadmanSwitch;
  }

  // Function to handle new email button click
  newEmailButton.addEventListener("click", () => {
    saveFormSelections();
    window.location.href = "/edit-email.html";
  });

  // Function to populate the emails table
  function populateEmailsTable(emails) {
    emailsTableBody.innerHTML = ""; // Clear existing rows

    if (emails.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.textContent =
        "No emails added yet. Click +New to add your first email.";
      cell.className = "no-emails-cell";
      cell.colSpan = 2; // Span both columns
      row.appendChild(cell);
      emailsTableBody.appendChild(row);
      return;
    }

    emails.forEach((email, index) => {
      const row = document.createElement("tr");

      // Email info cell (clickable to edit)
      const emailCell = document.createElement("td");
      emailCell.className = "email-cell";
      const addressLine = document.createElement("div");
      addressLine.textContent = `${index + 1}. ${email.address}`;
      emailCell.appendChild(addressLine);
      // Whether this beneficiary has confirmed their address, when contact
      // checks are in use. Filled in by loadBeneficiaryStatus(); left empty
      // (and hidden) when there is nothing true to say.
      const contactLine = document.createElement("small");
      contactLine.className = "last-contact";
      contactLine.dataset.address = email.address || "";
      emailCell.appendChild(contactLine);
      emailCell.addEventListener("click", () => {
        saveFormSelections();
        window.location.href = `/edit-email.html?index=${index}`;
      });

      // Delete button cell
      const deleteCell = document.createElement("td");
      deleteCell.className = "delete-cell";

      const deleteButton = document.createElement("button");
      deleteButton.textContent = "Delete";
      deleteButton.className = "email-delete-btn";
      deleteButton.title = "Delete email";

      deleteButton.addEventListener("click", async (e) => {
        e.stopPropagation(); // Prevent triggering the row click

        const confirmed = confirm(
          `Are you sure you want to delete this email?\n\n${email.address}\n\nThis action cannot be undone.`,
        );

        if (confirmed) {
          await deleteEmail(index);
        }
      });

      deleteCell.appendChild(deleteButton);
      row.appendChild(emailCell);
      row.appendChild(deleteCell);
      emailsTableBody.appendChild(row);
    });
  }

  // Function to delete an email
  async function deleteEmail(index) {
    try {
      const password = localStorage.getItem("userPassword");

      // Delete from backend
      const response = await fetch(`/deadman/emails/${index}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // Include HTTP-only cookie
        body: JSON.stringify({
          password: password,
        }),
      });

      if (response.ok) {
        // Remove from localStorage
        const emails = JSON.parse(localStorage.getItem("emails") || "[]");
        emails.splice(index, 1);
        localStorage.setItem("emails", JSON.stringify(emails));

        // Refresh the table
        loadEmails();

        const delData = await response.json().catch(() => ({}));
        alert(delData.activeSwitchUpdated
          ? "Email deleted successfully!\n\nYour deadman switch is armed — this recipient has been removed from it and will NOT receive anything when it fires."
          : "Email deleted successfully!");
      } else {
        const errorData = await response.json();
        alert(
          "Failed to delete email: " + (errorData.message || "Unknown error"),
        );
      }
    } catch (error) {
      alert("Failed to delete email");
    }
  }

  // ---- Date rendering -------------------------------------------------
  // Every date is rendered in UTC and says so.
  //
  // Tor Browser pins the page's timezone to UTC as anti-fingerprinting — a
  // page that can read your real timezone has narrowed you to a slice of the
  // planet. So toLocaleString() renders UTC no matter where the operator is,
  // and an unlabelled date reads as simply wrong: in the Americas an evening
  // check-in shows tomorrow's date. Detecting the real zone is precisely
  // what that defence prevents, so the honest fix is to stop implying local
  // time and name the zone.
  function formatUtcDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "unknown";
    return (
      d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }) + " (UTC)"
    );
  }

  function formatUtcDateTime(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "unknown";
    return (
      d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
      }) + " (UTC)"
    );
  }

  // ---- Fired-switch notice (tester report #3) ----------------------------------
  // The notice is cleared only by the operator. Dismissal is remembered
  // against the activation timestamp, so a page reload does not resurrect a
  // notice already read, but a *new* activation always shows again.
  function activationDismissKey(activationTime) {
    return `activationAcknowledged:${activationTime || "unknown"}`;
  }

  function showActivationNotice(data) {
    const notice = document.getElementById("activation-notice");
    if (!notice) return;

    const activationTime = data.activationTime || null;
    if (localStorage.getItem(activationDismissKey(activationTime)) === "true") {
      notice.style.display = "none";
      return;
    }

    const detail = document.getElementById("activation-notice-detail");
    if (detail) {
      const when = activationTime
        ? formatUtcDateTime(activationTime)
        : "an earlier time (exact time unavailable)";
      const count = data.emailsSent;
      const delivered =
        typeof count === "number" && count > 0
          ? `${count} message${count === 1 ? "" : "s"} sent`
          : "delivery attempted";
      detail.textContent =
        `Your deadman switch fired on ${when} — ${delivered}. ` +
        `It fired because no check-in was received before the deadline.`;
    }

    notice.style.display = "block";

    const dismiss = document.getElementById("activation-notice-dismiss");
    if (dismiss && !dismiss.dataset.bound) {
      dismiss.dataset.bound = "true";
      dismiss.addEventListener("click", () => {
        localStorage.setItem(
          activationDismissKey(notice.dataset.activationTime || null),
          "true",
        );
        notice.style.display = "none";
      });
    }
    notice.dataset.activationTime = activationTime || "";
  }

  function hideActivationNotice() {
    const notice = document.getElementById("activation-notice");
    if (notice) notice.style.display = "none";
  }

  // Load emails from localStorage and populate the table.
  //
  // syncWithBackend() runs every 5s and calls this on every tick while no
  // switch is armed. Rebuilding the table unconditionally meant each tick
  // tore down the rows, leaving the contact subtext blank until the async
  // status fetch refilled it — so the line flickered and everything below
  // it jumped, twelve times a minute. Only touch the DOM when the list has
  // actually changed.
  let renderedEmailsSignature = null;
  let lastStatusFetch = 0;

  function emailsSignature(emails) {
    return JSON.stringify(
      emails.map((e) => [e.address || "", e.contactChecks !== false]),
    );
  }

  function loadEmails(options = {}) {
    const emails = JSON.parse(localStorage.getItem("emails") || "[]");
    const signature = emailsSignature(emails);
    const changed = signature !== renderedEmailsSignature;

    if (changed || options.force) {
      renderedEmailsSignature = signature;
      populateEmailsTable(emails);
    }

    // Contact status only changes when a recipient clicks their link, so it
    // does not need re-fetching every 5s — especially over Tor, and
    // especially carrying the decryption password.
    const now = Date.now();
    if (changed || options.force || now - lastStatusFetch > 60000) {
      lastStatusFetch = now;
      loadBeneficiaryStatus();
    }
  }

  // Annotate each recipient row with its annual-ping contact status.
  // Ping rows are keyed by address hash server-side; this endpoint maps
  // them back to readable addresses after decrypting with the password.
  async function loadBeneficiaryStatus() {
    const password = localStorage.getItem("userPassword");
    if (!password) return;
    try {
      const response = await fetch("/deadman/beneficiary-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!response.ok) return;
      const data = await response.json();
      for (const b of data.beneficiaries || []) {
        // Absence means on — that is what every server before this option
        // existed did, and what every recipient saved then expected.
        const contactChecks = b.contactChecksEnabled !== false;
        const el = document.querySelector(
          `.last-contact[data-address="${CSS.escape(b.address)}"]`,
        );
        if (!el) continue;
        el.className = "last-contact";
        // Order matters: a switch that has already fired is no longer
        // active, but its recipients were contacted — so the ping states are
        // checked before the not-yet-deployed state.
        if (b.ackAt) {
          // The only real proof this address reaches a living person: they
          // clicked. Worth stating even when contact checks are since off.
          el.textContent = `Contact confirmed by recipient ${formatUtcDate(b.ackAt)}`;
          el.classList.add("contact-ok");
        } else if (b.pingSentAt) {
          el.textContent = `Contact check sent ${formatUtcDate(b.pingSentAt)} — not yet confirmed`;
          el.classList.add("contact-pending");
        } else if (contactChecks && !deadmanSwitchActivated) {
          // Nothing has been attempted yet, and nothing will be until the
          // switch is deployed. "Not yet confirmed" would describe a pending
          // action that does not exist, and reads as a fault to fix rather
          // than a step not yet reached.
          el.textContent = "Save and Deploy to send first contact emails";
          el.classList.add("contact-not-started");
        } else if (contactChecks) {
          el.textContent = "Not yet confirmed by recipient";
          el.classList.add("contact-pending");
        } else {
          // Deliberately not being asked. Worth stating plainly — it is a
          // non-default choice with a real consequence, and silence here
          // would look like the confirmation was merely still pending.
          el.textContent = "Address confirmation off — never verified";
          el.classList.add("contact-off");
        }
      }
    } catch (e) {
      // Non-critical decoration; leave rows unannotated on failure
    }
  }

  // Load emails from the backend (used on login so Tor Browser session clears don't lose data)
  async function loadEmailsFromBackend() {
    const password = localStorage.getItem("userPassword");
    if (!password) { loadEmails(); return; }
    try {
      const response = await fetch(
        `/deadman/emails?password=${encodeURIComponent(password)}`,
        { method: "GET", credentials: "include" }
      );
      if (response.ok) {
        const data = await response.json();
        const emails = data.emails || [];
        localStorage.setItem("emails", JSON.stringify(emails));
        renderedEmailsSignature = emailsSignature(emails);
        populateEmailsTable(emails);
        lastStatusFetch = Date.now();
        loadBeneficiaryStatus();
      } else {
        loadEmails();
      }
    } catch (e) {
      loadEmails();
    }
  }

  // Function to save form selections
  function saveFormSelections() {
    const checkinValue = document.getElementById("checkin-value")?.value;
    const checkinUnit = document.getElementById("checkin-unit")?.value;
    const inactivityValue = document.getElementById("inactivity-value")?.value;
    const inactivityUnit = document.getElementById("inactivity-unit")?.value;

    const formData = {
      checkinMethod: "email",
      checkinInterval:
        checkinValue && checkinUnit ? `${checkinValue}-${checkinUnit}` : null,
      inactivityPeriod:
        inactivityValue && inactivityUnit
          ? `${inactivityValue}-${inactivityUnit}`
          : null,
    };

    localStorage.setItem("formSelections", JSON.stringify(formData));
  }

  // Function to restore form selections
  function restoreFormSelections() {
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );

    if (savedFormData.checkinInterval) {
      const [value, unit] = savedFormData.checkinInterval.split("-");
      const checkinValueInput = document.getElementById("checkin-value");
      const checkinUnitInput = document.getElementById("checkin-unit");
      if (checkinValueInput && value) checkinValueInput.value = value;
      if (checkinUnitInput && unit) checkinUnitInput.value = unit;
    }

    if (savedFormData.inactivityPeriod) {
      const [value, unit] = savedFormData.inactivityPeriod.split("-");
      const inactivityValueInput = document.getElementById("inactivity-value");
      const inactivityUnitInput = document.getElementById("inactivity-unit");
      if (inactivityValueInput && value) inactivityValueInput.value = value;
      if (inactivityUnitInput && unit) inactivityUnitInput.value = unit;
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
  // These two MUST be declared above the auth/init block below. On a page
  // reload that block calls updateButtonState() while the script body is
  // still executing, so a `let` declared further down is still in its
  // temporal dead zone: reading it throws, syncWithBackend() aborts, and
  // startCountdownTimers() never reaches the line that creates the 5s sync
  // interval — leaving the dashboard frozen until the next navigation.
  let currentButtonState = null;
  // False until the server has told us whether a switch is armed. Until
  // then the button stays disabled: offering "Deploy" on a switch that is
  // already running is the one wrong action this page can invite.
  let buttonStateResolved = false;
  let syncInterval = null;
  let visibilityHandlerBound = false;
  // True while an activate/deactivate request is in flight. The 5s sync
  // cannot know about a switch the server has not finished creating, so
  // without this it reports "not armed" mid-request and flips the button
  // back — the switch appears to arm, disarm, and arm again.
  let switchMutationInFlight = false;
  // Set once the server reports the switch has fired. Kept separate from
  // deadmanSwitchActivated (which means "armed and counting") so a fired
  // switch never renders as a dormant 00:00:00.
  let deadmanSwitchFired = false;
  // Deployed but not yet armed: the backend holds the switch with no
  // countdown until the operator completes the first check-in email.
  let deadmanSwitchPending = false;

  // Function to get interval in milliseconds based on user selection
  function getIntervalMs(intervalValue) {
    if (!intervalValue) return 2 * 60 * 60 * 1000; // Default to 2 hours

    const [value, unit] = intervalValue.split("-");
    const numValue = parseInt(value, 10);

    if (isNaN(numValue) || numValue < 1) return 2 * 60 * 60 * 1000;

    const multipliers = {
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
    };

    return numValue * (multipliers[unit] || multipliers.hours);
  }

  // Function to get inactivity period in milliseconds based on user selection
  function getInactivityMs(periodValue) {
    if (!periodValue) return 1 * 24 * 60 * 60 * 1000; // Default to 1 day

    const [value, unit] = periodValue.split("-");
    const numValue = parseInt(value, 10);

    if (isNaN(numValue) || numValue < 1) return 1 * 24 * 60 * 60 * 1000;

    const multipliers = {
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000,
    };

    return numValue * (multipliers[unit] || multipliers.days);
  }

  // Function to format time as DDD:HH:mm:ss for periods over 24 hours, or HH:mm:ss for shorter periods
  function formatTime(ms) {
    if (ms <= 0) return "00:00:00";

    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    // If less than 24 hours, show HH:mm:ss format
    if (days === 0) {
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

    // For 24+ hours, show DDD:HH:mm:ss format
    return `${days.toString().padStart(3, "0")}:${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  // Test timer formatting (can be removed after verification)
  console.log("🧪 Timer format tests:");
  console.log("2 hours:", formatTime(2 * 60 * 60 * 1000)); // Should show 02:00:00
  console.log("1 day:", formatTime(24 * 60 * 60 * 1000)); // Should show 001:00:00:00
  console.log("1 week:", formatTime(7 * 24 * 60 * 60 * 1000)); // Should show 007:00:00:00
  console.log("1 month:", formatTime(30 * 24 * 60 * 60 * 1000)); // Should show 030:00:00:00

  // Function to update countdown displays
  function updateCountdowns() {
    const now = new Date().getTime();

    // Update check-in countdown
    const checkinElement = document.getElementById("checkin-countdown");
    // While PENDING there is no countdown to describe — the caption has to
    // say what the operator must actually do, not label an empty timer.
    const checkinCaption = document.getElementById("checkin-caption");
    if (checkinCaption) {
      if (deadmanSwitchPending) {
        checkinCaption.textContent =
          "Click the link in the email you just received";
      } else if (deadmanSwitchFired) {
        checkinCaption.textContent = "Switch has fired — no longer checking in";
      } else {
        checkinCaption.textContent = "Time until next check-in email";
      }
    }
    if (checkinElement) {
      if (deadmanSwitchPending) {
        checkinElement.textContent = "PENDING";
      } else if (deadmanSwitchFired) {
        checkinElement.textContent = "CLOSED";
      } else if (!deadmanSwitchActivated || !nextCheckinTime) {
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
      if (deadmanSwitchPending) {
        deadmanElement.textContent = "NOT ARMED";
      } else if (deadmanSwitchFired) {
        // The switch fired. "00:00:00" reads like a timer at rest and is
        // exactly what made the activation state look like it disappeared.
        deadmanElement.textContent = "ACTIVATED";
        deadmanElement.className = "countdown deadman-activated";
      } else if (!deadmanSwitchActivated || !deadmanActivationTime) {
        deadmanElement.textContent = "00:00:00";
      } else {
        const timeLeft = deadmanActivationTime - now;
        deadmanElement.textContent = formatTime(timeLeft);

        if (timeLeft <= 0) {
          deadmanElement.textContent = "ACTIVATED";
          deadmanElement.className = "deadman-activated";
        }
      }
    }

    // Update last activity display
    const lastActivityElement = document.getElementById("last-activity");
    if (lastActivityElement) {
      if (deadmanSwitchPending) {
        lastActivityElement.textContent =
          "Awaiting your first check-in — click the link in the email just sent to you to arm the switch";
      } else if (!deadmanSwitchActivated) {
        lastActivityElement.textContent = "Not deployed";
      } else {
        lastActivityElement.textContent = formatUtcDateTime(lastActivityTime);
      }
    }
  }

  // Function to sync with backend timer status
  let sessionExpiredNotified = false;
  async function syncWithBackend() {
    if (switchMutationInFlight) return;
    try {
      const response = await fetch("/deadman/timer-status", {
        method: "GET",
        credentials: "include", // Include HTTP-only cookie
      });

      if (response.ok) {
        sessionExpiredNotified = false;
        const data = await response.json();

        if (data.active) {
          // Update frontend with backend data
          deadmanSwitchActivated = true;
          deadmanSwitchFired = false;
          hideActivationNotice();
          deadmanSwitchPending = !!data.pending;
          lastActivityTime = new Date(data.lastActivity);

          // Use absolute timestamps from backend data
          nextCheckinTime = data.nextCheckin;
          deadmanActivationTime = data.deadmanActivation;

          // Update localStorage to keep in sync
          localStorage.setItem("deadmanSwitchActivated", "true");
          localStorage.setItem("lastActivity", data.lastActivity);

          // Restore interval settings from the active switch so the form
          // shows the correct values even after Tor Browser clears localStorage
          if (data.settings) {
            const formData = {
              checkinMethod: "email",
              checkinInterval: data.settings.checkinInterval,
              inactivityPeriod: data.settings.inactivityPeriod,
            };
            localStorage.setItem("formSelections", JSON.stringify(formData));
            restoreFormSelections();
          }

          // Update button to show deactivate option
          updateButtonState("active");
        } else {
          // No active deadman switch on backend - check if it was triggered
          deadmanSwitchPending = false;
          await checkDeadmanStatus();
          // If deadman was triggered, we need to reload emails after localStorage clear
          if (!deadmanSwitchActivated) {
            loadEmails();
          }
        }
      } else if (response.status === 401 || response.status === 403) {
        // The JWT expired (24h). Without this, the page silently keeps
        // rendering stale local countdowns while every sync fails — the
        // switch itself is still running server-side, but the display is
        // dead data. Send the user back to the login page and say why.
        if (!sessionExpiredNotified) {
          sessionExpiredNotified = true;
          setupPage.style.display = "none";
          loginPage.style.display = "block";
          alert(
            "Your login session has expired, so the timer display is no longer live. " +
              "Your deadman switch is still running on the server — log in again to see current status.",
          );
        }
      } else {
        const errorText = await response.text();
        setButtonUnknown();
      }
    } catch (error) {
      setButtonUnknown();
    }
  }

  // Function to calculate next check-in time
  function calculateNextCheckin() {
    const savedFormData = JSON.parse(
      localStorage.getItem("formSelections") || "{}",
    );

    if (savedFormData.checkinInterval) {
      const intervalMs = getIntervalMs(savedFormData.checkinInterval);
      nextCheckinTime = lastActivityTime.getTime() + intervalMs;
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
    // (never for a pending switch — it genuinely has no countdown yet)
    if (
      deadmanSwitchActivated &&
      !deadmanSwitchPending &&
      (!nextCheckinTime || !deadmanActivationTime)
    ) {
      calculateNextCheckin();
      calculateDeadmanActivation();
    }

    // Update display immediately
    updateCountdowns();

    // Start updating every second
    checkinInterval = setInterval(updateCountdowns, 1000);

    // Sync with backend every 5 seconds to stay current.
    //
    // This interval used to be created without being stored, so it could
    // never be cleared — and startCountdownTimers() runs on login AND after
    // activation, so the loops accumulated. Each extra loop is another
    // request every 5s over Tor, and another writer racing to set the
    // button's state.
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(syncWithBackend, 5000);

    // Sync immediately when page becomes visible (user returns from
    // check-in). Registered once — re-adding it per call stacked duplicate
    // listeners the same way.
    if (!visibilityHandlerBound) {
      visibilityHandlerBound = true;
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
          syncWithBackend();
        }
      });
    }
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
      await fetch("/deadman/activity", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // Include HTTP-only cookie
        body: JSON.stringify({
          lastActivity: lastActivityTime.toISOString(),
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

  // Check if the user is already logged in by trying to access a protected endpoint
  try {
    const response = await fetch("/deadman/status", {
      method: "GET",
      credentials: "include", // Include HTTP-only cookie
    });

    if (response.ok) {
      // User is logged in
      loginPage.style.display = "none";
      setupPage.style.display = "block";
      // Load emails from backend (source of truth; localStorage clears on Tor Browser exit)
      await loadEmailsFromBackend();
      // Restore form selections from localStorage (overwritten by syncWithBackend if switch is active)
      restoreFormSelections();
      // Initialize countdown timers (syncWithBackend inside will restore interval settings if active)
      loadSavedActivity();
      if (deadmanSwitchActivated) {
        // Check deadman status and update button accordingly
        await checkDeadmanStatus();
      }
      await startCountdownTimers();
    } else {
      // User is not logged in
      loginPage.style.display = "flex";
      setupPage.style.display = "none";
    }
  } catch (error) {
    // Error checking auth status, show login page
    loginPage.style.display = "flex";
    setupPage.style.display = "none";
  }

  // Value constraints for different units
  const unitConstraints = {
    minutes: { max: 60, name: "minutes" },
    hours: { max: 24, name: "hours" },
    days: { max: 365, name: "days" },
    weeks: { max: 52, name: "weeks" },
    months: { max: 12, name: "months" },
  };

  // Function to validate and enforce value constraints
  function validateTimeInput(inputElement, unitElement) {
    const value = parseInt(inputElement.value);
    const unit = unitElement.value;
    const constraint = unitConstraints[unit];

    // Update max attribute dynamically based on selected unit
    if (constraint) {
      inputElement.setAttribute("max", constraint.max);

      if (value > constraint.max) {
        alert(
          `Maximum value for ${constraint.name} is ${constraint.max}. Setting to maximum.`,
        );
        inputElement.value = constraint.max;
      }
    }

    if (value < 1) {
      alert("Minimum value is 1. Setting to minimum.");
      inputElement.value = 1;
    }
  }

  // Add event listeners for input validation
  const checkinValueInput = document.getElementById("checkin-value");
  const checkinUnitInput = document.getElementById("checkin-unit");
  const inactivityValueInput = document.getElementById("inactivity-value");
  const inactivityUnitInput = document.getElementById("inactivity-unit");

  if (checkinValueInput && checkinUnitInput) {
    // Initialize max attribute on page load
    validateTimeInput(checkinValueInput, checkinUnitInput);

    checkinValueInput.addEventListener("input", () => {
      validateTimeInput(checkinValueInput, checkinUnitInput);
    });
    checkinUnitInput.addEventListener("change", () => {
      validateTimeInput(checkinValueInput, checkinUnitInput);
    });
  }

  if (inactivityValueInput && inactivityUnitInput) {
    // Initialize max attribute on page load
    validateTimeInput(inactivityValueInput, inactivityUnitInput);

    inactivityValueInput.addEventListener("input", () => {
      validateTimeInput(inactivityValueInput, inactivityUnitInput);
    });
    inactivityUnitInput.addEventListener("change", () => {
      validateTimeInput(inactivityValueInput, inactivityUnitInput);
    });
  }

  // Add event listeners to save form selections when they change
  document.addEventListener("change", async (event) => {
    if (
      event.target.matches(
        'input[name="checkin-method"], #checkin-value, #checkin-unit, #inactivity-value, #inactivity-unit',
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

      // Get current backend emails
      const password = localStorage.getItem("userPassword");
      const getResponse = await fetch(
        `/deadman/emails?password=${encodeURIComponent(password)}`,
        {
          method: "GET",
          credentials: "include", // Include HTTP-only cookie
        },
      );

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
            const password = localStorage.getItem("userPassword");
            const syncResponse = await fetch("/deadman/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              credentials: "include", // Include HTTP-only cookie
              body: JSON.stringify({
                emailAddress: email.address,
                emailContent: email.content,
                emailIndex: null, // Add as new
                password: password,
              }),
            });

            if (!syncResponse.ok) {
            }
          }
        }
      }
    } catch (error) {}
  }

  // Add comprehensive activity tracking
  const activityEvents = ["click", "keypress", "scroll", "mousemove"];
  // Function to check if deadman switch was triggered
  async function checkDeadmanStatus() {
    try {
      const response = await fetch("/deadman/deadman-status", {
        method: "GET",
        credentials: "include", // Include HTTP-only cookie
      });

      if (response.ok) {
        const data = await response.json();
        if (data.triggered) {
          // Deadman was triggered — clear switch state but keep email config
          deadmanSwitchActivated = false;
          deadmanSwitchFired = true;
          showActivationNotice(data);
          localStorage.removeItem("deadmanSwitchActivated");
          localStorage.removeItem("lastActivity");
          localStorage.removeItem("formSelections");
          // Do NOT clear localStorage.emails here — the user's email list is
          // config data, not switch state.  Wiping it on every sync cycle
          // prevented re-arming after a trigger.  resetDeadmanData() handles
          // the explicit "start from scratch" case.

          updateButtonState("triggered");
        } else if (data.active) {
          // Armed and running. This endpoint answers a round trip before
          // /timer-status does, so resolving the button here is both
          // correct and faster — previously "not triggered" was misread as
          // "not armed", briefly painting a green Deploy over a live switch.
          deadmanSwitchActivated = true;
          deadmanSwitchFired = false;
          hideActivationNotice();
          localStorage.setItem("deadmanSwitchActivated", "true");
          updateButtonState("active");
        } else {
          // No deadman switch at all.
          deadmanSwitchActivated = false;
          deadmanSwitchFired = false;
          hideActivationNotice();
          localStorage.setItem("deadmanSwitchActivated", "false");
          updateButtonState("inactive");
        }
      }
    } catch (error) {}
  }

  // Function to update button state based on deadman status

  // Used when the state cannot be determined at all. Staying disabled and
  // saying so beats defaulting to Deploy, which would be a guess about the
  // one thing that must not be guessed.
  // Tor can stall rather than fail, leaving every fetch pending. Without
  // this the button would sit on "Checking…" indefinitely.
  setTimeout(() => setButtonUnknown(), 20000);

  function setButtonUnknown() {
    if (!saveSettingsButton || buttonStateResolved) return;
    saveSettingsButton.disabled = true;
    saveSettingsButton.textContent = "Status unavailable — reload to retry";
    saveSettingsButton.className = "";
  }

  // Busy state is presentational only: it never becomes currentButtonState,
  // so the real state is restored intact once the request settles.
  function setButtonBusy(label) {
    if (!saveSettingsButton) return;
    saveSettingsButton.disabled = true;
    saveSettingsButton.textContent = label;
  }

  function clearButtonBusy() {
    if (!saveSettingsButton) return;
    saveSettingsButton.disabled = false;
    const restore = currentButtonState;
    currentButtonState = null; // force the repaint we actually want
    updateButtonState(restore || "inactive");
  }

  function updateButtonState(state) {
    if (!saveSettingsButton) return;
    // Reaching here at all means the server has told us what the switch is
    // doing, so the button is safe to act on.
    buttonStateResolved = true;
    saveSettingsButton.disabled = false;
    // Rewriting the same state repaints the button for no reason; with more
    // than one writer that is visible as flicker.
    if (state === currentButtonState) return;
    currentButtonState = state;

    switch (state) {
      case "active":
        saveSettingsButton.textContent = "Abort";
        saveSettingsButton.className = "active-state";
        saveSettingsButton.onclick = deactivateDeadmanSwitch;
        break;

      case "triggered":
        saveSettingsButton.textContent = "Re-arm Deadman Switch";
        saveSettingsButton.className = "";
        saveSettingsButton.onclick = activateDeadmanSwitch;
        break;

      case "inactive":
      default:
        saveSettingsButton.textContent =
          "Save Settings & Deploy Deadman Switch";
        saveSettingsButton.className = "";
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

    // Same race as deployment, mirrored: while the request is in flight the
    // server still reports an armed switch, so the sync would flip the
    // button back to Abort mid-abort.
    switchMutationInFlight = true;
    setButtonBusy("Aborting…");

    try {
      const response = await fetch("/deadman/deactivate", {
        method: "POST",
        credentials: "include", // Include HTTP-only cookie
      });

      if (response.ok) {
        alert("Deadman Switch deactivated successfully!");
        // Reset local state
        deadmanSwitchActivated = false;
        deadmanSwitchPending = false;
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
      alert("Failed to deactivate deadman switch");
    } finally {
      switchMutationInFlight = false;
      clearButtonBusy();
      syncWithBackend();
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
      alert("Failed to reset deadman data");
    }
  }

  // Activity should only be logged for:
  // 1. User logins (already handled)
  // 2. Check-in email link clicks (handled in backend)
});
