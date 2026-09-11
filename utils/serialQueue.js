// Serialize async work per key.
//
// Written for the beneficiary contact passes, which are idempotent only
// against *committed* state: the decision to contact a recipient is "yes"
// until a row records that it happened, and that row is not written until
// the email send resolves. Two passes overlapping inside that window both
// decide "yes" and both send, so a beneficiary receives the same
// introduction two or three times from one edit.
//
// Rather than paper over it with a de-dupe on the send side, the passes are
// made non-overlapping: work for a given key waits for the previous work on
// that key to settle. Different keys still run concurrently.

function createSerialQueue() {
  const tails = new Map();

  // Run fn() after any previously queued work for this key has settled.
  // Returns fn's own promise, so callers see its result and its errors.
  function run(key, fn) {
    const previous = tails.get(key) || Promise.resolve();

    // A rejected predecessor must not reject everything queued behind it —
    // one failed pass should delay the next, not cancel it.
    const result = previous.catch(() => {}).then(() => fn());

    const tail = result.catch(() => {});
    tails.set(key, tail);

    tail.then(() => {
      // Drop the entry only if nothing queued behind us, so the map does not
      // retain one entry per key forever.
      if (tails.get(key) === tail) tails.delete(key);
    });

    return result;
  }

  // Number of keys with work in flight. Test/debug aid.
  function size() {
    return tails.size;
  }

  return { run, size };
}

module.exports = { createSerialQueue };
