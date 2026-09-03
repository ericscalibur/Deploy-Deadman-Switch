// Out-of-band operator alerting via ntfy (https://ntfy.sh).
//
// Deploy's other channels (check-in emails, the dashboard) share failure
// modes with the things they would need to report — SMTP down means email
// can't say "email is down", Tor down means the dashboard can't say "Tor is
// down". A push notification through ntfy is independent of both, so it is
// where the system screams when it is sick.
//
// ntfy topics are unauthenticated: the topic name is the only secret. Use a
// random, unguessable one (e.g. `deploy-$(openssl rand -hex 12)`), never
// commit it, and subscribe to it in the ntfy phone app. When NTFY_TOPIC is
// unset, alerting is disabled and every call is a silent no-op.
//
// Env (read at call time so a config save takes effect without a restart):
//   NTFY_TOPIC  — the topic to publish to (unset → disabled)
//   NTFY_SERVER — ntfy server base URL (default https://ntfy.sh)

function isEnabled() {
  return !!(process.env.NTFY_TOPIC && process.env.NTFY_TOPIC.trim());
}

// Fire-and-forget publish. Never throws — an alerting failure must not take
// down the path it is alerting about. Resolves true only on a 2xx response.
async function notify(message, options = {}) {
  if (!isEnabled()) return false;

  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(
    /\/+$/,
    "",
  );
  const url = `${server}/${encodeURIComponent(process.env.NTFY_TOPIC.trim())}`;

  const headers = {
    Title: options.title || "Deploy Deadman Switch",
  };
  if (options.priority) headers.Priority = options.priority;
  if (options.tags) headers.Tags = options.tags;

  try {
    const res = await fetch(url, {
      method: "POST",
      body: message,
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`⚠️ NTFY: Publish failed with HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`⚠️ NTFY: Publish failed: ${error.message}`);
    return false;
  }
}

// Repeating failures (a broken transporter re-verifies every minute, a
// failed delivery retries every 10) must not turn the operator's phone into
// a siren they mute — that recreates the habituation problem the email
// severity scheme exists to avoid. One alert per key per interval.
const lastSentByKey = new Map();

// Pure decision helper, exported for tests: mutates the map only when it
// answers "send".
function shouldSendThrottled(map, key, intervalMs, nowMs) {
  const last = map.get(key);
  if (last !== undefined && nowMs - last < intervalMs) return false;
  map.set(key, nowMs);
  return true;
}

async function notifyThrottled(key, intervalMs, message, options = {}) {
  if (!isEnabled()) return false;
  if (!shouldSendThrottled(lastSentByKey, key, intervalMs, Date.now())) {
    return false;
  }
  return notify(message, options);
}

// A recovery notice only makes sense if the matching failure was announced;
// clearing the key also lets the next failure alert immediately instead of
// waiting out the old throttle window.
function clearThrottle(key) {
  lastSentByKey.delete(key);
}

module.exports = {
  isEnabled,
  notify,
  notifyThrottled,
  clearThrottle,
  shouldSendThrottled,
};
