// Login and signup throttling (v2.3.0).
//
// Deploy is reached over Tor or behind Start9's proxy, so every request
// arrives from the same address and per-IP limits mean nothing. Two guards
// instead:
//   - per account: after 5 consecutive failures, each further attempt must
//     wait an exponentially growing delay (30 s, 60 s, … capped at 1 h);
//     a success resets it;
//   - global: at most MAX_CONCURRENT password derivations in flight, so a
//     flood of login/signup requests cannot occupy the server (PBKDF2 is
//     deliberately expensive) and delay check-in processing and timers.
// State is in memory; a restart forgives, which is acceptable for a
// single-operator server.

const FREE_FAILURES = 5;
const BASE_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = 2;

function createLoginGuard({ now = () => Date.now() } = {}) {
  const failures = new Map(); // key -> { count, nextAllowedAt }
  let inFlight = 0;

  function keyFor(account) {
    return String(account || "").trim().toLowerCase();
  }

  // ms the caller must still wait before this account may try again (0 = ok)
  function retryAfter(account) {
    const f = failures.get(keyFor(account));
    if (!f) return 0;
    return Math.max(0, f.nextAllowedAt - now());
  }

  function recordFailure(account) {
    const k = keyFor(account);
    const f = failures.get(k) || { count: 0, nextAllowedAt: 0 };
    f.count += 1;
    if (f.count >= FREE_FAILURES) {
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (f.count - FREE_FAILURES));
      f.nextAllowedAt = now() + delay;
    }
    failures.set(k, f);
    if (failures.size > 10000) failures.delete(failures.keys().next().value);
    return f.count;
  }

  function recordSuccess(account) {
    failures.delete(keyFor(account));
  }

  // Returns a release function, or null when too many are in flight.
  function acquire() {
    if (inFlight >= MAX_CONCURRENT) return null;
    inFlight += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        inFlight -= 1;
      }
    };
  }

  return { retryAfter, recordFailure, recordSuccess, acquire };
}

module.exports = { createLoginGuard, FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS, MAX_CONCURRENT };
