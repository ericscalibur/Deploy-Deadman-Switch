// Outside watchdog for Deploy itself.
//
// Nothing on this machine can report this machine being gone. If the box loses
// power, the ISP is cancelled, or the mail account dies after the operator has
// died, no one is left checking. So something off this machine has to notice
// the silence and tell a living person. Two ways to do that, usable together:
//
// ntfy (WATCHDOG_NTFY_TOPIC): every hour Deploy queues two alerts on an ntfy
// server, for delivery in 24 and 60 hours. Each new pair replaces the last by
// sequence ID, so while Deploy is healthy they are pushed back forever and
// never arrive. When Deploy goes quiet, they are delivered. The second one
// covers a person who missed the first. ntfy refuses delays over 3 days, and
// the server must not be on this machine, or it dies with it.
//
// A monitor (HEARTBEAT_URL): an hourly GET to anything that alarms when pings
// stop, such as Healthchecks.io or a self-hosted Uptime Kuma.
//
// Neither carries recipients, state or secrets, and neither can deliver
// anything. A passed deadline still fires on restart, so the alarm's job is to
// get the machine and its mail working again.
//
// Nothing is sent while Deploy can't send or read mail, so a dead mailbox trips
// the watchdog just as a dead box does. It keeps running on a disarmed or fired
// switch, because an abort must not look like an outage.
//
// Env (read at call time so a config save takes effect without a restart):
//   WATCHDOG_NTFY_TOPIC — topic for the trusted person (unset → off). Keep it
//                         separate from NTFY_TOPIC, which carries operator detail.
//   NTFY_SERVER         — ntfy server base URL (default https://ntfy.sh)
//   HEARTBEAT_URL       — the URL to GET (unset → off)

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;

const NTFY_ALERTS = [
  {
    id: "deploy-watchdog-first",
    delay: "24h",
    title: "Deploy has gone silent",
    message:
      "The Deploy deadman switch stopped checking in. Its machine, internet or mailbox may have failed. Please find the machine, power it on, and get its internet and email working.",
  },
  {
    id: "deploy-watchdog-second",
    delay: "60h",
    title: "Deploy is still silent",
    message:
      "Second notice: the Deploy deadman switch has not checked in for 60 hours. Please find the machine, power it on, and get its internet and email working.",
  },
];

function isEnabled() {
  return !!(
    (process.env.HEARTBEAT_URL && process.env.HEARTBEAT_URL.trim()) ||
    (process.env.WATCHDOG_NTFY_TOPIC && process.env.WATCHDOG_NTFY_TOPIC.trim())
  );
}

// Pure decision helper, exported for tests. An install with no IMAP configured
// is judged on sending alone, matching how inboundHold treats it.
function mailHealthy(smtpReady, inboundState) {
  if (!smtpReady) return false;
  if (!inboundState || !inboundState.enabled || !inboundState.configured) return true;
  return !inboundState.downSince;
}

// Never throws, so a watchdog failure can't touch the switch. Resolves true
// only on a 2xx response.
async function send(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`⚠️ HEARTBEAT: Request failed with HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`⚠️ HEARTBEAT: Request failed: ${error.message}`);
    return false;
  }
}

async function ping() {
  const url = process.env.HEARTBEAT_URL && process.env.HEARTBEAT_URL.trim();
  return url ? send(url) : false;
}

// Replaces any alerts still waiting, which restarts their countdowns.
async function rescheduleNtfyAlerts() {
  const topic = process.env.WATCHDOG_NTFY_TOPIC && process.env.WATCHDOG_NTFY_TOPIC.trim();
  if (!topic) return false;
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const results = await Promise.all(
    NTFY_ALERTS.map(({ id, delay, title, message }) =>
      send(`${server}/${encodeURIComponent(topic)}/${id}`, {
        method: "POST",
        body: message,
        headers: { In: delay, Title: title, Priority: "urgent", Tags: "rotating_light" },
      }),
    ),
  );
  return results.every(Boolean);
}

async function tick(getSmtpReady, getInboundState) {
  if (!isEnabled()) return false;
  if (!mailHealthy(getSmtpReady(), getInboundState())) {
    console.warn("⚠️ HEARTBEAT: Mail is unhealthy, staying quiet so the watchdog trips");
    return false;
  }
  const [pinged, rescheduled] = await Promise.all([ping(), rescheduleNtfyAlerts()]);
  return pinged || rescheduled;
}

function start(getSmtpReady, getInboundState) {
  const timer = setInterval(() => tick(getSmtpReady, getInboundState), HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = {
  isEnabled,
  mailHealthy,
  ping,
  rescheduleNtfyAlerts,
  tick,
  start,
  HEARTBEAT_INTERVAL_MS,
};
