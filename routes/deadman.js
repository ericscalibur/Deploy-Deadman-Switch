const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const emailService = require("../utils/emailService");
const UserService = require("../database/userService");
const cryptoUtils = require("../database/crypto");
const {
  getIntervalMs,
  getInactivityMs,
  validateTimeInterval,
  getIntervalName,
  getInactivityName,
} = require("../utils/timeUtils");
const {
  effectiveWarningThreshold,
  warningPossible,
  warningAction,
  pingAction,
  DEFAULT_WARNING_MISSED_CHECKINS,
  DEFAULT_PING_INTERVAL_DAYS,
  DEFAULT_PING_ACK_GRACE_DAYS,
} = require("../utils/escalation");
const { notify, notifyThrottled } = require("../utils/notify");
const { createSerialQueue } = require("../utils/serialQueue");
const { hashCode, formatCode, generateCode } = require("../utils/codes");
const {
  isAutoReply,
  isBounce,
  fromAddress,
  visibleText,
  extractCodes,
  rawHeader,
} = require("../utils/inboundParser");
const inboundMail = require("../utils/inboundMail");

// Beneficiary escalation configuration (Issues #1/#2). Defaults follow the
// modification spec: warning after 5 consecutive check-in intervals of
// operator silence; liveness pings annually with a 30-day ack grace window.
const WARNING_MISSED_CHECKINS =
  parseInt(process.env.WARNING_MISSED_CHECKINS, 10) ||
  DEFAULT_WARNING_MISSED_CHECKINS;
// Millisecond-level overrides exist so the annual cycle can be exercised in
// minutes on a test install; the *_DAYS variables remain the production knobs.
const PING_INTERVAL_MS =
  parseInt(process.env.PING_INTERVAL_MS, 10) ||
  (parseInt(process.env.PING_INTERVAL_DAYS, 10) ||
    DEFAULT_PING_INTERVAL_DAYS) *
    24 * 60 * 60 * 1000;
const PING_ACK_GRACE_MS =
  parseInt(process.env.PING_ACK_GRACE_MS, 10) ||
  (parseInt(process.env.PING_ACK_GRACE_DAYS, 10) ||
    DEFAULT_PING_ACK_GRACE_DAYS) *
    24 * 60 * 60 * 1000;
const BENEFICIARY_SWEEP_INTERVAL_MS =
  parseInt(process.env.BENEFICIARY_SWEEP_INTERVAL_MS, 10) ||
  24 * 60 * 60 * 1000;

// Initialize database service
const userService = new UserService();

// Initialize database connection — block until ready, crash if it fails
let dbReady = false;
userService.connect().then(() => {
    dbReady = true;
}).catch(err => {
    console.error('Fatal: database connection failed:', err);
    process.exit(1);
});

// Reject requests until DB is connected
router.use((req, res, next) => {
    if (!dbReady) {
        return res.status(503).json({ error: 'Service starting, please retry in a moment' });
    }
    next();
});

// In-memory cache for active sessions (will be replaced by database queries)
const activeDeadmanSwitches = new Map();

// Reply-by-email (v2.2.0). Nothing token-like lives in memory any more: the
// code in each email IS the token and is persisted hashed (reply_codes).
// What does live here is bookkeeping that may safely be lost on restart.
//
// Reissues triggered by inbound mail (a stale code, five wrong guesses) are
// limited to one per hour per operator, so a spoofed From cannot be used to
// flood the operator with fresh check-in emails. Scheduled ticks are not
// subject to this.
// (Millisecond override exists so the sandbox E2E can exercise both reissue
// paths in one run; the hour is the production value.)
const REISSUE_MIN_GAP_MS =
  parseInt(process.env.REISSUE_MIN_GAP_MS, 10) || 60 * 60 * 1000;
const lastInboundReissueAt = new Map(); // userId -> ms
// Every receipt goes out at most once per live code (and per receipt type).
const receiptsSent = new Set(); // `${codeId}:${type}`
// Wrong guesses allowed against a live code before it is retired.
const MAX_FAILED_ATTEMPTS = 5;
// Fail-safe hold cap (spec "Fail-safe"): after this long without a readable
// inbox, normal timing resumes and the alert says so.
const INBOUND_HOLD_CAP_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_FIRE_RETRY_MS = 10 * 60 * 1000;
const INBOUND_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;
const lastInboundAlertAt = new Map(); // userEmail -> ms

// SQLite's CURRENT_TIMESTAMP writes "YYYY-MM-DD HH:MM:SS" in UTC with no
// timezone marker, which new Date() parses as LOCAL time — skewing recovered
// timers by the machine's UTC offset (e.g. check-ins scheduled 6 hours late
// at UTC-6). Bare SQLite timestamps are treated as UTC here; ISO strings
// (which carry a Z/offset) and epoch numbers pass through unchanged.
function parseDbTimestamp(value) {
  if (value === null || value === undefined) return new Date(NaN);
  if (typeof value === "number") return new Date(value);
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    return new Date(s.replace(" ", "T") + "Z");
  }
  return new Date(s);
}

// Recovery mechanism: Restore active switches from database on startup
async function recoverActiveDeadmanSwitches() {
  try {
    console.log(
      "🔄 RECOVERY: Checking for active deadman switches in database...",
    );

    const activeSessions = await userService.getAllRecoverableSessions();
    console.log(
      `🔍 RECOVERY: Found ${activeSessions.length} recoverable sessions in database`,
    );

    for (const session of activeSessions) {
      try {
        console.log(
          `🔄 RECOVERY: Restoring deadman switch for ${session.email}`,
        );

        // If this user already has a recovered in-memory switch, skip to avoid
        // creating duplicate timers (can happen when multiple DB sessions exist)
        if (activeDeadmanSwitches.has(session.email)) {
          console.log(
            `⚠️ RECOVERY: Skipping duplicate session for ${session.email} (already recovered)`,
          );
          await userService.markSessionTriggered(session.session_token);
          continue;
        }

        // Get user data to restore emails and settings
        const user = await userService.getUserById(session.user_id);
        if (!user) {
          console.error(
            `❌ RECOVERY: User not found for session ${session.session_token}`,
          );
          continue;
        }

        // For recovery, we need to get the user data, but we don't have the password
        // So we'll store essential info in the session and recover what we can
        const now = Date.now();
        const checkinIntervalMs = session.checkin_interval_ms;
        const inactivityMs = session.inactivity_timeout_ms;

        // Calculate remaining time based on last activity
        const lastActivity = parseDbTimestamp(session.last_activity).getTime();
        const deadmanExpiry = parseDbTimestamp(session.expires_at).getTime();
        const timeRemaining = deadmanExpiry - now;

        // A session with no deadline was never armed: the operator deployed
        // but has not completed the first check-in (or the server crashed
        // mid-activation, which leaves the same state). Restore the PENDING
        // switch — resume arming reminders, no countdown — rather than
        // treating epoch-0 as "expired" and firing spuriously, and rather
        // than silently forgetting the switch existed.
        if (!session.expires_at || Number.isNaN(deadmanExpiry)) {
          let pendingEmails = [];
          if (session.server_encrypted_emails) {
            try {
              pendingEmails = cryptoUtils.decryptEmailsWithServerKey(
                session.server_encrypted_emails,
              );
            } catch (decryptErr) {
              console.error(
                `❌ RECOVERY: Failed to decrypt envelope for pending switch of ${session.email}:`,
                decryptErr.message,
              );
            }
          }
          if (pendingEmails.length > 0) {
            userEmails.set(session.email, pendingEmails);
          }
          const pendingSwitch = {
            userEmail: session.email,
            userId: session.user_id,
            sessionToken: session.session_token,
            settings: {
              checkinInterval: getIntervalName(checkinIntervalMs),
              inactivityPeriod: getInactivityName(inactivityMs),
              emails: pendingEmails,
            },
            lastActivity: parseDbTimestamp(session.last_activity),
            checkinTimer: null,
            deadmanTimer: null,
            recovered: true,
          };
          startPendingReminders(
            session.email,
            pendingSwitch,
            checkinIntervalMs,
          );
          activeDeadmanSwitches.set(session.email, pendingSwitch);
          console.log(
            `⏳ RECOVERY: Restored PENDING switch for ${session.email} — awaiting first check-in, no countdown running`,
          );
          // Not a reminder: the operator has ignored nothing — the server
          // restarted and invalidated the outstanding link, so this resend
          // is the system's fault, not theirs. URGENT is reserved for
          // "you have been ignoring this"; spending it on a reboot is how
          // urgency markers stop meaning anything. Interval reminders from
          // startPendingReminders() still escalate normally.
          await sendArmingCheckin(session.email, pendingSwitch, false);
          continue;
        }

        // Recover the delivery envelope from the SECRET_KEY-encrypted copy.
        // This is what lets the switch fire unattended after a restart, without
        // the user's password (the password-encrypted copy is unreadable here).
        let recoveredEmails = [];
        if (session.server_encrypted_emails) {
          try {
            recoveredEmails = cryptoUtils.decryptEmailsWithServerKey(
              session.server_encrypted_emails,
            );
            console.log(
              `🔐 RECOVERY: Decrypted ${recoveredEmails.length} recipient(s) for ${session.email}`,
            );
          } catch (decryptErr) {
            console.error(
              `❌ RECOVERY: Failed to decrypt server envelope for ${session.email}:`,
              decryptErr.message,
            );
          }
        } else {
          console.warn(
            `⚠️ RECOVERY: No server-recoverable envelope stored for ${session.email} (switch predates this feature or was never re-armed)`,
          );
        }

        if (timeRemaining <= 0) {
          // The inactivity window already elapsed while the server was down.
          // Fire now instead of silently closing the switch.
          if (recoveredEmails.length > 0) {
            console.log(
              `🚨 RECOVERY: Session for ${session.email} expired while down — sending deadman emails now`,
            );
            userEmails.set(session.email, recoveredEmails);
            await executeDeadmanActivation(session.email, recoveredEmails, {
              sessionToken: session.session_token,
            });
          } else {
            console.error(
              `❌ RECOVERY: Session for ${session.email} expired but NO recipients could be recovered — alerting user, NOT closing switch`,
            );
            await alertUnrecoverableSwitch(session.email);
          }
          continue;
        }

        // Create switch data for recovery
        const switchData = {
          userEmail: session.email,
          userId: session.user_id,
          sessionToken: session.session_token,
          settings: {
            checkinInterval: getIntervalName(checkinIntervalMs),
            inactivityPeriod: getInactivityName(inactivityMs),
            emails: recoveredEmails,
          },
          lastActivity: parseDbTimestamp(session.last_activity),
          nextCheckin: lastActivity + checkinIntervalMs,
          deadmanActivation: deadmanExpiry,
          checkinTimer: null,
          deadmanTimer: null,
          recovered: true, // Flag to indicate this was recovered
          // Escalation state survives restarts (Issue #1/#2)
          missedCheckins: session.missed_checkins || 0,
          warningSentAt: session.warning_sent_at
            ? parseDbTimestamp(session.warning_sent_at)
            : null,
          warningAckAt: session.warning_ack_at
            ? parseDbTimestamp(session.warning_ack_at)
            : null,
          // last_activity is bumped at every check-in tick, so it doubles
          // as "when the last check-in email went out" — what the inbound
          // fail-safe compares the outage start against.
          lastCheckinSentAt: parseDbTimestamp(session.last_activity),
          lastCheckinVia: session.last_checkin_via || null,
          lastCheckinAt: session.last_checkin_at
            ? parseDbTimestamp(session.last_checkin_at)
            : null,
        };

        // Make recovered recipients available to the deadman trigger handler.
        if (recoveredEmails.length > 0) {
          userEmails.set(session.email, recoveredEmails);
        }

        // Set up check-in timer
        // Fire the first checkin at the correct absolute time (lastActivity + interval),
        // not from now — so a server restart doesn't reset the schedule.
        const timeUntilNextCheckin = Math.max(0, (lastActivity + checkinIntervalMs) - now);

        // Both timers, from the persisted absolute times — a restart must
        // not reset the schedule. The fire path is the shared one; the
        // inbound fail-safe hold applies to it like any other.
        startRecoveredTimers(session.email, switchData, checkinIntervalMs, timeUntilNextCheckin);

        // Store the recovered switch
        activeDeadmanSwitches.set(session.email, switchData);

        console.log(
          `✅ RECOVERY: Successfully restored deadman switch for ${session.email} (${timeRemaining / 1000 / 60} minutes remaining)`,
        );
      } catch (error) {
        console.error(
          `❌ RECOVERY: Failed to restore session for ${session.email}:`,
          error,
        );
      }
    }

    console.log(
      `✅ RECOVERY: Recovery complete, restored ${activeSessions.length} deadman switches`,
    );
  } catch (error) {
    console.error("❌ RECOVERY: Failed to recover active switches:", error);
  }
}

// Helper function for recovered deadman activation
// Notify the account owner that their switch reached expiry but the configured
// recipients could not be recovered (e.g. a switch created before the
// server-recoverable envelope existed). We deliberately do NOT close the switch
// so it keeps retrying/alerting rather than failing silently.
async function alertUnrecoverableSwitch(userEmail) {
  notifyThrottled(
    `unrecoverable:${userEmail}`,
    60 * 60 * 1000,
    `Switch for ${userEmail} reached its deadline but the recipient list could not be recovered — nothing was delivered. Log in to Deploy and re-arm the switch.`,
    { priority: "urgent", tags: "rotating_light,x" },
  );
  try {
    const subject = "WARNING: Your Deadman Switch could not deliver — action needed";
    const html = `
      <h2>⚠️ Deadman Switch delivery problem</h2>
      <p>Your Deploy Deadman Switch reached its inactivity deadline, but the
      server could not recover your configured recipient list to send the
      messages. This can happen if the switch was created before the
      restart-recovery feature, or if the server's SECRET_KEY changed.</p>
      <p><strong>Please log in to Deploy and re-activate your switch</strong> so
      your recipients are re-saved in a restart-recoverable form.</p>
      <p>The switch has NOT been closed; it will keep alerting until re-armed.</p>
      <p><small>This is an automated message from Deploy Deadman Switch.</small></p>
    `;
    await emailService.sendAlertEmail(userEmail, subject, html);
  } catch (error) {
    console.error(
      `❌ ALERT: Failed to send unrecoverable-switch alert to ${userEmail}:`,
      error,
    );
  }
}

// ---- Pending arming (verify the check-in loop before counting down) ----
//
// "No check-in received" and "operator is dead" are only the same thing if
// the check-in channel is known to work. A newly deployed switch therefore
// holds in PENDING: the first check-in email goes out immediately, and no
// countdown exists until the operator completes it — proving email delivery,
// link reachability (Tor included), and token handling end to end. A pending
// switch cannot fire, cannot escalate, and re-sends its arming email every
// check-in interval until answered.
//
// Persistence: a pending session is simply an active session whose
// expires_at is NULL (no deadline was ever set). This is backward
// compatible — every previously armed session has expires_at, and the old
// recovery behavior for NULL ("never fully activated, skip") is replaced by
// restoring the pending state.

async function sendArmingCheckin(userEmail, switchData, isReminder) {
  const sent = await issueCheckinEmail(userEmail, switchData, {
    arming: true,
    reminder: isReminder,
  });
  if (!sent) {
    console.error(
      `❌ PENDING: Arming check-in email to ${userEmail} could not be sent — switch stays pending`,
    );
  }
  return sent;
}

// Every check-in email — arming, reminder, periodic, recovered, reissued —
// goes through here: mint a code (retiring the previous one for this
// switch), remember when it went out, send it. The code is persisted hashed
// before the email exists, so a reply that beats the SMTP round trip still
// finds it.
async function issueCheckinEmail(
  userEmail,
  switchData,
  { arming = false, reminder = false, missedCheckins = 0, upgrade = false } = {},
) {
  let code;
  try {
    ({ code } = await userService.issueCode({
      kind: arming ? "arming" : "checkin",
      userId: switchData.userId,
      recipientHash: hashEmail(userEmail),
      ref: switchData.sessionToken || null,
    }));
  } catch (error) {
    console.error(`❌ CODE: Could not issue a check-in code for ${userEmail}:`, error);
    notifyThrottled(
      `code-issue-failed:${userEmail}`,
      60 * 60 * 1000,
      `Could not create a check-in code for ${userEmail} (${error.message}) — no check-in email was sent.`,
      { priority: "urgent", tags: "rotating_light,x" },
    );
    return false;
  }
  switchData.lastCheckinSentAt = new Date();
  return emailService.sendCheckinEmail(userEmail, code, missedCheckins, {
    arming,
    reminder,
    upgrade,
  });
}

// Retire every operator-side code (arming, check-in, warning-ack) — used
// whenever a switch stops existing: deactivation, fire, reset, re-deploy.
function retireOperatorCodes(userId, why) {
  if (!userId) return Promise.resolve(0);
  return userService
    .retireCodes({ userId, kinds: ["arming", "checkin", "warning-ack"] })
    .then((n) => {
      if (n) console.log(`🔒 CODE: Retired ${n} live code(s) for user ${userId} (${why})`);
      return n;
    })
    .catch((error) => {
      console.error(`❌ CODE: Failed to retire codes for user ${userId}:`, error);
      return 0;
    });
}

// The reminder interval reuses switchData.checkinTimer so every existing
// teardown path (deactivate, fire, debug clears) stops it without changes.
function startPendingReminders(userEmail, switchData, checkinIntervalMs) {
  switchData.pending = true;
  switchData.nextCheckin = null;
  switchData.deadmanActivation = null;
  switchData.deadmanTimer = null;

  switchData.checkinTimer = setInterval(async () => {
    try {
      const current = activeDeadmanSwitches.get(userEmail);
      if (!current || !current.pending) {
        clearInterval(switchData.checkinTimer);
        return;
      }
      console.log(
        `⏳ PENDING: ${userEmail} has not completed the arming check-in — re-sending`,
      );
      await sendArmingCheckin(userEmail, switchData, true);
      notifyThrottled(
        `pending-unarmed:${userEmail}`,
        Math.max(checkinIntervalMs, 60 * 60 * 1000),
        `Switch for ${userEmail} is deployed but still NOT armed — the first check-in has not been completed. No countdown is running.`,
        { priority: "high", tags: "warning,hourglass" },
      );
    } catch (error) {
      console.error(
        `❌ PENDING: Reminder cycle failed for ${userEmail}:`,
        error,
      );
    }
  }, checkinIntervalMs);
}

// ---- Beneficiary escalation (Issues #1/#2) ----

function getRecipientsFor(userEmail, switchData) {
  return (
    userEmails.get(userEmail) ||
    (switchData && switchData.settings && switchData.settings.emails) ||
    []
  );
}

// Keep an armed switch's recipient list in step with edits made after
// deployment. Without this, /emails edits only change the encrypted user
// data while the armed switch keeps firing at its activation-time snapshot —
// beneficiaries added later are silently excluded, and removed ones still
// receive the trigger email (with the encrypted payload in it).
// Updates every place the fire paths read: the in-memory map, the switch
// settings, and the SECRET_KEY-encrypted envelope that post-restart
// recovery fires from. Returns true if an armed switch was updated.
async function syncActiveSwitchRecipients(userEmail, emails) {
  const switchData = activeDeadmanSwitches.get(userEmail);
  if (!switchData) return false;

  // Snapshot the previous list BEFORE overwriting it, so we can tell which
  // addresses are genuinely new. Only those get a forced contact attempt —
  // editing one recipient must not re-mail everyone else on the switch.
  const previousAddresses = new Set(
    getRecipientsFor(userEmail, switchData)
      .map((e) => String(e.to || e.address || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const addedAddresses = new Set(
    emails
      .map((e) => String(e.to || e.address || "").trim().toLowerCase())
      .filter((a) => a && !previousAddresses.has(a)),
  );

  userEmails.set(userEmail, emails);
  if (switchData.settings) switchData.settings.emails = emails;

  if (switchData.sessionToken) {
    try {
      const serverBlob = cryptoUtils.encryptEmailsWithServerKey(emails);
      await userService.saveServerRecoverableEmails(
        switchData.sessionToken,
        serverBlob,
      );
      console.log(
        `🔐 SYNC: Server-recoverable envelope refreshed for ${userEmail} (${emails.length} recipients)`,
      );
    } catch (error) {
      console.error(
        `❌ SYNC: Failed to refresh server-recoverable envelope for ${userEmail}:`,
        error,
      );
    }
  }

  console.log(
    `🔄 SYNC: Armed switch recipients updated for ${userEmail} (${emails.length} recipients)`,
  );

  // A beneficiary added to an ARMED switch gets first contact immediately;
  // pingAction() skips everyone already verified. A pending switch contacts
  // nobody — same reason activation does not: it may never arm.
  if (!switchData.pending) {
    queueBeneficiaryPings(switchData.userId, userEmail, emails, addedAddresses).catch(
      (error) =>
        console.error(
          `❌ PING: First-contact pass after recipient edit failed for ${userEmail}:`,
          error,
        ),
    );
  }

  return true;
}

// Beneficiary addresses are only ever persisted as SHA-256 hashes
// (beneficiary_pings table) so liveness tracking doesn't weaken the
// encrypted-at-rest guarantee.
function hashEmail(address) {
  return crypto
    .createHash("sha256")
    .update(String(address).trim().toLowerCase())
    .digest("hex");
}

// Send (or, while unacknowledged, re-send) the pre-fire warning to every
// configured recipient. Notification only — no ciphertext, no payload, no
// instructions beyond "try to reach the operator and confirm receipt".
async function sendPreFireWarning(userEmail, switchData) {
  try {
    // Recipients who opted out of contact checks were promised no contact
    // at all before the trigger — the warning is contact, so they skip it
    // too. The CRITICAL email itself is never filtered by this flag.
    const recipients = getRecipientsFor(userEmail, switchData).filter(
      (r) => r.contactChecks !== false,
    );
    if (recipients.length === 0) {
      console.warn(
        `⚠️ PRE-FIRE WARNING: No warn-able recipients for ${userEmail} (none, or all opted out of pre-trigger contact) — skipping warning`,
      );
      return;
    }

    const isResend = !!switchData.warningSentAt;
    const daysRemaining = Math.max(
      0,
      Math.round((switchData.deadmanActivation - Date.now()) / 86400000),
    );

    for (const recipient of recipients) {
      const addr = recipient.to || recipient.address;
      if (!addr) continue;
      await sendWarningTo(userEmail, switchData, addr, isResend);
    }

    switchData.warningSentAt = switchData.warningSentAt || new Date();
    if (switchData.sessionToken) {
      await userService.setWarningSent(switchData.sessionToken);
    }
    console.log(
      `🔶 PRE-FIRE WARNING: ${isResend ? "Re-sent" : "Sent"} to ${recipients.length} recipient(s) for ${userEmail} (~${daysRemaining} days to fire)`,
    );
    if (!isResend) {
      notify(
        `Pre-fire warning sent to your ${recipients.length} recipient(s) — ${userEmail} has missed ${switchData.missedCheckins} check-ins, ~${daysRemaining} days until the switch fires. Check in NOW if you are alive.`,
        { priority: "urgent", tags: "rotating_light,hourglass" },
      );
    }
  } catch (error) {
    console.error(
      `❌ PRE-FIRE WARNING: Failed to send for ${userEmail}:`,
      error,
    );
  }
}

// One warning email to one recipient, with its own reply code (kind
// warning-ack, keyed by session + recipient). Each send mints a fresh code
// and retires that recipient's previous one; the first ack from any
// recipient stops the resends for the whole switch, as before.
async function sendWarningTo(userEmail, switchData, addr, isResend) {
  const daysRemaining = Math.max(
    0,
    Math.round((switchData.deadmanActivation - Date.now()) / 86400000),
  );
  let code;
  try {
    ({ code } = await userService.issueCode({
      kind: "warning-ack",
      userId: switchData.userId,
      recipientHash: hashEmail(addr),
      ref: switchData.sessionToken || null,
    }));
  } catch (error) {
    console.error(`❌ CODE: Could not issue a warning-ack code for ${userEmail}'s recipient:`, error);
    return false;
  }
  return emailService.sendBeneficiaryWarning(
    addr,
    userEmail,
    daysRemaining,
    code,
    isResend,
  );
}

// Called on every periodic check-in tick, BEFORE the operator's check-in
// email goes out. The tick itself proves one full interval elapsed with no
// check-in, so the counter increments here; when it reaches the threshold
// the beneficiaries are warned. Escalation is deliberately independent of
// whether operator-side email delivery is succeeding (spec requirement).
async function registerMissedCheckin(userEmail, switchData) {
  switchData.missedCheckins = (switchData.missedCheckins || 0) + 1;

  if (switchData.sessionToken) {
    try {
      await userService.setMissedCheckins(
        switchData.sessionToken,
        switchData.missedCheckins,
      );
    } catch (error) {
      console.error(
        `❌ ESCALATION: Failed to persist missed count for ${userEmail}:`,
        error,
      );
    }
  }

  // The configured threshold is clamped to the number of check-in ticks that
  // actually fit inside this switch's inactivity period, so a short deadline
  // (or a compressed test run) still gets a warning before the fire.
  const warningThreshold = effectiveWarningThreshold({
    threshold: WARNING_MISSED_CHECKINS,
    checkinIntervalMs: getIntervalMs(switchData.settings?.checkinInterval),
    inactivityMs: getInactivityMs(switchData.settings?.inactivityPeriod),
  });

  // Out-of-band nudge from the second consecutive miss: one missed interval
  // is normal latency, two starts to look like the operator isn't receiving
  // check-ins at all — exactly the condition email cannot report on itself.
  if (switchData.missedCheckins >= 2) {
    const remaining = switchData.deadmanActivation
      ? Math.max(0, Math.round((switchData.deadmanActivation - Date.now()) / 3600000))
      : null;
    notify(
      `${userEmail} has missed ${switchData.missedCheckins} consecutive check-ins` +
        (remaining !== null ? ` — about ${remaining}h until the switch fires.` : ".") +
        " If you are seeing this and are fine, check in now.",
      {
        priority:
          switchData.missedCheckins >= warningThreshold ? "urgent" : "high",
        tags: "warning,hourglass",
      },
    );
  }

  const action = warningAction({
    missedCheckins: switchData.missedCheckins,
    threshold: warningThreshold,
    warningAckAt: switchData.warningAckAt,
  });
  if (action === "send") {
    // Fail-safe: while Deploy knows it cannot read its own inbox, the
    // operator's replies are going unseen. The miss is still counted (the
    // operator has other duties: the dashboard button works), but no human
    // is told "the operator has stopped responding" on the strength of it.
    const hold = inboundHold(switchData);
    if (hold.held) {
      console.warn(
        `⏸️ PRE-FIRE WARNING HELD for ${userEmail}: inbound mail down since ${hold.downSince} — warning not sent`,
      );
      maybeSendInboundDownAlert(userEmail, switchData, hold);
    } else {
      await sendPreFireWarning(userEmail, switchData);
    }
  } else if (inboundHold(switchData).held) {
    maybeSendInboundDownAlert(userEmail, switchData, inboundHold(switchData));
  }

  return switchData.missedCheckins;
}

// ---- Inbound fail-safe (spec "Fail-safe") ----
//
// If Deploy cannot read mail, a living operator cannot check in remotely.
// While the inbound connection has been down continuously since before the
// last check-in email went out, the pre-fire warning and the fire are held
// (the miss is still counted). The hold is capped at INBOUND_HOLD_CAP_MS;
// after that normal timing resumes and the alert says so. Only a CONFIGURED
// connection that is failing holds anything: an install with no IMAP at all
// keeps its normal timing (red banner + alert email only), so an upgrade
// never tears down or silently freezes an armed switch.
function inboundHold(switchData) {
  const st = inboundMail.getState();
  if (!st.enabled || !st.configured || !st.downSince) return { held: false };
  const downSince = new Date(st.downSince).getTime();
  const lastSent = switchData && switchData.lastCheckinSentAt
    ? new Date(switchData.lastCheckinSentAt).getTime()
    : 0;
  if (!(downSince < lastSent)) return { held: false, reason: "outage-after-last-email", downSince: st.downSince };
  if (Date.now() - downSince >= INBOUND_HOLD_CAP_MS) {
    return { held: false, capExpired: true, downSince: st.downSince };
  }
  return { held: true, downSince: st.downSince };
}

// Email first, ntfy in addition; at most once per operator per 24 h.
function maybeSendInboundDownAlert(userEmail, switchData, hold = {}) {
  const last = lastInboundAlertAt.get(userEmail) || 0;
  if (Date.now() - last < INBOUND_ALERT_REPEAT_MS) return false;
  lastInboundAlertAt.set(userEmail, Date.now());
  const st = inboundMail.getState();
  const notConfigured = !!(st.enabled && !st.configured);
  emailService
    .sendInboundDownAlert(userEmail, hold.downSince || st.downSince, {
      notConfigured,
      capExpired: !!hold.capExpired,
      error: st.error,
    })
    .catch((error) =>
      console.error(`❌ ALERT: inbound-down alert to ${userEmail} failed:`, error),
    );
  notify(
    notConfigured
      ? `Deploy has no IMAP settings, so replies to ${userEmail}'s check-in emails cannot be received. Configure IMAP, or abort the switch from the dashboard.`
      : `Deploy cannot read its mailbox (since ${hold.downSince || st.downSince}). ${userEmail}'s replies are NOT being received${hold.capExpired ? " — the 7-day safety hold has run out and normal timing has resumed" : " — the warning and the fire are held for up to 7 days"}. Fix the IMAP settings, or abort the switch from the dashboard.`,
    { priority: "urgent", tags: "rotating_light,mailbox" },
  );
  return true;
}

// Every 10 minutes: any armed or pending switch whose operator cannot be
// heard by reply gets the daily alert, independent of check-in ticks (which
// may be weeks apart).
async function inboundHealthSweep() {
  try {
    const st = inboundMail.getState();
    if (!st.enabled) return;
    for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
      if (!st.configured) {
        maybeSendInboundDownAlert(userEmail, switchData, {});
      } else if (st.downSince) {
        const hold = inboundHold(switchData);
        maybeSendInboundDownAlert(userEmail, switchData, hold.downSince ? hold : { downSince: st.downSince });
      }
    }
  } catch (error) {
    console.error("❌ INBOUND SWEEP: failed:", error);
  }
}
setInterval(inboundHealthSweep, INBOUND_FIRE_RETRY_MS);

// Operator proved they're alive (check-in or manual re-arm): zero the
// counter, clear warning state, and stand the beneficiaries down if a
// warning had already gone out — never leave a human expecting a fire that
// isn't coming.
async function resetEscalationState(userEmail, switchData) {
  const hadWarning = !!switchData.warningSentAt;

  switchData.missedCheckins = 0;
  switchData.warningSentAt = null;
  switchData.warningAckAt = null;

  if (switchData.sessionToken) {
    try {
      await userService.clearWarningState(switchData.sessionToken);
      // Outstanding warning codes belong to a lapse that is now over.
      await userService.retireCodes({
        userId: switchData.userId,
        kind: "warning-ack",
        ref: switchData.sessionToken,
      });
    } catch (error) {
      console.error(
        `❌ ESCALATION: Failed to clear warning state for ${userEmail}:`,
        error,
      );
    }
  }

  if (hadWarning) {
    const recipients = getRecipientsFor(userEmail, switchData);
    for (const recipient of recipients) {
      const addr = recipient.to || recipient.address;
      if (!addr) continue;
      emailService
        .sendBeneficiaryStandDown(addr, userEmail)
        .catch((error) =>
          console.error(
            `❌ ESCALATION: Stand-down notice to ${addr} failed:`,
            error,
          ),
        );
    }
    console.log(
      `🔷 ESCALATION: ${userEmail} checked in after a warning — stand-down sent to ${recipients.length} recipient(s)`,
    );
  }
}

// Daily sweep for the annual beneficiary liveness ping (Issue #2). Uses the
// SECRET_KEY-encrypted delivery envelope, so it works unattended for every
// armed switch. If a ping goes unanswered past the grace window, the
// OPERATOR is alerted — while they are still around to fix the address.
async function runBeneficiaryPingSweep() {
  try {
    const sessions = await userService.getAllRecoverableSessions();
    for (const session of sessions) {
      if (!session.server_encrypted_emails) continue;

      // A pending switch is an active row with no deadline. It has not
      // armed, so it must not contact anyone — otherwise a switch left
      // un-armed overnight would be pinged by this sweep instead.
      if (!session.expires_at) continue;

      let recipients;
      try {
        recipients = cryptoUtils.decryptEmailsWithServerKey(
          session.server_encrypted_emails,
        );
      } catch (error) {
        console.error(
          `❌ PING SWEEP: Cannot decrypt envelope for ${session.email}:`,
          error.message,
        );
        continue;
      }

      await queueBeneficiaryPings(session.user_id, session.email, recipients);
    }
  } catch (error) {
    console.error("❌ PING SWEEP: Sweep failed:", error);
  }
}

// One ping pass at a time per operator.
//
// pingAction() is idempotent only against *committed* state: it decides
// "send" whenever the beneficiary_pings row is still absent. The row is not
// written until sendBeneficiaryPing() resolves, so two passes that overlap
// inside that window both read "never contacted" and both send. That window
// is easy to hit — every recipient edit kicks off a pass (fire-and-forget),
// so two quick edits, or an edit landing while the daily sweep runs, mail
// the same person two or three copies of "you have been listed as a trusted
// contact". Beneficiaries are strangers to this system; duplicate unexplained
// mail is exactly what makes them dismiss it as spam, and the ack click is
// the only real confirmation an address is good.
//
// Serializing per operator closes the window: each pass now starts after the
// previous one has committed its rows, so it sees them and skips.
const pingQueue = createSerialQueue();

function queueBeneficiaryPings(userId, operatorEmail, recipients, force = false) {
  return pingQueue.run(userId, () =>
    processBeneficiaryPings(userId, operatorEmail, recipients, force),
  );
}

// Run the ping decision for every recipient of one operator. Called by the
// daily sweep, at activation (so first contact is established the moment a
// switch is armed, not up to a day later), and when recipients are edited on
// an armed switch (so a newly added beneficiary is contacted immediately).
// Always reached through queueBeneficiaryPings() — see the note above.
// `force` is either true (every recipient) or a Set of lowercased addresses.
//
// beneficiary_pings rows are keyed by (user_id, email_hash) and are never
// deleted — not when a switch fires, is deactivated, re-armed, or the
// recipient is removed. So an address that was contacted once and never
// clicked is stuck: pingAction() sees an unanswered ping and returns "none"
// forever, and after the grace window it alerts the operator once and then
// stays silent. Re-adding that person to a new switch with "send first
// contact" ticked would quietly do nothing.
//
// That throttle is right for the automated daily sweep — repeatedly mailing
// a dead inbox is noise into a void. It is wrong when the operator has just
// explicitly asked for contact by adding a recipient or arming a switch.
// Those paths force a fresh attempt; FORCE_MIN_GAP_MS stops rapid edits
// from turning that into repeated mail.
const FORCE_MIN_GAP_MS =
  parseInt(process.env.PING_FORCE_MIN_GAP_MS, 10) || 60 * 60 * 1000;

async function processBeneficiaryPings(
  userId,
  operatorEmail,
  recipients,
  force = false,
) {
  const shouldForce = (addr) =>
    force === true ||
    (force && force.has && force.has(String(addr).trim().toLowerCase()));

  const seen = new Set();
  for (const recipient of recipients) {
    const addr = recipient.to || recipient.address;
    if (!addr) continue;

    // Opted out of address confirmation. Nothing is sent to them until the
    // switch fires. Note this does NOT suppress the pre-fire warning: that
    // only goes out once the operator has been silent for months and is
    // probably dead, which is a different question from telling a living
    // person's beneficiary that they have been listed.
    if (recipient.contactChecks === false) continue;

    const emailHash = hashEmail(addr);
    if (seen.has(emailHash)) continue;
    seen.add(emailHash);

    const ping = await userService.getBeneficiaryPing(userId, emailHash);
    const pingSentMs =
      ping && ping.ping_sent_at
        ? parseDbTimestamp(ping.ping_sent_at).getTime()
        : null;
    const ackedMs =
      ping && ping.ack_at ? parseDbTimestamp(ping.ack_at).getTime() : null;

    let action = pingAction({
      now: Date.now(),
      pingSentAt:
        ping && ping.ping_sent_at
          ? parseDbTimestamp(ping.ping_sent_at).getTime()
          : null,
      ackAt:
        ping && ping.ack_at ? parseDbTimestamp(ping.ack_at).getTime() : null,
      operatorAlertedAt:
        ping && ping.operator_alerted_at
          ? parseDbTimestamp(ping.operator_alerted_at).getTime()
          : null,
      intervalMs: PING_INTERVAL_MS,
      graceMs: PING_ACK_GRACE_MS,
    });

    // The operator explicitly asked for this one. Override a stale
    // unanswered row, but never mail the same address twice in an hour.
    if (
      action !== "send" &&
      !ackedMs &&
      shouldForce(addr) &&
      (!pingSentMs || Date.now() - pingSentMs >= FORCE_MIN_GAP_MS)
    ) {
      console.log(
        `📮 PING: Operator-requested contact overrides stale unanswered ping for ${operatorEmail}'s recipient`,
      );
      action = "send";
    }

    if (action === "send") {
      // Introduce the system unless this address has actually confirmed
      // before. The renewal wording opens with "this is your once-a-year
      // verification", which assumes the reader already knows what Deploy
      // is — false for a never-acknowledged address, which may never have
      // seen the original. The annual-renewal path only runs after an ack,
      // so requiring one here costs nothing.
      const firstContact = !ping || !ackedMs;
      const sent = await sendPingTo(userId, operatorEmail, addr, firstContact);
      if (sent) {
        console.log(
          `📮 PING: ${firstContact ? "First-contact" : "Renewal"} ping sent for ${operatorEmail}'s recipient`,
        );
      }
    } else if (action === "alert-operator") {
      const graceDays = Math.round(PING_ACK_GRACE_MS / 86400000);
      const alerted = await emailService.sendAlertEmail(
        operatorEmail,
        "WARNING: a recipient address may be dead — action needed",
        `<h2>Recipient address unresponsive</h2>
         <p>One of your configured recipients has not confirmed the
         address check sent more than ${graceDays} days ago. If that address
         is no longer in use, your deadman switch could one day fire into a
         void — the exact failure this check exists to catch early.</p>
         <p><strong>Log in to Deploy, review your recipient list, and ask your
         recipients which of them did not get a verification email.</strong>
         (For privacy this alert does not name the address.)</p>`,
      );
      if (alerted) {
        await userService.markPingOperatorAlerted(ping.id);
        console.log(
          `🔶 PING: Operator ${operatorEmail} alerted about unresponsive recipient`,
        );
        notify(
          `A recipient of ${operatorEmail}'s switch has not answered the address check for over ${graceDays} days — that address may be dead. Review your recipient list in Deploy.`,
          { priority: "high", tags: "warning,mailbox_with_no_mail" },
        );
      }
    }
  }
}

// One ping email to one address, with its own reply code (kind ping-ack,
// ref = the beneficiary_pings row id). The row is created up front so the
// code can reference it, but ping_sent_at is only stamped once the send
// resolves — pingAction() still reads an unsent row as "never contacted",
// so the serial-queue idempotency is unchanged. A failed send retires the
// code it minted.
async function sendPingTo(userId, operatorEmail, addr, firstContact, { upgrade = false } = {}) {
  const emailHash = hashEmail(addr);
  const row = await userService.ensureBeneficiaryPingRow(userId, emailHash);
  const { id: codeId, code } = await userService.issueCode({
    kind: "ping-ack",
    userId,
    recipientHash: emailHash,
    ref: String(row.id),
  });
  const sent = await emailService.sendBeneficiaryPing(
    addr,
    operatorEmail,
    code,
    firstContact,
    { upgrade },
  );
  if (sent) {
    await userService.saveBeneficiaryPingSent(userId, emailHash);
  } else {
    await userService.retireCode(codeId).catch(() => {});
  }
  return sent;
}

// First sweep shortly after startup (after recovery re-arms switches), then
// daily. New installs therefore verify every beneficiary address immediately
// on arming rather than a year later.
setTimeout(runBeneficiaryPingSweep, 30000);
setInterval(runBeneficiaryPingSweep, BENEFICIARY_SWEEP_INTERVAL_MS);

// Deliver the deadman emails, closing the DB session ONLY on success (at
// least one recipient reached). On total failure — e.g. the network is not
// up yet when recovery fires right after boot — the session stays active so
// a later restart re-attempts via recovery, the owner is alerted once, and
// delivery retries every 10 minutes while the server stays up. Closing the
// session before delivery was confirmed could silently lose the switch's
// entire purpose on one SMTP hiccup.
const DEADMAN_RETRY_MS = 10 * 60 * 1000;
async function deliverDeadmanEmails(userEmail, emails, sessionToken, attempt = 1) {
  let sent = false;
  try {
    sent = await emailService.sendDeadmanEmails(userEmail, emails);
  } catch (error) {
    console.error(
      `❌ DEADMAN DELIVERY: Attempt ${attempt} errored for ${userEmail}:`,
      error,
    );
  }

  if (sent) {
    console.log(
      `✅ DEADMAN DELIVERY: Emails delivered for ${userEmail} (attempt ${attempt})`,
    );
    notify(
      `Deadman switch FIRED for ${userEmail} — trigger emails delivered to the recipients (attempt ${attempt}). The switch is now closed.`,
      { priority: "urgent", tags: "rotating_light,email" },
    );
    if (sessionToken) {
      try {
        await userService.markSessionTriggered(sessionToken, {
          emailsSent: emails.length,
        });
      } catch (error) {
        console.error(
          `❌ DEADMAN DELIVERY: Delivered but failed to close session for ${userEmail}:`,
          error,
        );
      }
    }
    return true;
  }

  console.error(
    `❌ DEADMAN DELIVERY: Attempt ${attempt} failed for ${userEmail} — session stays active, retrying in ${DEADMAN_RETRY_MS / 60000} minutes`,
  );
  notifyThrottled(
    `deadman-delivery-failed:${userEmail}`,
    60 * 60 * 1000,
    `Deadman switch for ${userEmail} FIRED but delivery FAILED (attempt ${attempt}) — no recipient has received the trigger email. Retrying every ${DEADMAN_RETRY_MS / 60000} minutes. Check the SMTP configuration.`,
    { priority: "urgent", tags: "rotating_light,x" },
  );
  if (attempt === 1) {
    try {
      await emailService.sendAlertEmail(
        userEmail,
        "WARNING: Your Deadman Switch fired but delivery failed — retrying",
        `<h2>⚠️ Deadman Switch delivery problem</h2>
         <p>Your switch reached its inactivity deadline and tried to send your
         messages, but no emails could be delivered (SMTP failure). The server
         will keep retrying every ${DEADMAN_RETRY_MS / 60000} minutes, and a
         restart will also retry. Check the server's email configuration.</p>`,
      );
    } catch (alertErr) {
      console.error(
        `❌ DEADMAN DELIVERY: Failure alert could not be sent to ${userEmail}:`,
        alertErr,
      );
    }
  }
  setTimeout(() => {
    deliverDeadmanEmails(userEmail, emails, sessionToken, attempt + 1);
  }, DEADMAN_RETRY_MS);
  return false;
}

// ---- Upgrade path to reply-by-email (v2.2.0) ----
//
// Runs once, on the first start after the upgrade (keyed by
// settings.migrated_reply_codes), after recovery has re-armed every switch
// and before the inbound reader starts. Every link email sent before the
// upgrade is dead: its token lived in memory (check-ins) or in columns
// nothing reads any more (ping_token, warning_ack_token).
//   (a) nothing to retire — link tokens were never persisted as codes;
//   (b) every ARMED switch gets a fresh check-in email carrying a code,
//       worded "Deploy was updated" so it is not mistaken for a fault. It
//       goes through issueCheckinEmail(), so the code is live, the reissue
//       stamp is set, and lastCheckinSentAt gives the fail-safe a correct
//       reference point on the first post-upgrade cycle. The missed
//       counter restarts at zero: whatever was missed before was missed
//       against emails that may never have been clickable;
//   (c) every beneficiary ping that was sent but never acknowledged is
//       re-sent with a code (else its dead link would age into a false
//       "address may be dead" alert), skipping opted-out recipients and
//       operators with no armed switch, serialized per operator with the
//       daily sweep;
//   (d) a switch whose operator has no working IMAP is left running
//       untouched — the red banner and the alert email are the only effect.
// Pending switches need nothing: recovery re-sends their arming email.
// Unacknowledged pre-fire warnings re-send with a code at the next tick.
async function runReplyCodeMigration() {
  try {
    if (await userService.getSetting("migrated_reply_codes")) return;
    console.log("🔁 UPGRADE: first start with reply-by-email — issuing coded emails");

    let operators = 0;
    for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
      if (switchData.pending) continue;
      try {
        switchData.missedCheckins = 0;
        if (switchData.sessionToken) {
          await userService.setMissedCheckins(switchData.sessionToken, 0);
        }
        reissueAllowed(switchData.userId); // stamp: this is the hour's reissue
        const sent = await issueCheckinEmail(userEmail, switchData, { upgrade: true });
        console.log(`🔁 UPGRADE: post-upgrade check-in email ${sent ? "sent" : "NOT sent"} to ${userEmail}`);
        operators++;
      } catch (error) {
        console.error(`❌ UPGRADE: check-in email for ${userEmail} failed:`, error);
      }
    }

    let pings = 0;
    const unanswered = await userService.getUnansweredBeneficiaryPings();
    for (const row of unanswered) {
      try {
        const user = await userService.getUserById(row.user_id);
        if (!user) continue;
        const switchData = activeDeadmanSwitches.get(user.email);
        if (!switchData || switchData.pending) continue; // only an armed switch may contact anyone
        const recipient = getRecipientsFor(user.email, switchData).find(
          (r) => hashEmail(r.to || r.address || "") === row.email_hash,
        );
        if (!recipient || recipient.contactChecks === false) continue;
        const addr = recipient.to || recipient.address;
        const sent = await pingQueue.run(row.user_id, () =>
          sendPingTo(row.user_id, user.email, addr, true, { upgrade: true }),
        );
        console.log(`🔁 UPGRADE: address-check email ${sent ? "re-sent" : "NOT sent"} with a code for ${user.email}'s recipient`);
        if (sent) pings++;
      } catch (error) {
        console.error(`❌ UPGRADE: re-sending ping row ${row.id} failed:`, error);
      }
    }

    await userService.setSetting("migrated_reply_codes", new Date().toISOString());
    console.log(`✅ UPGRADE: done — ${operators} operator check-in(s), ${pings} beneficiary ping(s) re-sent`);
  } catch (error) {
    console.error("❌ UPGRADE: migration failed (will retry on next start):", error);
  }
}

// Initialize recovery on startup with delay to ensure database is ready.
// The inbound mail reader starts only AFTER recovery (and the one-time
// upgrade pass): a reply that arrived during the restart must find its
// switch re-armed, or its code would be treated as belonging to a switch
// that no longer exists.
setTimeout(() => {
  recoverActiveDeadmanSwitches()
    .catch((error) => console.error("❌ RECOVERY: unexpected failure:", error))
    .then(() => runReplyCodeMigration())
    .finally(() => startInboundMail());
}, 2000);

// Periodic state saving for crash protection
const SAVE_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes
setInterval(async () => {
  try {
    for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
      try {
        // Pending switches are excluded: they have no deadline, and writing
        // one (epoch-0 from a null deadmanActivation) would both corrupt the
        // schedule and destroy the expires_at-IS-NULL pending marker.
        if (
          !switchData.recovered &&
          !switchData.pending &&
          switchData.userId
        ) {
          await userService.saveTimerState(switchData.userId, {
            nextCheckin: switchData.nextCheckin,
            deadmanActivation: switchData.deadmanActivation,
            lastActivity: switchData.lastActivity,
          });
        }
      } catch (error) {
        console.error(
          `❌ PERIODIC SAVE: Failed to save state for ${userEmail}:`,
          error,
        );
        notifyThrottled(
          "periodic-save-failed",
          60 * 60 * 1000,
          `Periodic timer-state save failed for ${userEmail}: ${error.message}. A restart could resume from stale state.`,
          { priority: "high", tags: "warning,floppy_disk" },
        );
      }
    }

  } catch (error) {
    console.error(
      "❌ PERIODIC SAVE: Critical error during periodic save:",
      error,
    );
  }
}, SAVE_INTERVAL);

// Middleware to verify JWT token and load user data
const authenticateToken = async (req, res, next) => {
  // Try to get token from HTTP-only cookie first, then fallback to Authorization header
  const token =
    req.cookies.token ||
    (req.headers["authorization"] &&
      req.headers["authorization"].split(" ")[1]);

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, process.env.SECRET_KEY, async (err, user) => {
    if (err) return res.sendStatus(403);

    try {
      // Get user data from database
      const userData = await userService.getUserById(user.userId);
      if (!userData) {
        return res.sendStatus(403);
      }

      req.user = {
        ...user,
        userData,
      };
      next();
    } catch (error) {
      console.error("Error loading user data:", error);
      return res.sendStatus(500);
    }
  });
};

// Simple test route
router.get("/test", (req, res) => {
  res.json({ message: "Minimal deadman routes working!" });
});

// User signup endpoint (encrypted database)
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Create new user with encrypted data
    const userData = await userService.createUser(email, password, {
      emails: [],
      settings: {},
      checkinTokens: {},
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: userData.userId, email: userData.email },
      process.env.SECRET_KEY,
      { expiresIn: "24h" },
    );

    // Log audit event
    await userService.logAudit(
      userData.userId,
      "USER_SIGNUP",
      "User account created",
      req.ip,
      req.get("User-Agent"),
    );

    // Set HTTP-only cookie instead of sending token in response
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: {
        id: userData.userId,
        email: userData.email,
      },
    });
  } catch (error) {
    console.error("Error creating user:", error);

    if (error.message === "User already exists") {
      return res.status(409).json({ message: "User already exists" });
    }

    res.status(500).json({ message: "Failed to create user" });
  }
});

// User logout endpoint
router.post("/logout", (req, res) => {
  // Clear the HTTP-only cookie
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });

  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

// User login endpoint (encrypted database)
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Authenticate user and get decrypted data
    const userData = await userService.authenticateUser(email, password);

    // Generate JWT token
    const token = jwt.sign(
      { userId: userData.userId, email: userData.email },
      process.env.SECRET_KEY,
      { expiresIn: "24h" },
    );

    // Log audit event
    await userService.logAudit(
      userData.userId,
      "USER_LOGIN",
      "User logged in",
      req.ip,
      req.get("User-Agent"),
    );

    // Set HTTP-only cookie instead of sending token in response
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      success: true,
      message: "Login successful",
      user: {
        id: userData.userId,
        email: userData.email,
        lastLogin: userData.lastLogin,
      },
    });
  } catch (error) {
    console.error("Error authenticating user:", error);

    if (error.message === "Invalid credentials") {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    res.status(500).json({ message: "Authentication failed" });
  }
});

// Legacy in-memory storage (being phased out for encrypted database)
const userEmails = new Map();
const deadmanActivationHistory = new Map();

// Emails endpoint - save/update email data (encrypted database)
router.post("/emails", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    const { emailAddress, emailContent, emailPayload, emailIndex, contactChecks } =
      req.body;

    // Get password from request (needed for decryption)
    const password = req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for encryption" });
    }

    // Refuse to store a recipient with no deliverable address — a switch
    // armed with an addressless email "fires" to nobody, and the failure
    // only surfaces at trigger time, when no one is left to notice.
    if (
      !emailAddress ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(emailAddress))
    ) {
      return res
        .status(400)
        .json({ message: "A valid recipient email address is required" });
    }

    // Get user's salt and current encrypted data
    const user = await userService.getUserById(userId);
    const currentData = await userService.getUserData(
      userId,
      password,
      user.salt,
    );

    let existingEmails = currentData.emails || [];

    const emailData = {
      address: emailAddress,
      content: emailContent,
      to: emailAddress,
      subject: "Important Message from " + userEmail,
      body: emailContent,
      // Whether this recipient is asked to confirm their address. Per
      // recipient, because the trade-off is: some beneficiaries can be told
      // they are listed, and some must learn nothing until the message
      // arrives. Only an explicit false disables it — anything else (absent,
      // undefined, a recipient saved before this option existed) means on.
      contactChecks: contactChecks !== false,
      ...(emailPayload && { payload: emailPayload }),
    };

    if (emailIndex !== null && emailIndex >= 0) {
      existingEmails[emailIndex] = emailData;
    } else {
      existingEmails.push(emailData);
    }

    // Update encrypted database
    await userService.updateUserData(userId, password, user.salt, {
      emails: existingEmails,
      settings: currentData.settings,
      checkinTokens: currentData.checkinTokens,
    });

    // Log audit event
    await userService.logAudit(
      userId,
      emailIndex !== null ? "EMAIL_UPDATED" : "EMAIL_ADDED",
      `Email ${emailIndex !== null ? "updated" : "added"}: ${emailAddress}`,
      req.ip,
      req.get("User-Agent"),
    );

    // If a switch is armed, propagate the edit to it immediately
    const activeSwitchUpdated = await syncActiveSwitchRecipients(
      userEmail,
      existingEmails,
    );

    res.json({
      success: true,
      message: "Email saved successfully",
      emailCount: existingEmails.length,
      activeSwitchUpdated,
    });
  } catch (error) {
    console.error("Error saving email:", error);
    res.status(500).json({ message: "Failed to save email" });
  }
});

// Get emails endpoint (encrypted database)
router.get("/emails", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get password from query params or body (needed for decryption)
    const password = req.query.password || req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for decryption" });
    }

    // Get user's salt and decrypt data
    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);

    const emails = userData.emails || [];

    res.json({
      success: true,
      emails: emails,
      syncInfo: {
        backendCount: emails.length,
        encrypted: true,
        needsSync: false,
      },
    });
  } catch (error) {
    console.error("Error getting emails:", error);
    res.status(500).json({ message: "Failed to get emails" });
  }
});

// The first-contact email exactly as a beneficiary would receive it, for the
// message editor to show before the operator decides whether to send it.
// Rendered from the same builder the sender uses, so the preview cannot
// drift from the real thing.
//
// The code here is inert: EXAM-PLE1 uses symbols outside the code alphabet
// (L, 1), so it can never match a live code. Minting a real one for a
// preview would create a live confirmation that nobody was ever sent,
// quietly marking an address verified that was never contacted.
router.get("/contact-template", authenticateToken, (req, res) => {
  try {
    const { subject, html } = emailService.buildBeneficiaryPingContent(
      req.user.email,
      "EXAM-PLE1",
      true,
    );
    res.json({ success: true, subject, html });
  } catch (error) {
    console.error("Error building contact template preview:", error);
    res.status(500).json({ message: "Failed to build contact template" });
  }
});

// Per-beneficiary contact status for the dashboard. Ping rows are keyed by
// SHA-256 of the address (plaintext never lands in beneficiary_pings), so
// the mapping back to readable addresses can only be made here, after
// decrypting the recipient list with the user's password. POST, not GET —
// the password must not ride in a URL.
router.post("/beneficiary-status", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const password = req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for decryption" });
    }

    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);
    const emails = userData.emails || [];

    const toIso = (dbValue) => {
      if (!dbValue) return null;
      const d = parseDbTimestamp(dbValue);
      return isNaN(d.getTime()) ? null : d.toISOString();
    };

    const beneficiaries = [];
    for (const email of emails) {
      const addr = email.to || email.address;
      if (!addr) continue;
      const ping = await userService.getBeneficiaryPing(
        userId,
        hashEmail(addr),
      );
      beneficiaries.push({
        address: addr,
        contactChecksEnabled: email.contactChecks !== false,
        pingSentAt: toIso(ping?.ping_sent_at),
        ackAt: toIso(ping?.ack_at),
        operatorAlertedAt: toIso(ping?.operator_alerted_at),
      });
    }

    res.json({ success: true, beneficiaries });
  } catch (error) {
    console.error("Error getting beneficiary status:", error);
    res.status(500).json({ message: "Failed to get beneficiary status" });
  }
});

// Delete email by index (encrypted database)
router.delete("/emails/:index", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const emailIndex = parseInt(req.params.index);

    // Get password from request body (needed for decryption)
    const password = req.body.password;
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for encryption" });
    }

    // Validate email index
    if (isNaN(emailIndex) || emailIndex < 0) {
      return res.status(400).json({ message: "Invalid email index" });
    }

    // Get user's salt and current encrypted data
    const user = await userService.getUserById(userId);
    const currentData = await userService.getUserData(
      userId,
      password,
      user.salt,
    );

    let existingEmails = currentData.emails || [];

    // Check if email index exists
    if (emailIndex >= existingEmails.length) {
      return res.status(404).json({ message: "Email not found" });
    }

    // Never let an armed switch end up with zero recipients — same rationale
    // as the activation guard: a switch that fires to nobody is worse than
    // one that refuses the edit.
    const userEmail = req.user.email;
    if (
      existingEmails.length === 1 &&
      activeDeadmanSwitches.has(userEmail)
    ) {
      return res.status(400).json({
        message:
          "Cannot delete the last recipient while the switch is armed — deactivate the switch first.",
      });
    }

    // Remove email at specified index
    existingEmails.splice(emailIndex, 1);

    // Update encrypted database
    await userService.updateUserData(userId, password, user.salt, {
      emails: existingEmails,
      settings: currentData.settings,
      checkinTokens: currentData.checkinTokens,
    });

    // Log audit event
    await userService.logAudit(
      userId,
      "EMAIL_DELETED",
      `Email deleted at index ${emailIndex}`,
      req.ip,
    );

    // If a switch is armed, the removed beneficiary must stop receiving
    // anything — propagate immediately
    const activeSwitchUpdated = await syncActiveSwitchRecipients(
      userEmail,
      existingEmails,
    );

    res.json({
      message: "Email deleted successfully",
      remainingCount: existingEmails.length,
      activeSwitchUpdated,
    });
  } catch (error) {
    console.error("Error deleting email:", error);
    res.status(500).json({ message: "Failed to delete email" });
  }
});

// Status endpoint to check if user is authenticated
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await userService.getUserById(userId);

    res.json({
      success: true,
      authenticated: true,
      user: {
        id: userId,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Error getting user status:", error);
    res.status(500).json({ message: "Failed to get user status" });
  }
});

// Timer status endpoint for countdown synchronization
router.get("/timer-status", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    let beneficiaryStamp = "";
    try {
      beneficiaryStamp = await userService.getBeneficiaryStamp(req.user.userId);
    } catch (_) {}

    // Check if deadman switch is active for this user
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      const now = Date.now();

      res.json({
        success: true,
        active: true,
        // Pending: deployed but not yet armed — nextCheckin/deadmanActivation
        // are null and no countdown exists until the first check-in completes.
        pending: !!switchData.pending,
        lastActivity: switchData.lastActivity,
        nextCheckin: switchData.nextCheckin,
        deadmanActivation: switchData.deadmanActivation,
        missedCheckins: switchData.missedCheckins || 0,
        warningSent: !!switchData.warningSentAt,
        warningAcknowledged: !!switchData.warningAckAt,
        // How the last check-in arrived: "reply" | "dashboard" | null.
        lastCheckinVia: switchData.lastCheckinVia || null,
        lastCheckinAt: switchData.lastCheckinAt || null,
        inbound: inboundStatus(),
        inboundHold: inboundHold(switchData).held,
        beneficiaryStamp,
        settings: {
          checkinInterval: switchData.settings.checkinInterval,
          inactivityPeriod: switchData.settings.inactivityPeriod,
        },
      });
    } else {
      res.json({
        success: true,
        active: false,
        inbound: inboundStatus(),
        beneficiaryStamp,
      });
    }
  } catch (error) {
    console.error("Error getting timer status:", error);
    res.status(500).json({ message: "Failed to get timer status" });
  }
});

// Activate deadman switch (encrypted database)
router.post("/activate", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    const { checkinInterval, inactivityPeriod, password } = req.body;
    const checkinMethod = req.body.checkinMethod || "email";

    // Never log req.body here — it contains the user's plaintext password.
    console.log(
      `🚀 ACTIVATION: Request from ${userEmail} (check-in ${checkinInterval}, inactivity ${inactivityPeriod})`,
    );

    // Password required for encryption/decryption
    if (!password) {
      console.log("❌ ACTIVATION: No password provided");
      return res
        .status(400)
        .json({ message: "Password required for encryption" });
    }

    // Refuse to arm a switch that cannot deliver email — a silently broken
    // SMTP transport would defeat the entire purpose of the switch.
    const emailReady = await emailService.ensureReady();
    if (!emailReady) {
      console.error(
        `❌ ACTIVATION: Email service is not working — refusing to activate switch for ${userEmail}`,
      );
      return res.status(503).json({
        message:
          "Email service is not working (SMTP login failed), so check-in and deadman emails cannot be sent. Fix EMAIL_USER/EMAIL_PASS in the server config (Gmail app passwords can be revoked) and try again. The switch was NOT activated.",
      });
    }

    // Refuse to deploy a switch whose replies could not be read. Remote
    // check-ins are by email reply only (v2.2.0); with no working IMAP the
    // operator can only ever check in from the dashboard, and the arming
    // dry run could not prove the loop. Same principle as the SMTP gate.
    // DEPLOY_TEST_HOOKS=1 (sandbox) injects replies directly and skips this.
    if (process.env.DEPLOY_TEST_HOOKS !== "1") {
      const inboundState = inboundMail.getState();
      if (!inboundState.enabled) {
        return res.status(400).json({
          message:
            "Reply-by-email is disabled (REPLY_BY_EMAIL=false), so nothing could ever answer a check-in email. Enable it and configure IMAP, then try again. The switch was NOT activated.",
        });
      }
      if (!inboundState.configured) {
        return res.status(400).json({
          message:
            "Incoming mail (IMAP) is not configured, so Deploy could not read your check-in replies. With the Gmail provider it is derived from the same app password (enable IMAP in Gmail settings); with a custom SMTP provider set IMAP_HOST/IMAP_USER/IMAP_PASS. The switch was NOT activated.",
        });
      }
      const imapOk = await inboundMail.ensureVerified();
      if (!imapOk) {
        console.error(
          `❌ ACTIVATION: IMAP login failed — refusing to activate switch for ${userEmail}`,
        );
        return res.status(503).json({
          message: `Incoming mail (IMAP) login failed (${inboundMail.lastVerifyError() || "unknown error"}), so your check-in replies could not be read. Fix the IMAP settings (Gmail: IMAP must be enabled under Settings → Forwarding and POP/IMAP; the app password must be current) and try again. The switch was NOT activated.`,
        });
      }
    }

    // Get user's salt and current encrypted data
    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);
    const emails = userData.emails || [];

    // Refuse to arm a switch with no deliverable recipient — same rationale
    // as the SMTP check above: a switch that fires to nobody is worse than
    // one that refuses to arm.
    if (!emails.some((e) => e.to || e.address)) {
      return res.status(400).json({
        message:
          "No recipient emails configured — add at least one beneficiary email before activating. The switch was NOT activated.",
      });
    }

    // Validate check-in interval
    const checkinValidation = validateTimeInterval(checkinInterval, false);
    if (!checkinValidation.isValid) {
      return res.status(400).json({
        message: `Invalid check-in interval: ${checkinValidation.error}`,
      });
    }

    // Validate inactivity period
    const inactivityValidation = validateTimeInterval(inactivityPeriod, true);
    if (!inactivityValidation.isValid) {
      return res.status(400).json({
        message: `Invalid inactivity period: ${inactivityValidation.error}`,
      });
    }

    // Calculate timer intervals
    const checkinIntervalMs = getIntervalMs(checkinInterval);
    const inactivityMs = getInactivityMs(inactivityPeriod);

    // Verify the calculations are correct
    if (checkinIntervalMs === 7200000) {
      console.warn(
        `⚠️ WARNING: Check-in interval defaulted to 2 hours! Original value was "${checkinInterval}"`,
      );
    }
    if (inactivityMs === 7200000) {
      console.warn(
        `⚠️ WARNING: Inactivity period defaulted to 2 hours! Original value was "${inactivityPeriod}"`,
      );
    }

    // Validate that inactivity period is greater than check-in interval
    if (inactivityMs <= checkinIntervalMs) {
      return res.status(400).json({
        message: "Inactivity period must be longer than check-in interval",
      });
    }

    // Clear any existing in-memory timers before creating a new activation
    if (activeDeadmanSwitches.has(userEmail)) {
      const existingSwitchData = activeDeadmanSwitches.get(userEmail);
      if (existingSwitchData.checkinTimer) clearInterval(existingSwitchData.checkinTimer);
      if (existingSwitchData.deadmanTimer) {
        clearTimeout(existingSwitchData.deadmanTimer);
        clearInterval(existingSwitchData.deadmanTimer);
      }
      activeDeadmanSwitches.delete(userEmail);
      console.log(`🔄 ACTIVATION: Cleared existing in-memory timers for ${userEmail}`);
    }

    // A new deployment supersedes any earlier fire — clear the persisted
    // record so a restart cannot resurrect the "switch has fired" banner over
    // a live switch.
    deadmanActivationHistory.delete(userEmail);
    try {
      await userService.clearTriggeredHistory(userId);
    } catch (error) {
      console.error(`❌ ACTIVATION: Could not clear fire record for ${userEmail}:`, error);
    }

    // Deactivate any existing DB sessions before creating a new one
    try {
      await userService.deactivateSession(userId);
      console.log(`🔄 ACTIVATION: Deactivated existing DB sessions for ${userEmail}`);
    } catch (err) {
      console.log(`🔄 ACTIVATION: No existing DB sessions to deactivate for ${userEmail}`);
    }
    // Codes from the previous switch (any state) must not act on this one.
    await retireOperatorCodes(userId, "re-deploy");

    // Create encrypted deadman session in database
    const sessionData = await userService.createDeadmanSession(userId, {
      checkinInterval: checkinIntervalMs,
      inactivityTimeout: inactivityMs,
    });

    // Store settings in encrypted user data
    const updatedSettings = {
      checkinMethod,
      checkinInterval,
      inactivityPeriod,
      sessionToken: sessionData.sessionToken,
    };

    await userService.updateUserData(userId, password, user.salt, {
      emails: emails,
      settings: updatedSettings,
      checkinTokens: userData.checkinTokens || {},
    });

    // Store the deadman switch data in memory. The switch starts PENDING:
    // no countdown exists until the operator completes the first check-in
    // (see the pending-arming section above) — deploying is the dry run
    // that proves the check-in loop before anything is allowed to fire.
    const switchData = {
      userEmail,
      userId,
      sessionToken: sessionData.sessionToken,
      settings: {
        checkinMethod,
        checkinInterval,
        inactivityPeriod,
        emails,
      },
      lastActivity: new Date(),
      pending: true,
      nextCheckin: null,
      deadmanActivation: null,
      checkinTimer: null,
      deadmanTimer: null,
    };

    console.log(`🔄 ACTIVATION: Switch created for ${userEmail} with ${emails.length} recipient(s)`);

    // No countdown timers yet — the switch holds in pending, re-sending the
    // arming email each interval. The real timers are created in performCheckin()
    // when the operator completes this first check-in (that handler already
    // rebuilds both timers from scratch on every check-in).
    startPendingReminders(userEmail, switchData, checkinIntervalMs);

    // Store the active switch
    activeDeadmanSwitches.set(userEmail, switchData);

    // Store emails in memory for deadman activation
    userEmails.set(userEmail, emails);

    // No timer-state save here: a pending session keeps expires_at NULL —
    // that IS the persisted pending marker. performCheckin() writes the first real
    // deadline when the switch arms.

    // Persist a SECRET_KEY-encrypted copy of the delivery envelope so the switch
    // can fire after a restart even without the user's password (see recovery).
    try {
      const serverBlob = cryptoUtils.encryptEmailsWithServerKey(emails);
      await userService.saveServerRecoverableEmails(
        sessionData.sessionToken,
        serverBlob,
      );
      console.log(
        `🔐 PERSISTENCE: Server-recoverable envelope saved for ${userEmail} (${emails.length} recipients)`,
      );
    } catch (error) {
      console.error(
        `❌ PERSISTENCE: Failed to save server-recoverable envelope for ${userEmail}:`,
        error,
      );
    }

    // No beneficiary contact here. Deploying only puts the switch in
    // PENDING — it is the dry run that proves the check-in loop, and the
    // operator may never complete it. Contacting beneficiaries at this
    // point tells third parties they are named in a switch that may never
    // exist, and that cannot be taken back. First contact happens when the
    // switch actually arms, in performCheckin().

    // Arming dry run: the first check-in email goes out right now. Awaited
    // so the response can say honestly whether it was sent — if it wasn't,
    // the switch still holds safely in pending and the reminder cycle (plus
    // ntfy) keeps pushing until the loop is proven.
    const armingEmailSent = await sendArmingCheckin(userEmail, switchData, false);
    console.log(
      `⏳ PENDING: Switch deployed for ${userEmail} — awaiting first check-in to arm (email sent: ${armingEmailSent})`,
    );

    // Tell the operator up front if these periods leave no room for the
    // beneficiary pre-fire warning (needs the inactivity period to be more
    // than twice the check-in interval), rather than letting them find out
    // when the switch fires unannounced.
    const warningWillFire = warningPossible({
      threshold: WARNING_MISSED_CHECKINS,
      checkinIntervalMs,
      inactivityMs,
    });
    const warningNote = warningWillFire
      ? ""
      : " Note: with these periods no advance warning can be sent to your beneficiaries before the switch fires — that needs an inactivity period more than twice the check-in interval.";

    res.status(200).json({
      success: true,
      pending: true,
      armingEmailSent,
      warningPossible: warningWillFire,
      message:
        (armingEmailSent
          ? "Switch deployed and PENDING. A check-in email was just sent to you — reply to it with the code it contains to arm the switch and start the countdown."
          : "Switch deployed and PENDING, but the first check-in email could not be sent yet. The server will keep retrying; the countdown will not start until you complete a check-in.") +
        warningNote,
      settings: {
        checkinIntervalMinutes: checkinIntervalMs / 1000 / 60,
        deadmanTimerMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error("❌ ACTIVATION ERROR:", error);
    console.error("❌ ACTIVATION ERROR STACK:", error.stack);
    res.status(500).json({
      message: "Failed to activate deadman switch",
      error: error.message,
    });
  }
});

// Helper function to execute deadman activation (extracted for reuse).
// `switchData` is the in-memory switch when the caller has it (recovery's
// expired-while-down path passes a bare { sessionToken }).
async function executeDeadmanActivation(userEmail, emails, switchData = null) {
  try {
    console.log(
      `🚨 DEADMAN TIMER EXPIRED: Starting email send process for ${userEmail}`,
    );

    // Fail-safe: never fire on the strength of "no reply" while Deploy knows
    // its own inbox is unreadable. Re-check every 10 minutes; the hold is
    // capped at 7 days (inboundHold), after which this proceeds and the
    // alert has said so. A check-in arriving meanwhile clears this timer.
    const live = activeDeadmanSwitches.get(userEmail) || switchData;
    const hold = inboundHold(live);
    if (hold.held) {
      console.warn(
        `⏸️ FIRE HELD for ${userEmail}: inbound mail down since ${hold.downSince} — re-checking in ${INBOUND_FIRE_RETRY_MS / 60000} minutes`,
      );
      maybeSendInboundDownAlert(userEmail, live, hold);
      if (live && activeDeadmanSwitches.get(userEmail) === live) {
        if (live.deadmanTimer) {
          clearTimeout(live.deadmanTimer);
          clearInterval(live.deadmanTimer);
        }
        live.deadmanTimer = setTimeout(() => {
          const currentEmails = userEmails.get(userEmail) || emails;
          executeDeadmanActivation(userEmail, currentEmails, live);
        }, INBOUND_FIRE_RETRY_MS);
      }
      return;
    }

    // Never record a "triggered" activation with zero recipients — that would
    // silently close the switch without delivering anything. Alert instead.
    if (!emails || emails.length === 0) {
      console.error(
        `❌ DEADMAN ACTIVATION: No recipients available for ${userEmail} — alerting user, NOT closing switch`,
      );
      await alertUnrecoverableSwitch(userEmail);
      return;
    }

    console.log(`   - Emails to send: ${emails.length}`);

    // Capture the session token before cleanup wipes in-memory state. Without
    // closing the DB session on delivery, every later restart would re-fire
    // this switch and re-send the deadman emails.
    const activeData = activeDeadmanSwitches.get(userEmail) || switchData;
    const sessionToken = activeData ? activeData.sessionToken : null;

    // Deliver and close the session only on confirmed delivery; on failure
    // the helper leaves the session active, alerts, and schedules retries.
    const delivered = await deliverDeadmanEmails(userEmail, emails, sessionToken);

    deadmanActivationHistory.set(userEmail, {
      triggered: true,
      timestamp: new Date().toISOString(),
      emailsSent: delivered ? emails.length : 0,
      reason: "inactivity_timeout",
      status: delivered ? "success" : "delivery_failed_retrying",
    });

    console.log(
      `🚨 DEADMAN ACTIVATED: Cleaning up timers and data for ${userEmail}`,
    );

    // Clean up after activation (do cleanup immediately)
    // Clear check-in timer to stop further check-in emails
    const currentSwitchData = activeDeadmanSwitches.get(userEmail);
    if (currentSwitchData && currentSwitchData.checkinTimer) {
      clearInterval(currentSwitchData.checkinTimer);
      console.log(
        `🔄 DEADMAN CLEANUP: Cleared check-in timer for ${userEmail}`,
      );
    }

    // Clear all user data after deadman activation
    userEmails.delete(userEmail);

    // A fired switch answers no more codes. Ping-ack codes stay live: an
    // address confirmation is still true information.
    if (currentSwitchData && currentSwitchData.deadmanTimer) {
      clearTimeout(currentSwitchData.deadmanTimer);
      clearInterval(currentSwitchData.deadmanTimer);
    }
    retireOperatorCodes(activeData ? activeData.userId : null, "fired");

    // Remove from active switches
    activeDeadmanSwitches.delete(userEmail);

    console.log(
      `✅ DEADMAN CLEANUP: All timers and data cleared for ${userEmail}`,
    );
  } catch (error) {
    console.error(`Error in deadman timer callback:`, error);
  }
}

// Deactivate deadman switch
router.post("/deactivate", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🔄 DEACTIVATE: Request from ${userEmail}`);

    if (!activeDeadmanSwitches.has(userEmail)) {
      console.log(`❌ DEACTIVATE: No active switch found for ${userEmail}`);
      return res.status(400).json({
        message: "No active deadman switch found for this user",
      });
    }

    // Get the active switch data
    const switchData = activeDeadmanSwitches.get(userEmail);
    console.log(`✅ DEACTIVATE: Found active switch for ${userEmail}`);

    // Clear all timers
    if (switchData.checkinTimer) {
      clearInterval(switchData.checkinTimer);
      console.log(`🔄 DEACTIVATE: Cleared check-in timer for ${userEmail}`);
    }
    if (switchData.deadmanTimer) {
      // Clear timeout or interval depending on which was used
      clearTimeout(switchData.deadmanTimer);
      clearInterval(switchData.deadmanTimer);
      console.log(`🔄 DEACTIVATE: Cleared deadman timer for ${userEmail}`);
    }

    // Codes emailed for this switch must stop working.
    await retireOperatorCodes(switchData.userId, "deactivated");

    // Clear user emails
    userEmails.delete(userEmail);

    // Deactivate session in database
    try {
      await userService.deactivateSession(switchData.userId);
      console.log(
        `💾 PERSISTENCE: Session deactivated in database for ${userEmail}`,
      );
    } catch (error) {
      console.error(
        `❌ PERSISTENCE: Failed to deactivate session for ${userEmail}:`,
        error,
      );
    }

    // Remove from active switches
    activeDeadmanSwitches.delete(userEmail);
    console.log(
      `✅ DEACTIVATE: Successfully deactivated deadman switch for ${userEmail}`,
    );

    res.status(200).json({
      success: true,
      message: "Deadman switch deactivated successfully",
    });
  } catch (error) {
    console.error(
      `❌ DEACTIVATE: Error deactivating deadman switch for ${req.user?.email}:`,
      error,
    );
    res.status(500).json({
      success: false,
      message: "Failed to deactivate deadman switch",
      error: error.message,
    });
  }
});

// Simple test endpoint without authentication
router.get("/test-intervals", (req, res) => {
  try {
    console.log("🧪 TEST-INTERVALS: Endpoint hit");
    const testResults = {
      "1-minutes": getIntervalMs("1-minutes"),
      "1-minute": getIntervalMs("1-minute"),
      "2-hours": getIntervalMs("2-hours"),
      "3-minutes": getInactivityMs("3-minutes"),
    };
    console.log("🧪 TEST-INTERVALS: Results =", testResults);
    res.json({
      success: true,
      testResults,
      expectedResults: {
        "1-minutes": 60000,
        "1-minute": 60000,
        "2-hours": 7200000,
        "3-minutes": 180000,
      },
    });
  } catch (error) {
    console.error("❌ TEST-INTERVALS ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/debug-activation", authenticateToken, (req, res) => {
  try {
    const { checkinInterval, inactivityPeriod, password } = req.body;
    const checkinMethod = req.body.checkinMethod || "email";

    // Never log req.body here — it contains the user's plaintext password.
    console.log(`🔍 DEBUG-ACTIVATION: checkinInterval = "${checkinInterval}"`);
    console.log(
      `🔍 DEBUG-ACTIVATION: inactivityPeriod = "${inactivityPeriod}"`,
    );

    const checkinIntervalMs = getIntervalMs(checkinInterval);
    const inactivityMs = getInactivityMs(inactivityPeriod);

    console.log(
      `🔍 DEBUG-ACTIVATION: Calculated checkinIntervalMs = ${checkinIntervalMs}ms (${checkinIntervalMs / 1000 / 60} minutes)`,
    );
    console.log(
      `🔍 DEBUG-ACTIVATION: Calculated inactivityMs = ${inactivityMs}ms (${inactivityMs / 1000 / 60} minutes)`,
    );

    res.json({
      success: true,
      received: {
        checkinMethod,
        checkinInterval,
        inactivityPeriod,
        hasPassword: !!password,
      },
      calculated: {
        checkinIntervalMs,
        inactivityMs,
        checkinMinutes: checkinIntervalMs / 1000 / 60,
        inactivityMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error("❌ DEBUG-ACTIVATION ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to clear requesting user's active switch and start fresh
router.post("/debug-clear-all", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🧹 DEBUG-CLEAR-ALL: Request from ${userEmail}`);

    // Scope to requesting user only
    let clearedCount = 0;
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      clearedCount = 1;
      console.log(`🧹 Cleared active switch for ${userEmail}`);
    }

    retireOperatorCodes(req.user.userId, "debug-clear-all");

    // Clear this user's emails and history
    const hadEmails = userEmails.has(userEmail);
    const hadHistory = deadmanActivationHistory.has(userEmail);
    userEmails.delete(userEmail);
    deadmanActivationHistory.delete(userEmail);

    console.log(`🧹 DEBUG-CLEAR-ALL: Cleanup complete for ${userEmail}`);

    res.json({
      success: true,
      message: "Your active switch and data cleared",
      cleared: {
        activeSwitches: clearedCount,
        userEmails: hadEmails ? 1 : 0,
        activationHistory: hadHistory ? 1 : 0,
      },
    });
  } catch (error) {
    console.error("❌ DEBUG-CLEAR-ALL ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to show current active switch (own user only)
router.get("/debug-active-switches", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const now = Date.now();
    const switchData = activeDeadmanSwitches.get(userEmail);

    if (!switchData) {
      return res.json({ success: true, activeSwitches: [], totalActive: 0 });
    }

    res.json({
      success: true,
      activeSwitches: [
        {
          userEmail,
          settings: switchData.settings,
          timeToNextCheckin: `${Math.round((switchData.nextCheckin - now) / 1000 / 60)} minutes`,
          timeToDeadman: `${Math.round((switchData.deadmanActivation - now) / 1000 / 60)} minutes`,
          hasCheckinTimer: !!switchData.checkinTimer,
          hasDeadmanTimer: !!switchData.deadmanTimer,
          lastActivity: switchData.lastActivity,
        },
      ],
      totalActive: 1,
    });
  } catch (error) {
    console.error("❌ DEBUG-ACTIVE-SWITCHES ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to clear expired database sessions
router.post("/debug-clear-expired", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.userId;
    console.log(`🧹 DEBUG-CLEAR-EXPIRED: Request from ${userEmail}`);

    // Clear from memory first
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      console.log(`🧹 Cleared active switch from memory`);
    }

    // Clear from database
    try {
      await userService.deleteDeadmanSession(userId);
      console.log(`🧹 Cleared database session`);
    } catch (error) {
      console.log(`🧹 No database session to clear or error:`, error.message);
    }

    // Clear related data
    userEmails.delete(userEmail);
    deadmanActivationHistory.delete(userEmail);
    retireOperatorCodes(userId, "debug-clear-expired");

    console.log(`🧹 DEBUG-CLEAR-EXPIRED: Complete cleanup for ${userEmail}`);

    res.json({
      success: true,
      message: "Expired sessions and data cleared for user",
      userEmail: userEmail,
    });
  } catch (error) {
    console.error("❌ DEBUG-CLEAR-EXPIRED ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Debug status endpoint to check active switches
router.get("/debug-status", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    console.log(`🔍 DEBUG-STATUS: Request from ${userEmail}`);

    const activeSwitch = activeDeadmanSwitches.get(userEmail);

    res.json({
      success: true,
      userEmail,
      hasActiveSwitch: activeDeadmanSwitches.has(userEmail),
      switchData: activeSwitch
        ? {
            hasCheckinTimer: !!activeSwitch.checkinTimer,
            hasDeadmanTimer: !!activeSwitch.deadmanTimer,
            lastActivity: activeSwitch.lastActivity,
            nextCheckin: activeSwitch.nextCheckin,
            deadmanActivation: activeSwitch.deadmanActivation,
            settings: activeSwitch.settings,
          }
        : null,
      inbound: inboundStatus(),
      totalActiveSwitches: activeDeadmanSwitches.size,
      hasUserEmails: userEmails.has(userEmail),
      userEmailsCount: userEmails.has(userEmail)
        ? userEmails.get(userEmail).length
        : 0,
    });
  } catch (error) {
    console.error(`❌ DEBUG-STATUS: Error for ${req.user?.email}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear all database sessions for testing
router.post("/clear-sessions", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    console.log(`🧹 CLEAR-SESSIONS: Request from ${userEmail}`);

    // Clear in-memory data
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      console.log(
        `🧹 CLEAR-SESSIONS: Cleared in-memory switch for ${userEmail}`,
      );
    }

    // Clear database sessions
    await userService.deactivateSession(userId);
    console.log(
      `🧹 CLEAR-SESSIONS: Cleared database sessions for ${userEmail}`,
    );

    // Clear other data
    userEmails.delete(userEmail);
    await retireOperatorCodes(userId, "clear-sessions");

    console.log(`✅ CLEAR-SESSIONS: All data cleared for ${userEmail}`);

    res.json({
      success: true,
      message: "All sessions and data cleared successfully",
    });
  } catch (error) {
    console.error(`❌ CLEAR-SESSIONS: Error for ${req.user?.email}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual recovery endpoint for lost deadman switches
router.post("/recover", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userEmail = req.user.email;
    const { password } = req.body;

    console.log(
      `🔄 RECOVERY: Attempting to recover deadman switch for ${userEmail}`,
    );

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password required to decrypt user data",
      });
    }

    // Check if there's already an active switch
    if (activeDeadmanSwitches.has(userEmail)) {
      console.log(`⚠️ RECOVERY: Active switch already exists for ${userEmail}`);
      return res.json({
        success: true,
        message: "Deadman switch is already active",
        alreadyActive: true,
      });
    }

    // Get user data from database
    const user = await userService.getUserById(userId);
    const userData = await userService.getUserData(userId, password, user.salt);

    if (!userData.settings || !userData.settings.sessionToken) {
      console.log(
        `❌ RECOVERY: No saved deadman switch settings found for ${userEmail}`,
      );
      return res.status(400).json({
        success: false,
        message: "No saved deadman switch configuration found",
      });
    }

    const settings = userData.settings;
    const emails = userData.emails || [];

    // Calculate remaining time based on last activity
    const now = Date.now();
    const checkinIntervalMs = getIntervalMs(settings.checkinInterval);
    const inactivityMs = getInactivityMs(settings.inactivityPeriod);

    // Recreate the switch data
    const switchData = {
      userEmail,
      userId,
      sessionToken: settings.sessionToken,
      settings: {
        checkinMethod: settings.checkinMethod,
        checkinInterval: settings.checkinInterval,
        inactivityPeriod: settings.inactivityPeriod,
        emails,
      },
      lastActivity: new Date(),
      nextCheckin: now + checkinIntervalMs,
      deadmanActivation: now + inactivityMs,
      checkinTimer: null,
      deadmanTimer: null,
    };

    // Load persisted escalation state so a warning sent before a restart is
    // properly stood down by the resetEscalationState() call below.
    try {
      const dbSession = await userService.getActiveSession(userId);
      if (dbSession && dbSession.warning_sent_at) {
        switchData.warningSentAt = parseDbTimestamp(dbSession.warning_sent_at);
      }
    } catch (error) {
      console.error(
        `❌ RECOVERY: Could not load escalation state for ${userEmail}:`,
        error,
      );
    }

    // Manual recovery is an operator action, so the schedule restarts from
    // now — the same timers a check-in builds.
    armTimers(userEmail, switchData);

    // Store the recovered switch
    activeDeadmanSwitches.set(userEmail, switchData);
    userEmails.set(userEmail, emails);

    // Manual recovery is an authenticated operator action — proof of life.
    // Reset escalation so any in-flight warning cycle is stood down.
    await resetEscalationState(userEmail, switchData);

    // Refresh the server-recoverable envelope so a later restart can still fire.
    if (switchData.sessionToken) {
      try {
        const serverBlob = cryptoUtils.encryptEmailsWithServerKey(emails);
        await userService.saveServerRecoverableEmails(
          switchData.sessionToken,
          serverBlob,
        );
        console.log(
          `🔐 RECOVERY: Server-recoverable envelope refreshed for ${userEmail}`,
        );
      } catch (error) {
        console.error(
          `❌ RECOVERY: Failed to refresh server-recoverable envelope for ${userEmail}:`,
          error,
        );
      }
    }

    console.log(
      `✅ RECOVERY: Successfully recovered deadman switch for ${userEmail}`,
    );

    res.json({
      success: true,
      message: "Deadman switch recovered successfully",
      settings: {
        checkinIntervalMinutes: checkinIntervalMs / 1000 / 60,
        deadmanTimerMinutes: inactivityMs / 1000 / 60,
      },
    });
  } catch (error) {
    console.error(
      `❌ RECOVERY: Error recovering deadman switch for ${req.user?.email}:`,
      error,
    );
    res.status(500).json({
      success: false,
      message: "Failed to recover deadman switch",
      error: error.message,
    });
  }
});

// Activity logging endpoint
router.post("/activity", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    res.status(200).json({
      success: true,
      message: "Activity logged successfully",
    });
  } catch (error) {
    console.error("Error logging activity:", error);
    res.status(500).json({ message: "Failed to log activity" });
  }
});

// Timer status endpoint - returns real backend timer values
// Removed duplicate timer-status endpoint - using the first one that returns absolute timestamps

// New endpoint to check if deadman was triggered for user
router.get("/deadman-status", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // Check activation history first (most reliable)
    let activationHistory = deadmanActivationHistory.get(userEmail);

    // The in-memory record does not survive a restart, but the fire is
    // persisted with the session. If nothing is armed and memory is empty,
    // consult the DB so the dashboard still says "fired" after a reboot
    // instead of offering a green Deploy button as if nothing happened.
    if (!activationHistory && !activeDeadmanSwitches.has(userEmail)) {
      try {
        const fired = await userService.getLastTriggeredSession(req.user.userId);
        if (fired && fired.triggered_at) {
          activationHistory = {
            triggered: true,
            timestamp: parseDbTimestamp(fired.triggered_at).toISOString(),
            emailsSent: fired.triggered_emails_sent || 0,
            reason: "inactivity_timeout",
            status: "success",
            recovered: true,
          };
          deadmanActivationHistory.set(userEmail, activationHistory);
        }
      } catch (error) {
        console.error(
          `❌ STATUS: Could not load fire record for ${userEmail}:`,
          error,
        );
      }
    }

    if (activationHistory && activationHistory.triggered) {
      return res.json({
        triggered: true,
        active: false,
        message:
          "Deadman switch has been activated - beneficiary emails were sent",
        canReset: true,
        activationTime: activationHistory.timestamp,
        emailsSent: activationHistory.emailsSent,
      });
    }

    // Check if user has an active deadman switch
    const hasActiveSwitch = activeDeadmanSwitches.has(userEmail);
    if (hasActiveSwitch) {
      return res.json({
        triggered: false,
        // Explicit: "not triggered" is NOT the same as "not armed". Without
        // this the dashboard cannot tell a running switch from no switch at
        // all, and paints the green Deploy button over a live one.
        active: true,
        message: "Deadman switch is active and running",
        canReset: false,
      });
    }

    // No active switch and no activation history = never activated
    res.json({
      triggered: false,
      active: false,
      message: "No deadman switch configured",
      canReset: false,
    });
  } catch (error) {
    console.error("Error checking deadman status:", error);
    res.status(500).json({ message: "Failed to check deadman status" });
  }
});

// Debug endpoint to check backend state
router.get("/debug/status", (req, res) => {
  const switches = [];
  for (const [userEmail, switchData] of activeDeadmanSwitches.entries()) {
    switches.push({
      userEmail,
      lastActivity: switchData.lastActivity,
      hasCheckinTimer: !!switchData.checkinTimer,
      hasDeadmanTimer: !!switchData.deadmanTimer,
      settings: switchData.settings,
    });
  }

  res.json({
    activeDeadmanSwitches: switches,
    userEmailsCount: userEmails.size,
    inbound: inboundStatus(),
    timestamp: new Date().toISOString(),
  });
});

// Email test endpoint
router.post("/debug/test-email", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // Test email service connection
    const connectionTest = await emailService.testEmailConnection();

    if (!connectionTest.success) {
      return res.json({
        success: false,
        message: "Email service connection failed",
        error: connectionTest.message,
      });
    }

    // Test sending a check-in email. The code is random and never stored,
    // so a reply to it is simply unrecognised.
    const emailSent = await emailService.sendCheckinEmail(
      userEmail,
      formatCode(generateCode()),
    );

    res.json({
      success: emailSent,
      message: emailSent
        ? "Test email sent successfully"
        : "Failed to send test email",
      connectionTest: connectionTest,
    });
  } catch (error) {
    console.error("Email test error:", error);
    res.status(500).json({
      success: false,
      message: "Email test failed",
      error: error.message,
    });
  }
});

// Reset endpoint to clear deadman data after activation
router.post("/reset", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // The fire record is persisted; forget it or it comes back after the
    // next restart.
    try {
      await userService.clearTriggeredHistory(req.user.userId);
    } catch (error) {
      console.error(`❌ RESET: Could not clear fire record for ${userEmail}:`, error);
    }

    // Clear any active deadman switch
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
    }

    // Clear stored emails
    if (userEmails.has(userEmail)) {
      userEmails.delete(userEmail);
    }

    // Clear activation history
    if (deadmanActivationHistory.has(userEmail)) {
      deadmanActivationHistory.delete(userEmail);
    }

    const retired = await retireOperatorCodes(req.user.userId, "reset");

    res.json({
      success: true,
      message: "Deadman switch data has been reset successfully",
      cleared: {
        activeSwitch: true,
        emails: true,
        activationHistory: true,
        codes: retired,
      },
    });
  } catch (error) {
    console.error("Error resetting deadman data:", error);
    res.status(500).json({
      message: "Failed to reset deadman data",
      error: error.message,
    });
  }
});

// ---- Timers (v2.2.0: one implementation for arming, check-in, recovery) ----

const MAX_TIMEOUT = 2147483647; // setTimeout overflows above ~24.8 days

function clearSwitchTimers(switchData) {
  if (switchData.checkinTimer) {
    clearInterval(switchData.checkinTimer);
    clearTimeout(switchData.checkinTimer);
    switchData.checkinTimer = null;
  }
  if (switchData.deadmanTimer) {
    clearTimeout(switchData.deadmanTimer);
    clearInterval(switchData.deadmanTimer);
    switchData.deadmanTimer = null;
  }
}

// Fire at switchData.deadmanActivation, with setInterval polling for
// deadlines beyond what setTimeout can hold. Recipients are read at fire
// time (never a closure snapshot) so recipient edits stay live.
function scheduleDeadmanTimer(userEmail, switchData) {
  const fire = async () => {
    const deadmanEmails =
      userEmails.get(userEmail) || (switchData.settings && switchData.settings.emails) || [];
    await executeDeadmanActivation(userEmail, deadmanEmails, switchData);
  };
  const remaining = switchData.deadmanActivation - Date.now();
  if (remaining <= MAX_TIMEOUT) {
    switchData.deadmanTimer = setTimeout(fire, Math.max(0, remaining));
  } else {
    console.log(
      `⚠️ LARGE TIMEOUT: Using interval checking for ${userEmail} (${remaining}ms > ${MAX_TIMEOUT}ms)`,
    );
    switchData.deadmanTimer = setInterval(async () => {
      if (switchData.deadmanActivation - Date.now() <= 0) {
        clearInterval(switchData.deadmanTimer);
        await fire();
      }
    }, 60000);
  }
}

// One periodic check-in tick: count the miss (and maybe warn), send the
// next check-in email. Returns false when this timer should stop.
async function periodicCheckinTick(userEmail, switchData, checkinIntervalMs, label) {
  try {
    console.log(`🔍 PERIODIC CHECK-IN: Timer fired for ${userEmail} (${label})`);
    if (activeDeadmanSwitches.get(userEmail) !== switchData) {
      console.log(
        `⚠️ PERIODIC CHECK-IN: Deadman switch no longer active for ${userEmail}, stopping timer`,
      );
      if (switchData.checkinTimer) {
        clearInterval(switchData.checkinTimer);
        clearTimeout(switchData.checkinTimer);
      }
      return false;
    }

    if (switchData.sessionToken) {
      try {
        await userService.updateSessionActivity(switchData.sessionToken);
      } catch (error) {
        console.error(
          `Failed to update session activity during periodic check-in for ${userEmail}:`,
          error,
        );
      }
    }

    // Deadline passed → the fire path owns this switch now.
    if (switchData.deadmanActivation && Date.now() >= switchData.deadmanActivation) {
      console.log(
        `⏭️ PERIODIC CHECK-IN: Deadman deadline passed for ${userEmail}, skipping check-in email`,
      );
      return true;
    }

    const missedCount = await registerMissedCheckin(userEmail, switchData);

    issueCheckinEmail(userEmail, switchData, { missedCheckins: missedCount })
      .then((emailSent) => {
        if (!emailSent) {
          console.error(`❌ PERIODIC CHECK-IN: Failed to send check-in email to ${userEmail}`);
        } else {
          console.log(`✅ PERIODIC CHECK-IN: Email sent successfully to ${userEmail}`);
        }
      })
      .catch((error) => {
        console.error(`❌ PERIODIC CHECK-IN: Error sending check-in email to ${userEmail}:`, error);
      });

    const now = Date.now();
    switchData.nextCheckinTime = new Date(now + checkinIntervalMs);
    switchData.nextCheckin = now + checkinIntervalMs;
    console.log(
      `📧 PERIODIC CHECK-IN: Email issued for ${userEmail}, next check-in in ${checkinIntervalMs / 1000 / 60} minutes`,
    );
  } catch (error) {
    console.error(`❌ PERIODIC CHECK-IN: Critical error in timer callback for ${userEmail}:`, error);
    // Don't clear the timer on error, let it retry next time
  }
  return true;
}

// Fresh schedule from now: the operator just proved they are alive (or
// explicitly re-armed). Used by every check-in and by manual recovery.
function armTimers(userEmail, switchData) {
  clearSwitchTimers(switchData);
  const checkinIntervalMs = getIntervalMs(switchData.settings.checkinInterval);
  const inactivityMs = getInactivityMs(switchData.settings.inactivityPeriod);
  const now = Date.now();
  switchData.pending = false;
  switchData.nextCheckinTime = new Date(now + checkinIntervalMs);
  switchData.nextCheckin = now + checkinIntervalMs;
  switchData.deadmanActivation = now + inactivityMs;
  switchData.checkinTimer = setInterval(
    () => periodicCheckinTick(userEmail, switchData, checkinIntervalMs, "armed"),
    checkinIntervalMs,
  );
  scheduleDeadmanTimer(userEmail, switchData);
  console.log(
    `⏰ TIMERS: ${userEmail} — check-in every ${checkinIntervalMs / 60000} min, deadline in ${inactivityMs / 60000} min`,
  );
}

// Restart-recovery schedule: first tick at the persisted absolute time
// (lastActivity + interval), then every interval; deadline as persisted.
function startRecoveredTimers(userEmail, switchData, checkinIntervalMs, delayMs) {
  clearSwitchTimers(switchData);
  const tick = async () => {
    const keepGoing = await periodicCheckinTick(userEmail, switchData, checkinIntervalMs, "recovered");
    if (keepGoing && activeDeadmanSwitches.get(userEmail) === switchData) {
      switchData.checkinTimer = setTimeout(tick, checkinIntervalMs);
    }
  };
  switchData.checkinTimer = setTimeout(tick, Math.max(0, delayMs));
  scheduleDeadmanTimer(userEmail, switchData);
}

// ---- Check-in (v2.2.0: one implementation, two callers) ----
//
// The operator proved they are alive by replying with the code (the poller,
// via "reply"). There is deliberately no dashboard check-in: one path, so
// the reply path is exercised every time and a broken one is noticed. If
// mail is broken the answer is to fix it or abort, and the inbound
// fail-safe holds the fire meanwhile. Completing the first check-in of a
// pending switch is the arming event — the round trip just proved itself —
// and first contact with beneficiaries happens here, never at deploy.
async function performCheckin(userEmail, switchData, { via = "reply" } = {}) {
  if (!switchData || activeDeadmanSwitches.get(userEmail) !== switchData) {
    return { ok: false, reason: "no-switch" };
  }
  const wasPending = !!switchData.pending;
  const now = new Date();
  switchData.lastActivity = now;
  switchData.lastCheckinVia = via;
  switchData.lastCheckinAt = now;
  // A successful check-in fully re-establishes the switch state, so a
  // switch recovered after a restart can rejoin the periodic save loop.
  switchData.recovered = false;
  switchData.pending = false;

  // Proof of life: reset the missed-check-in escalation, and stand the
  // beneficiaries down if a pre-fire warning had already gone out.
  await resetEscalationState(userEmail, switchData);

  if (switchData.sessionToken) {
    try {
      await userService.updateSessionActivity(switchData.sessionToken);
      await userService.setLastCheckinVia(switchData.sessionToken, via);
    } catch (error) {
      console.error(`Failed to update session activity for ${userEmail}:`, error);
    }
  }

  // Every outstanding check-in/arming code answered the question this
  // check-in just answered. Retire them all (the one used was already
  // marked used by the caller and is untouched here).
  try {
    await userService.retireCodes({ userId: switchData.userId, kinds: ["arming", "checkin"] });
  } catch (error) {
    console.error(`❌ CODE: Failed to retire outstanding codes for ${userEmail}:`, error);
  }

  armTimers(userEmail, switchData);

  if (wasPending) {
    console.log(
      `🟢 ARMED: First check-in completed for ${userEmail} (via ${via}) — countdown started`,
    );
    // First contact happens HERE, not at deploy: the switch now really
    // exists and is counting down. Non-blocking — arming must not fail
    // because a ping could not be sent.
    queueBeneficiaryPings(
      switchData.userId,
      userEmail,
      getRecipientsFor(userEmail, switchData),
      // Arming is explicit intent: contact everyone on this switch,
      // including anyone carrying a stale unanswered ping from before.
      true,
    ).catch((error) =>
      console.error(`❌ PING: First-contact pass after arming failed for ${userEmail}:`, error),
    );
    notify(
      `Switch ARMED for ${userEmail} — first check-in completed (via ${via})${via === "reply" ? ", the whole loop is verified" : ""} and the countdown is now running.`,
      { tags: "white_check_mark,shield" },
    );
  } else {
    console.log(`🎯 CHECK-IN COMPLETE (via ${via}): Both timers reset for ${userEmail}`);
  }

  try {
    await userService.saveTimerState(switchData.userId, {
      nextCheckin: switchData.nextCheckin,
      deadmanActivation: switchData.deadmanActivation,
      lastActivity: switchData.lastActivity,
    });
    console.log(`💾 PERSISTENCE: Timer state saved after check-in for ${userEmail}`);
  } catch (error) {
    console.error(`❌ PERSISTENCE: Failed to save timer state after check-in for ${userEmail}:`, error);
  }

  return { ok: true, wasPending };
}

// ---- Beneficiary acknowledgement (v2.2.0: by reply code) ----
//
// Acking proves the delivery path is alive end to end; it neither triggers
// nor suppresses anything. `codeRow` is a live reply_codes row of kind
// ping-ack (ref = beneficiary_pings.id) or warning-ack (ref = session).
async function performAck(codeRow) {
  if (codeRow.kind === "ping-ack") {
    const ping = await userService.ackBeneficiaryPingById(parseInt(codeRow.ref, 10));
    if (!ping) return { ok: false, kind: "ping-ack", reason: "no-ping-row" };
    console.log(`🔷 ACK: Liveness ping acknowledged for ${ping.email} (by reply)`);
    // The row is read before ack_at is stamped, so a null here means this
    // reply is the one that confirmed the cycle — repeats skip the operator
    // notice. First contact vs annual renewal is distinguished by whether
    // the row was created for this ping.
    if (!ping.ack_at) {
      const firstContact =
        Math.abs(
          parseDbTimestamp(ping.ping_sent_at).getTime() -
            parseDbTimestamp(ping.created_at).getTime(),
        ) < 120000;
      emailService
        .sendPingConfirmedNotice(ping.email, firstContact)
        .catch((error) =>
          console.error(`❌ ACK: Ping-confirmed notice to ${ping.email} failed:`, error),
        );
    }
    return { ok: true, kind: "ping-ack", alreadyAcked: !!ping.ack_at };
  }

  if (codeRow.kind === "warning-ack") {
    const session = await userService.ackWarningBySession(codeRow.ref);
    const switchData = activeDeadmanSwitches.get(codeRow.user_email);
    if (switchData && switchData.sessionToken === codeRow.ref) {
      switchData.warningAckAt = switchData.warningAckAt || new Date();
    }
    console.log(`🔷 ACK: Pre-fire warning acknowledged for ${codeRow.user_email} (by reply)`);
    return { ok: !!session || !!switchData, kind: "warning-ack" };
  }

  return { ok: false, kind: codeRow.kind, reason: "not-an-ack-kind" };
}

// ---- Inbound reply handling (v2.2.0) ----
//
// Called by utils/inboundMail.js for every new message (and by the sandbox
// test hook). Returns a small result object for logs and tests. Rules that
// hold always: bounces and auto-replies are dropped before anything; a
// code counts only outside quoted text; the sender must be the address the
// email went to; unrecognised mail is never answered.

const OPERATOR_KINDS = new Set(["arming", "checkin"]);

function receiptOnce(codeId, type) {
  const key = `${codeId}:${type}`;
  if (receiptsSent.has(key)) return false;
  receiptsSent.add(key);
  if (receiptsSent.size > 5000) receiptsSent.clear();
  return true;
}

function reissueAllowed(userId) {
  const last = lastInboundReissueAt.get(userId) || 0;
  if (Date.now() - last < REISSUE_MIN_GAP_MS) return false;
  lastInboundReissueAt.set(userId, Date.now());
  return true;
}

function utcClock(d = new Date()) {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

// The plaintext address a beneficiary-kind code was sent to. Beneficiary
// addresses are only ever persisted hashed; the plaintext lives in the
// armed switch's recipient list, or in the session's server-key envelope.
async function resolveRecipientAddress(codeRow) {
  const switchData = activeDeadmanSwitches.get(codeRow.user_email);
  const lists = [];
  if (switchData) lists.push(getRecipientsFor(codeRow.user_email, switchData));
  try {
    const session = await userService.getActiveSession(codeRow.user_id);
    if (session && session.server_encrypted_emails) {
      lists.push(cryptoUtils.decryptEmailsWithServerKey(session.server_encrypted_emails));
    }
  } catch (_) {}
  for (const list of lists) {
    for (const r of list || []) {
      const addr = r.to || r.address;
      if (addr && hashEmail(addr) === codeRow.recipient_hash) return addr;
    }
  }
  return null;
}

// Fresh email for whatever a code stood for. Rate limited per operator.
// Returns true when a new email went out.
async function reissueFor(codeRow, { why }) {
  if (!reissueAllowed(codeRow.user_id)) {
    console.log(`⏳ REISSUE: rate limit for user ${codeRow.user_id} (${why}) — not reissuing`);
    return false;
  }
  const userEmail = codeRow.user_email;
  const switchData = activeDeadmanSwitches.get(userEmail);
  if (OPERATOR_KINDS.has(codeRow.kind)) {
    if (!switchData) return false;
    console.log(`🔁 REISSUE: fresh ${switchData.pending ? "arming" : "check-in"} email for ${userEmail} (${why})`);
    return issueCheckinEmail(userEmail, switchData, {
      arming: !!switchData.pending,
      reminder: false,
      missedCheckins: switchData.missedCheckins || 0,
    });
  }
  const addr = await resolveRecipientAddress(codeRow);
  if (!addr) return false;
  if (codeRow.kind === "ping-ack") {
    const ping = await userService.getBeneficiaryPing(codeRow.user_id, codeRow.recipient_hash);
    if (ping && ping.ack_at) return false; // already confirmed — nothing to reissue
    console.log(`🔁 REISSUE: fresh address-check email for ${userEmail}'s recipient (${why})`);
    return sendPingTo(codeRow.user_id, userEmail, addr, true);
  }
  if (codeRow.kind === "warning-ack") {
    if (!switchData || switchData.sessionToken !== codeRow.ref || switchData.warningAckAt) return false;
    console.log(`🔁 REISSUE: fresh warning email for ${userEmail}'s recipient (${why})`);
    return sendWarningTo(userEmail, switchData, addr, true);
  }
  return false;
}

async function handleInbound(parsed, meta = {}) {
  const from = fromAddress(parsed);
  const messageId = parsed.messageId || null;
  const threading = { inReplyTo: messageId, references: parsed.references || messageId };

  if (isBounce(parsed)) return { action: "dropped", reason: "bounce" };
  if (isAutoReply(parsed)) return { action: "dropped", reason: "auto-reply" };
  if (rawHeader(parsed, "x-deploy-deadman") !== null) return { action: "dropped", reason: "own-mail" };
  if (!from) return { action: "dropped", reason: "no-from" };

  const text = visibleText(parsed);
  const candidates = extractCodes(parsed.subject, text);
  if (candidates.length === 0) return { action: "dropped", reason: "no-code" };

  const fromHash = hashEmail(from);

  // 1. A live code among the candidates?
  let live = null;
  for (const c of candidates) {
    live = await userService.findLiveCode(hashCode(c));
    if (live) break;
  }

  if (live) {
    if (live.recipient_hash && live.recipient_hash !== fromHash) {
      // Right code, wrong sender. Tell the ORIGINAL address, once: silence
      // here would let the operator believe they had checked in.
      const original = OPERATOR_KINDS.has(live.kind)
        ? live.user_email
        : await resolveRecipientAddress(live);
      console.warn(
        `🚫 INBOUND: ${live.kind} code for user ${live.user_id} arrived from another address (${hashEmail(from).slice(0, 8)}), not the one it was sent to — rejected`,
      );
      if (original && receiptOnce(live.id, "mismatch")) {
        await emailService.sendReceipt(
          original,
          "A reply with your Deploy code was not accepted",
          `A reply with your code arrived from ${from} and was not accepted. Reply from ${original}.`,
        );
      }
      return { action: "rejected", reason: "from-mismatch", kind: live.kind };
    }

    if (OPERATOR_KINDS.has(live.kind)) {
      const switchData = activeDeadmanSwitches.get(live.user_email);
      if (!switchData || (live.ref && switchData.sessionToken !== live.ref)) {
        // The switch this code belonged to is gone (deactivated, fired,
        // re-deployed). Nothing to check in to.
        await userService.retireCode(live.id);
        if (receiptOnce(live.id, "gone")) {
          await emailService.sendReceipt(
            live.user_email,
            "That Deploy code has expired",
            "That code has expired — the switch it belonged to is no longer running. Log in to your Deploy dashboard to see its state.",
            threading,
          );
        }
        return { action: "expired", reason: "switch-gone", kind: live.kind };
      }
      // Mark used BEFORE the check-in retires the other outstanding codes,
      // so this one reads "used" (→ repeat receipt) rather than "retired".
      await userService.markCodeUsed(live.id);
      const result = await performCheckin(live.user_email, switchData, { via: "reply" });
      if (result.ok && receiptOnce(live.id, "ok")) {
        const due = emailService.dateStamp(new Date(switchData.nextCheckin));
        await emailService.sendReceipt(
          live.user_email,
          result.wasPending ? "Deploy switch armed" : "Deploy check-in received",
          result.wasPending
            ? `Switch armed at ${utcClock()} — the whole round trip is verified and the countdown is running. Next check-in due ${due}.`
            : `Check-in received at ${utcClock()} — next check-in due ${due}.`,
          threading,
        );
      }
      return { action: "checkin", wasPending: result.wasPending, via: "reply" };
    }

    // ping-ack / warning-ack
    const ack = await performAck(live);
    await userService.markCodeUsed(live.id);
    if (ack.ok && receiptOnce(live.id, "ok")) {
      await emailService.sendReceipt(
        from,
        "Confirmed — thank you",
        "Confirmed — thank you. Nothing has been sent or triggered and nothing else is needed.",
        threading,
      );
    }
    return { action: "ack", kind: live.kind, ok: ack.ok };
  }

  // 2. A stale (used or retired) code?
  let stale = null;
  for (const c of candidates) {
    stale = await userService.findCodeByHash(hashCode(c));
    if (stale) break;
  }
  if (stale) {
    if (stale.recipient_hash && stale.recipient_hash !== fromHash) {
      // Someone else's old code. Nothing to say to a stranger.
      return { action: "dropped", reason: "stale-from-mismatch" };
    }
    if (stale.used_at) {
      // The same code sent twice (a reload, a nervous beneficiary). Say so
      // once; nothing else changes.
      if (receiptOnce(stale.id, "repeat")) {
        if (OPERATOR_KINDS.has(stale.kind)) {
          await emailService.sendReceipt(
            from,
            "That Deploy code was already used",
            `That code was already used — your check-in at ${utcClock(parseDbTimestamp(stale.used_at))} was recorded. Nothing else is needed until your next check-in email.`,
            threading,
          );
        } else {
          await emailService.sendReceipt(
            from,
            "Confirmed — thank you",
            "Confirmed — thank you. Nothing has been sent or triggered and nothing else is needed.",
            threading,
          );
        }
      }
      return { action: "repeat", kind: stale.kind };
    }
    // Retired: answered by a later check-in, cancelled after wrong guesses,
    // or the switch it belonged to has stopped (fired, aborted, re-deployed).
    const staleSwitch = activeDeadmanSwitches.get(stale.user_email);
    const switchGone =
      OPERATOR_KINDS.has(stale.kind) &&
      (!staleSwitch || (stale.ref && staleSwitch.sessionToken !== stale.ref));
    const reissued = switchGone ? false : await reissueFor(stale, { why: "stale code" });
    if (receiptOnce(stale.id, "expired")) {
      await emailService.sendReceipt(
        from,
        "That Deploy code has expired",
        switchGone
          ? "That code has expired — the switch it belonged to is no longer running. Log in to your Deploy dashboard to see its state."
          : reissued
            ? "That code has expired — a fresh email with a new code is on its way."
            : "That code has expired. Please use the code from the most recent email from Deploy.",
        threading,
      );
    }
    return { action: "expired", kind: stale.kind, reissued, switchGone };
  }

  // 3. Unknown code. Only a sender who holds a live code is answered at all;
  // for everyone else this is unrecognised mail and gets silence.
  const senderCodes = await userService.liveCodesForRecipientHash(fromHash);
  if (senderCodes.length === 0) return { action: "dropped", reason: "unknown-sender" };
  const target =
    senderCodes.find((r) => OPERATOR_KINDS.has(r.kind)) ||
    senderCodes.find((r) => r.kind === "warning-ack") ||
    senderCodes[0];
  const attempts = await userService.bumpFailedAttempts(target.id);
  console.warn(
    `🚫 INBOUND: wrong code from ${OPERATOR_KINDS.has(target.kind) ? from : "recipient " + hashEmail(from).slice(0, 8)} (attempt ${attempts}/${MAX_FAILED_ATTEMPTS} against live ${target.kind} code)`,
  );
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await userService.retireCode(target.id);
    const reissued = await reissueFor(target, { why: "wrong-guess lockout" });
    if (receiptOnce(target.id, "lockout")) {
      await emailService.sendReceipt(
        from,
        "That Deploy code didn't match",
        reissued
          ? `That code didn't match. After ${MAX_FAILED_ATTEMPTS} wrong tries it was cancelled — a fresh email with a new code is on its way.`
          : `That code didn't match. After ${MAX_FAILED_ATTEMPTS} wrong tries it was cancelled; a new one will come with the next scheduled email.`,
        threading,
      );
    }
    return { action: "wrong-code", attempts, lockedOut: true, reissued };
  }
  if (receiptOnce(target.id, "wrong")) {
    await emailService.sendReceipt(from, "That Deploy code didn't match", "That code didn't match.", threading);
  }
  return { action: "wrong-code", attempts, lockedOut: false };
}

// Dashboard-facing summary of the inbound connection.
function inboundStatus() {
  const st = inboundMail.getState();
  return {
    enabled: st.enabled,
    configured: st.configured,
    connected: st.connected,
    lastCheckedAt: st.lastCheckedAt,
    downSince: st.downSince,
    error: st.error,
    host: st.host,
    user: st.user,
    folders: st.folders,
    holdCapDays: INBOUND_HOLD_CAP_MS / 86400000,
    testHooks: process.env.DEPLOY_TEST_HOOKS === "1",
  };
}

router.get("/inbound-status", authenticateToken, (req, res) => {
  res.json({ success: true, ...inboundStatus() });
});

// Start the IMAP reader (once the DB is up and recovery has re-armed the
// switches — see the recovery timer above).
let inboundStarted = false;
function startInboundMail() {
  if (inboundStarted) return;
  inboundStarted = true;
  const st = inboundMail.getState();
  if (!st.enabled) {
    console.warn("⚠️ REPLY_BY_EMAIL=false — replies are NOT read; the dashboard is the only check-in path");
    return;
  }
  if (!st.configured) {
    console.warn(
      "⚠️ IMAP not configured — replies to check-in emails cannot be received. Set IMAP_HOST/IMAP_USER/IMAP_PASS (Gmail: derived from EMAIL_USER/EMAIL_PASS).",
    );
  }
  inboundMail
    .start({
      store: {
        get: (k) => userService.getSetting(k),
        set: (k, v) => userService.setSetting(k, v),
        del: (k) => userService.deleteSetting(k),
      },
      onMessage: handleInbound,
    })
    .catch((error) => console.error("❌ IMAP: failed to start:", error));
}

// Debug endpoints for troubleshooting
router.get("/debug/active-switches", authenticateToken, (req, res) => {
  const userEmail = req.user.email;
  const switchData = activeDeadmanSwitches.get(userEmail);

  res.json({
    userEmail,
    hasActiveSwitch: !!switchData,
    switchData: switchData
      ? {
          lastActivity: switchData.lastActivity,
          nextCheckin: switchData.nextCheckinTime,
          hasCheckinTimer: !!switchData.checkinTimer,
          hasDeadmanTimer: !!switchData.deadmanTimer,
          sessionToken: switchData.sessionToken,
          emailCount: switchData.settings.emails
            ? switchData.settings.emails.length
            : 0,
        }
      : null,
    userEmailsCount: (userEmails.get(userEmail) || []).length,
    inbound: inboundStatus(),
  });
});

router.get("/debug/activation-history", authenticateToken, (req, res) => {
  const userEmail = req.user.email;
  const history = deadmanActivationHistory.get(userEmail);

  res.json({
    userEmail,
    activationHistory: history || null,
  });
});

// Nuclear reset endpoint - wipes requesting user's data completely
router.post("/nuclear-reset", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.userId;

    console.log(`💥 NUCLEAR-RESET: Starting complete wipe for ${userEmail}`);

    // 1. Clear in-memory data for this user only
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
    }
    userEmails.delete(userEmail);
    deadmanActivationHistory.delete(userEmail);
    console.log(`💥 NUCLEAR-RESET: Cleared memory for ${userEmail}`);

    // Every code this user's emails ever carried, operator- and
    // beneficiary-side, stops working (same cascade as delete-account).
    try {
      const n = await userService.retireCodes({ userId });
      console.log(`💥 NUCLEAR-RESET: Retired ${n} live code(s)`);
    } catch (error) {
      console.error(`💥 NUCLEAR-RESET: Could not retire codes:`, error);
    }

    // 2. Clear database session
    try {
      await userService.deactivateSession(userId);
      console.log(`💥 NUCLEAR-RESET: Database session deactivated`);
    } catch (error) {
      console.log(`💥 NUCLEAR-RESET: No database session to deactivate`);
    }

    console.log(`💥 NUCLEAR-RESET: Complete reset for ${userEmail}`);

    res.json({
      success: true,
      message: "NUCLEAR RESET COMPLETE. Your deadman switch data has been wiped. You can now start completely fresh.",
    });
  } catch (error) {
    console.error("❌ NUCLEAR-RESET ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Simple endpoint to force deactivation and clear all data
router.post("/force-clear", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.userId;
    const { password } = req.body;

    console.log(`🧹 FORCE-CLEAR: Request from ${userEmail}`);

    if (!password) {
      return res
        .status(400)
        .json({ message: "Password required for database clearing" });
    }

    // Clear active switch from memory
    if (activeDeadmanSwitches.has(userEmail)) {
      const switchData = activeDeadmanSwitches.get(userEmail);
      if (switchData.checkinTimer) clearInterval(switchData.checkinTimer);
      if (switchData.deadmanTimer) clearTimeout(switchData.deadmanTimer);
      activeDeadmanSwitches.delete(userEmail);
      console.log(`🧹 FORCE-CLEAR: Cleared active switch from memory`);
    }

    // Clear all related data
    userEmails.delete(userEmail);
    deadmanActivationHistory.delete(userEmail);
    retireOperatorCodes(userId, "force-clear");

    // Clear database emails by updating user data with empty emails
    try {
      const userData = await userService.getUserData(userId, password, null);
      if (userData) {
        // Create updated user data with empty emails
        const updatedUserData = {
          ...userData,
          deadmanSettings: {
            ...userData.deadmanSettings,
            emails: [],
          },
        };

        // Update the database
        await userService.updateUserData(
          userId,
          password,
          null,
          updatedUserData,
        );
        console.log(`🧹 FORCE-CLEAR: Cleared emails from database`);
      }
    } catch (error) {
      console.log(
        `🧹 FORCE-CLEAR: Error clearing database emails:`,
        error.message,
      );
    }

    // Deactivate database session
    try {
      await userService.deactivateSession(userId);
      console.log(`🧹 FORCE-CLEAR: Deactivated database session`);
    } catch (error) {
      console.log(`🧹 FORCE-CLEAR: No database session to deactivate`);
    }

    console.log(`🧹 FORCE-CLEAR: Complete cleanup for ${userEmail}`);

    res.json({
      success: true,
      message:
        "All deadman switch data cleared including database emails. You can now start fresh.",
    });
  } catch (error) {
    console.error("❌ FORCE-CLEAR ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint for time interval validation
router.post("/test/validate-interval", (req, res) => {
  const { interval, isInactivityPeriod = false } = req.body;

  try {
    const validation = validateTimeInterval(interval, isInactivityPeriod);

    res.json({
      success: true,
      interval: interval,
      isInactivityPeriod: isInactivityPeriod,
      validation: validation,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
// For server.js: the sandbox test hook and the config-save reconfigure.
router.handleInbound = handleInbound;
router.inboundStatus = inboundStatus;
