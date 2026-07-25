// Plain-language specification of the Legacy encryption scheme, embedded in
// the deadman trigger email (Issue #5). The design assumption is hostile to
// every dependency: the GitHub repo may be gone, the beneficiary's copy of
// the tool may not run on a future OS, and no 2026 runtime may exist. This
// text must therefore be sufficient for a competent stranger to reimplement
// decryption from scratch using any standard crypto library.
//
// Source of truth: Legacy_Encryption PROTOCOL-V2-SPEC.md. Payloads beginning
// with "LE2." are v2; anything else is v1. Keep BOTH descriptions forever.

const RECOVERY_SPEC_TEXT = `
HOW TO RECOVER — READ CAREFULLY, THERE IS NO TIME PRESSURE

1. You should already have a working copy of the Legacy decryption tool
   (USB drive and printed source). Open it on an OFFLINE computer, scan or
   paste the encrypted payload from this email, and enter the two passwords
   (yours and the one described to you previously). Nothing in this email is
   secret on its own — the payload is useless without the passwords.

2. If your copy of the tool no longer runs, any software engineer can
   rebuild decryption from the specification below using any mainstream
   cryptography library. Do NOT type the passwords into a website or share
   them with anyone who offers to "help recover" — run everything offline.

TECHNICAL SPECIFICATION OF THE ENCRYPTED PAYLOAD (Legacy protocol)

Version detection:
- If the payload string starts with "LE2." it is version 2.
- Otherwise it is version 1.

Common to both versions:
- Key derivation: PBKDF2-HMAC-SHA256, 600,000 iterations (v2 stores the
  exact count in its header), 16-byte random salt, output 32 bytes.
- Cipher: AES-256-GCM, 12-byte random IV (nonce), 16-byte authentication
  tag appended to the end of the ciphertext.
- Before encryption, 0 to 4 random padding bytes were appended to the
  UTF-8 seed phrase; the count is stored, strip that many bytes from the
  end of the decrypted plaintext.
- Two passwords are involved: the benefactor's and the beneficiary's,
  combined IN THAT ORDER into a single PBKDF2 input.

Version 1 format:
- Combined password = benefactor password + beneficiary password,
  concatenated directly (no separator), UTF-8.
- The payload is base64. Decode it once to get a string of four fields
  joined by "." (dots):  base64(salt) "." base64(iv) "." base64(ciphertext
  including tag) "." two-digit padding count (e.g. "03").
- Decode the three base64 fields, derive the key, AES-256-GCM decrypt
  (no associated data), strip padding, interpret as UTF-8.

Version 2 format ("LE2." prefix):
- Combined password = benefactor password, then byte 0x1F (the ASCII Unit
  Separator control character), then beneficiary password, UTF-8.
- Strip "LE2." and base64url-decode the rest (base64url: "-" and "_"
  instead of "+" and "/"; pad "=" back if your decoder needs it).
- The decoded binary body, all multi-byte integers big-endian:
    offset 0, 1 byte : version, must be 0x02
    offset 1, 1 byte : KDF id, 0x01 = PBKDF2-HMAC-SHA256
    offset 2, 4 bytes: PBKDF2 iteration count (uint32; reject values
                       outside 100,000..10,000,000 before deriving)
    offset 6, 1 byte : padding length (0..4)
    offset 7, 16 bytes: salt
    offset 23, 12 bytes: IV (GCM nonce)
    offset 35 onward : ciphertext with 16-byte GCM tag at the end
- AES-256-GCM decrypt with the first 35 bytes of the body passed as the
  GCM associated data (AAD). A failed authentication tag means a wrong
  password or a corrupted payload — it will not decrypt to garbage.

The decrypted plaintext is a BIP-39 seed phrase (space-separated English
words). Verify it against the BIP-39 word list, then follow standard
Bitcoin wallet recovery procedure with hardware you control.
`.trim();

// Always visible — no <details>/collapsible markup, which Gmail and other
// clients render inconsistently. This email must degrade gracefully
// everywhere, including printed on paper.
const RECOVERY_SPEC_HTML = `
  <div style="margin: 16px 0;">
    <p style="font-weight: bold;">Recovery instructions and full technical specification (keep with this message — printable):</p>
    <pre style="white-space: pre-wrap; font-size: 12px; background: #f4f4f4; padding: 12px; border-radius: 4px;">${RECOVERY_SPEC_TEXT}</pre>
  </div>
`;

module.exports = { RECOVERY_SPEC_TEXT, RECOVERY_SPEC_HTML };
