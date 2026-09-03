# Deployment Notes

Operational failure modes seen in the field, their diagnostics, and remedies.

## Out-of-band alerting (ntfy) — set this up

Deploy's other channels share failure modes with the things they would need
to report: SMTP down means email can't say "email is down"; Tor down means
the dashboard can't say "Tor is down". ntfy push notifications are the
independent path (v2.1.0, `utils/notify.js`). Alerts cover: SMTP transporter
failure/recovery, check-in emails that could not be sent, consecutive missed
check-ins, the pre-fire warning going out, the switch firing (and delivery
failures), periodic-save failures, unresponsive beneficiary addresses, and a
deployed switch that was never armed.

**ntfy topics are unauthenticated — the topic name is the only secret.**
Anyone who learns it can read the alerts and post fake ones.

1. Generate a random, unguessable topic name:
   ```bash
   echo "deploy-$(openssl rand -hex 12)"
   ```
2. Set it in the Start9 Config UI ("ntfy Alert Topic"), or via env:
   `NTFY_TOPIC=deploy-xxxxxxxxxxxxxxxxxxxxxxxx` (optional `NTFY_SERVER` for a
   self-hosted ntfy; defaults to `https://ntfy.sh`).
3. Install the [ntfy app](https://ntfy.sh) on your phone and subscribe to the
   topic, with **Instant delivery in doze mode** enabled on Android.
4. Test:
   ```bash
   curl -d "test" "https://ntfy.sh/$NTFY_TOPIC"
   ```

With no topic configured, alerting is disabled and startup logs a warning.

## Arming requires the first check-in (v2.1.0)

Deploying a switch no longer starts the countdown. The switch holds in
**PENDING**: the first check-in email is sent immediately, and only clicking
its link arms the switch — proving the entire loop (email delivery, link
reachability over Tor, auth-free token handling) before a timer exists. A
pending switch cannot fire, cannot escalate, and re-sends its arming email
every check-in interval (plus ntfy nudges) until answered. Pending state
survives restarts (an active session with `expires_at IS NULL`).

Rationale: "no check-in received" only means "operator may be dead" when the
check-in channel is known to work. The 2026-09-03 Tor outage was a live
counterexample — the timer counted while the only door was locked.

## IPv6 ULA breaks outbound SMTP silently (2026-09-03)

### Failure mode

- The host's router hands out IPv6 **Unique Local Addresses** (`fd00::/8`) but
  the host has **no routable IPv6 path** to the internet.
- glibc's address-selection rules (RFC 6724 as implemented in `getaddrinfo`)
  treat a ULA as global scope, so AAAA lookups are **not** suppressed.
  `getent hosts smtp.gmail.com` may return an AAAA record only.
- Node 17+ defaults to **verbatim** DNS result ordering (older Node reordered
  IPv4 first). Node takes the v6 address and can never connect.

**Symptom:** `EAI_AGAIN` on `smtp.gmail.com` at startup, then
`❌ Failed to initialize primary email service`. DNS appears healthy;
web browsing from other machines works; email silently never works.

### Diagnostics

```bash
# What order does the resolver hand back addresses in?
# Healthy: IPv4 (A) records listed first.
getent ahosts smtp.gmail.com

# Does IPv6 actually route to the internet?
# If this hangs or fails while plain curl works, v6 is dead-end.
curl -6 --max-time 10 https://gmail.com
```

### Remedy in Deploy (application level)

`server.js` calls `dns.setDefaultResultOrder("ipv4first")` before any network
initialization. This restores the pre-Node-17 behavior for this process only
and makes Deploy correct on any host regardless of `gai.conf`. Do not remove
it as cleanup — the failure it prevents is invisible until the first email
matters.

### Remedy at host level (optional, informational)

Appending to `/etc/gai.conf`:

```
precedence ::ffff:0:0/96  100
```

makes glibc prefer IPv4 system-wide. After the change,
`getent ahosts smtp.gmail.com` returns IPv4 first and Deploy logs
`✅ Primary email transporter verified`.

**Caveats:**

- This is host-local state. It will **not** survive a reflash, a restore from
  backup, or migration to different hardware. The in-app `ipv4first` fix is
  the durable one; `gai.conf` only helps other software on the same host.
- Deploy deliberately does not modify `gai.conf` at install time — whether a
  service should rewrite host DNS policy is a decision for the operator, and
  on StartOS the platform may own that file.
