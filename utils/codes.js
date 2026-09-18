// Reply codes (v2.2.0): the short code a reader types back to Deploy.
//
// The code IS the token. It is generated here, shown once in an email, and
// stored only as sha256(normalized code) in reply_codes. Nothing else about
// it lives anywhere — a leaked database yields no usable code.
//
// Alphabet: 30 symbols with no look-alikes (no 0/O, no 1/I/L), so a code read
// off a phone screen and typed on another device survives the trip. Eight
// symbols give ~39 bits; with the five-wrong-guesses lockout per live code
// (see userService.bumpFailedAttempts) brute force is not a concern.

const crypto = require("crypto");

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

// One symbol class, reused by every pattern below so they cannot drift.
const SYMBOL = "[2-9A-HJKMNP-TV-Z]";

// A code as it appears in free text: two groups of four, optionally joined by
// a single separator (hyphen, en/em dash, or a space — phone keyboards
// autocorrect "K7M4-P2XQ" into "K7M4- P2XQ" or "K7M4 -P2XQ", so the
// separator may also carry one stray space on either side). Case-insensitive
// because the reader may type it in lower case; word-bounded so it is not
// found inside a longer token. Never anchored: it is used to *find* codes.
const CODE_REGEX = new RegExp(
  `\\b(${SYMBOL}{4})(?:[ \\t]?[-\\u2013\\u2014][ \\t]?|[ \\t])?(${SYMBOL}{4})\\b`,
  "i",
);

// Cryptographically random code, unformatted (8 symbols, no hyphen).
function generateCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}

// Display form: XXXX-XXXX. Accepts formatted or raw input.
function formatCode(code) {
  const raw = normalizeCode(code);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

// Canonical form for hashing and comparison: upper case, every non
// alphanumeric character removed (hyphens, spaces, a trailing period, smart
// dashes, whatever a mail client wrapped around it). Does NOT validate —
// see isValidCode.
function normalizeCode(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// True when the normalized form is exactly one well-formed code.
function isValidCode(input) {
  const raw = normalizeCode(input);
  return new RegExp(`^${SYMBOL}{${CODE_LENGTH}}$`).test(raw);
}

// sha256 hex of the normalized code. This is what reply_codes stores.
function hashCode(code) {
  return crypto.createHash("sha256").update(normalizeCode(code)).digest("hex");
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  CODE_REGEX,
  generateCode,
  formatCode,
  normalizeCode,
  isValidCode,
  hashCode,
};
