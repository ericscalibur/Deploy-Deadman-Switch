const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  ALPHABET,
  CODE_LENGTH,
  CODE_REGEX,
  generateCode,
  formatCode,
  normalizeCode,
  isValidCode,
  hashCode,
} = require("../utils/codes");

describe("alphabet", () => {
  test("has no look-alike symbols (0/O, 1/I/L)", () => {
    for (const bad of ["0", "O", "1", "I", "L"]) {
      assert.ok(!ALPHABET.includes(bad), `alphabet must not contain ${bad}`);
    }
  });

  test("has 30 distinct upper-case symbols", () => {
    assert.strictEqual(ALPHABET.length, 30);
    assert.strictEqual(new Set(ALPHABET).size, 30);
    assert.strictEqual(ALPHABET, ALPHABET.toUpperCase());
  });

  test("CODE_REGEX symbol class matches exactly the alphabet", () => {
    for (let c = 48; c <= 90; c++) {
      const ch = String.fromCharCode(c);
      if (!/[0-9A-Z]/.test(ch)) continue;
      const probe = `${ch.repeat(4)}-${ch.repeat(4)}`;
      assert.strictEqual(
        CODE_REGEX.test(probe),
        ALPHABET.includes(ch),
        `symbol ${ch}`,
      );
    }
  });
});

describe("generateCode", () => {
  test("produces 8 symbols from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      assert.strictEqual(code.length, CODE_LENGTH);
      for (const ch of code) assert.ok(ALPHABET.includes(ch), ch);
      assert.ok(isValidCode(code));
    }
  });

  test("does not repeat across a batch", () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(generateCode());
    assert.strictEqual(seen.size, 500);
  });
});

describe("round trip", () => {
  test("generate → format → normalize gives the original", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      const shown = formatCode(code);
      assert.match(shown, /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      assert.strictEqual(normalizeCode(shown), code);
      assert.strictEqual(hashCode(shown), hashCode(code));
    }
  });

  test("formatCode accepts already-formatted input", () => {
    assert.strictEqual(formatCode("K7M4-P2XQ"), "K7M4-P2XQ");
    assert.strictEqual(formatCode("k7m4p2xq"), "K7M4-P2XQ");
  });
});

describe("normalizeCode", () => {
  const canonical = "K7M4P2XQ";
  const variants = {
    "lower case": "k7m4-p2xq",
    "no hyphen": "K7M4P2XQ",
    "trailing period": "K7M4-P2XQ.",
    "autocorrected spacing (space after hyphen)": "K7M4- P2XQ",
    "autocorrected spacing (space before hyphen)": "K7M4 -P2XQ",
    "space instead of hyphen": "K7M4 P2XQ",
    "en dash": "K7M4–P2XQ",
    "surrounding whitespace": "  K7M4-P2XQ \n",
    "wrapped in quotes": '"K7M4-P2XQ"',
  };
  for (const [name, input] of Object.entries(variants)) {
    test(name, () => {
      assert.strictEqual(normalizeCode(input), canonical);
      assert.strictEqual(hashCode(input), hashCode(canonical));
      assert.ok(isValidCode(input));
    });
  }

  test("empty and null input normalize to empty string", () => {
    assert.strictEqual(normalizeCode(""), "");
    assert.strictEqual(normalizeCode(null), "");
    assert.strictEqual(normalizeCode(undefined), "");
    assert.ok(!isValidCode(""));
  });

  test("hash is sha256 hex of the normalized form", () => {
    assert.match(hashCode("k7m4-p2xq"), /^[0-9a-f]{64}$/);
    assert.notStrictEqual(hashCode("K7M4-P2XQ"), hashCode("K7M4-P2XR"));
  });
});

describe("isValidCode", () => {
  test("rejects wrong length and look-alike symbols", () => {
    assert.ok(!isValidCode("K7M4-P2X"));
    assert.ok(!isValidCode("K7M4-P2XQ2"));
    assert.ok(!isValidCode("K7M4-P2XO")); // O
    assert.ok(!isValidCode("K7M4-P2X0")); // zero
    assert.ok(!isValidCode("K7M4-P2XI")); // I
    assert.ok(!isValidCode("K7M4-P2XL")); // L
    assert.ok(!isValidCode("K7M4-P2X1")); // one
  });

  test("the inert template code can never be valid", () => {
    assert.ok(!isValidCode("EXAM-PLE1"));
    assert.ok(!CODE_REGEX.test("EXAM-PLE1"));
  });
});

describe("CODE_REGEX in free text", () => {
  test("finds a hyphenated code in a sentence", () => {
    const m = "Here you go: K7M4-P2XQ. Thanks".match(CODE_REGEX);
    assert.ok(m);
    assert.strictEqual(normalizeCode(m[0]), "K7M4P2XQ");
  });

  test("finds lower-case and unhyphenated forms", () => {
    assert.strictEqual(normalizeCode("k7m4p2xq".match(CODE_REGEX)[0]), "K7M4P2XQ");
    assert.strictEqual(normalizeCode("k7m4-p2xq".match(CODE_REGEX)[0]), "K7M4P2XQ");
  });

  test("tolerates one stray space around the hyphen", () => {
    assert.strictEqual(normalizeCode("K7M4- P2XQ".match(CODE_REGEX)[0]), "K7M4P2XQ");
    assert.strictEqual(normalizeCode("K7M4 -P2XQ".match(CODE_REGEX)[0]), "K7M4P2XQ");
  });

  test("does not match inside a longer token", () => {
    assert.strictEqual("XK7M4P2XQ".match(CODE_REGEX), null);
    assert.strictEqual("K7M4P2XQ9".match(CODE_REGEX), null);
  });

  test("does not match across a line break or a bare space", () => {
    assert.strictEqual("K7M4\nP2XQ".match(CODE_REGEX), null);
    assert.strictEqual("K7M4 P2XQ".match(CODE_REGEX), null);
  });

  test("a word before a hyphenated code does not steal its first half", () => {
    const m = "then K7M4-P2XQ".match(CODE_REGEX);
    assert.strictEqual(normalizeCode(m[0]), "K7M4P2XQ");
  });
});
