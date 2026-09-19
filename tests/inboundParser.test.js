// Fixture tests for the inbound reply parser. Each .eml under
// tests/fixtures/inbound/ is a hand-written message in the shape a real
// client produces. The original check-in quoted in every fixture carried the
// OLD code H2WX-Q9TR; the reader typed K7M4-P2XQ. A fixture passes only when
// the typed code is found and the quoted one is not.
const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { simpleParser } = require("mailparser");
const {
  isAutoReply,
  isBounce,
  fromAddress,
  visibleText,
  cutQuotes,
  htmlToText,
  stripQuotedHtml,
  extractCode,
  extractCodes,
} = require("../utils/inboundParser");

const FIX = path.join(__dirname, "fixtures", "inbound");
const TYPED = "K7M4P2XQ";
const QUOTED = "H2WXQ9TR";

async function load(name) {
  return simpleParser(fs.readFileSync(path.join(FIX, name)));
}

// name → { code, autoReply, bounce, from }
const EXPECT = {
  "gmail-web.eml": { code: TYPED },
  "gmail-ios.eml": { code: TYPED },
  "gmail-android.eml": { code: TYPED },
  "outlook-desktop.eml": { code: TYPED },
  "outlook-web.eml": { code: TYPED, htmlOnly: true },
  "outlook-ios.eml": { code: TYPED },
  "apple-mail.eml": { code: TYPED },
  "thunderbird.eml": { code: TYPED },
  "proton-web.eml": { code: TYPED, htmlOnly: true, from: "op@proton.me" },
  "bottom-posted.eml": { code: TYPED },
  "inline-reply.eml": { code: TYPED },
  "quote-stripped.eml": { code: TYPED },
  "code-in-subject.eml": { code: TYPED },
  "code-lowercase-nohyphen.eml": { code: TYPED, candidates: [TYPED, "STANDARD"] },
  "code-trailing-period.eml": { code: TYPED },
  "gmail-fr.eml": { code: TYPED },
  "apple-de.eml": { code: TYPED },
  "gmail-es.eml": { code: TYPED },
  // Dropped by the header gate before any parsing. `code` here is what the
  // parser alone would find — showing exactly why BOTH rules must hold.
  "vacation.eml": { code: QUOTED, autoReply: true },
  "helpdesk-autoack-headers.eml": { code: QUOTED, autoReply: true },
  "list-mail.eml": { code: TYPED, autoReply: true },
  "bounce.eml": { code: null, bounce: true, autoReply: true },
  // Not marked as automatic: only the quote rule stands between this and a
  // false check-in.
  "helpdesk-autoack.eml": { code: null },
  "forward.eml": { code: null },
};

describe("fixtures", () => {
  test("every fixture on disk has an expectation", () => {
    const files = fs.readdirSync(FIX).filter((f) => f.endsWith(".eml"));
    for (const f of files) assert.ok(EXPECT[f], `no expectation for ${f}`);
    for (const f of Object.keys(EXPECT)) assert.ok(files.includes(f), `missing fixture ${f}`);
  });

  for (const [name, exp] of Object.entries(EXPECT)) {
    test(name, async () => {
      const parsed = await load(name);
      assert.strictEqual(isAutoReply(parsed), !!exp.autoReply, "isAutoReply");
      assert.strictEqual(isBounce(parsed), !!exp.bounce, "isBounce");
      assert.strictEqual(fromAddress(parsed), exp.from || (exp.bounce ? "mailer-daemon@mx.example.com" : "op@example.com"));
      if (exp.htmlOnly) {
        assert.strictEqual(parsed.headers.get("content-type").value, "text/html", "fixture must be HTML-only");
      }

      const text = visibleText(parsed);
      // The quoted original's code must never survive quote removal (in the
      // auto-reply fixtures it is not quoted at all — the header gate is
      // what drops those).
      if (!exp.autoReply && !exp.bounce) {
        assert.ok(!text.toUpperCase().replace(/-/g, "").includes(QUOTED), `quoted code leaked in ${name}:\n${text}`);
      }

      // What the handler would see, ignoring the auto-reply/bounce gates
      // (tested separately above) so the quote logic is exercised even on
      // messages those gates would have dropped.
      const code = extractCode(parsed.subject, text);
      assert.strictEqual(code, exp.code, `extractCode for ${name}:\n${text}`);
      if (exp.candidates) {
        assert.deepStrictEqual(extractCodes(parsed.subject, text), exp.candidates);
      }
    });
  }
});

describe("isAutoReply on bare header maps", () => {
  const map = (obj) => new Map(Object.entries(obj));
  test("Auto-Submitted: no is not an auto-reply", () => {
    assert.strictEqual(isAutoReply(map({ "auto-submitted": "no" })), false);
  });
  test("Auto-Submitted anything else is", () => {
    assert.strictEqual(isAutoReply(map({ "auto-submitted": "auto-replied" })), true);
    assert.strictEqual(isAutoReply(map({ "auto-submitted": "auto-generated" })), true);
  });
  test("X-Autoreply / X-Autorespond / X-Auto-Response-Suppress", () => {
    assert.strictEqual(isAutoReply(map({ "x-autoreply": "yes" })), true);
    assert.strictEqual(isAutoReply(map({ "x-autorespond": "1" })), true);
    assert.strictEqual(isAutoReply(map({ "x-auto-response-suppress": "OOF" })), true);
  });
  test("Precedence bulk|auto_reply|junk|list, not first-class", () => {
    for (const p of ["bulk", "auto_reply", "junk", "list", "Bulk"]) {
      assert.strictEqual(isAutoReply(map({ precedence: p })), true, p);
    }
    assert.strictEqual(isAutoReply(map({ precedence: "first-class" })), false);
  });
  test("List-Id", () => {
    assert.strictEqual(isAutoReply(map({ "list-id": "<x.example.com>" })), true);
  });
  test("plain human mail is not", () => {
    assert.strictEqual(isAutoReply(map({ from: "x@y", subject: "hi" })), false);
    assert.strictEqual(isAutoReply(map({})), false);
  });
});

describe("cutQuotes", () => {
  test("drops > lines in place, keeps text around them", () => {
    const t = "a\n> q1\n> q2\nb\n> q3\nc";
    assert.strictEqual(cutQuotes(t), "a\nb\nc");
  });
  test("attribution followed by > block is dropped with it", () => {
    const t = "typed\n\nOn Thu, Sep 18, 2026 at 2:01 PM X <x@y> wrote:\n\n> q\n> q\n\nafter";
    assert.strictEqual(cutQuotes(t), "typed\n\n\n\nafter".trim());
  });
  test("attribution followed by unprefixed text cuts everything after", () => {
    const t = "typed\n\nOn Thu, Sep 18, 2026 at 2:01 PM X <x@y> wrote:\nquoted body\nMORE";
    assert.strictEqual(cutQuotes(t), "typed");
  });
  test("wrapped attribution over two lines", () => {
    const t = "typed\nOn Thu, Sep 18, 2026 at 2:01 PM Deploy Deadman Switch <d@x>\nwrote:\nquoted";
    assert.strictEqual(cutQuotes(t), "typed");
  });
  test("Original Message separator", () => {
    assert.strictEqual(cutQuotes("typed\n-----Original Message-----\nFrom: x\nquoted"), "typed");
  });
  test("underscore separator", () => {
    assert.strictEqual(cutQuotes("typed\n________________________________\nFrom: x\nquoted"), "typed");
  });
  test("From:/Sent:/To: header block without separator", () => {
    assert.strictEqual(cutQuotes("typed\nFrom: A <a@x>\nSent: Thursday\nTo: b@x\nSubject: s\nquoted"), "typed");
    assert.strictEqual(cutQuotes("typed\nFrom: A <a@x>\nDate: Thursday\nTo: b@x\nquoted"), "typed");
  });
  test("a lone From: line in prose is not a marker", () => {
    assert.strictEqual(cutQuotes("From: my phone\nK7M4-P2XQ"), "From: my phone\nK7M4-P2XQ");
  });
  test("a sentence starting with On is not an attribution", () => {
    assert.strictEqual(cutQuotes("On my way, code is K7M4-P2XQ"), "On my way, code is K7M4-P2XQ");
  });
  test("localised attributions", () => {
    assert.strictEqual(cutQuotes("t\nLe jeu. 18 sept. 2026 à 14:01, X <x@y> a écrit :\nq"), "t");
    assert.strictEqual(cutQuotes("t\nAm 18.09.2026 um 14:01 schrieb X <x@y>:\nq"), "t");
    assert.strictEqual(cutQuotes("t\nEl jue, 18 sept 2026 a las 14:01, X (<x@y>) escribió:\nq"), "t");
  });
  test("CRLF input", () => {
    assert.strictEqual(cutQuotes("a\r\n> q\r\nb"), "a\nb");
  });
});

describe("html", () => {
  test("stripQuotedHtml cuts at the first quote container", () => {
    const h = '<div>typed</div><div class="gmail_quote"><blockquote>q</blockquote></div><div>after</div>';
    assert.strictEqual(htmlToText(stripQuotedHtml(h)), "typed");
    const o = '<div>typed</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: x</div><div>q</div>';
    assert.strictEqual(htmlToText(stripQuotedHtml(o)), "typed");
    const y = '<div>typed</div><div class="yahoo_quoted"><div>q</div></div>';
    assert.strictEqual(htmlToText(stripQuotedHtml(y)), "typed");
    const b = '<p>typed</p><blockquote type="cite">q</blockquote>';
    assert.strictEqual(htmlToText(stripQuotedHtml(b)), "typed");
  });
  test("htmlToText decodes entities and breaks on block tags", () => {
    assert.strictEqual(htmlToText("<p>a&nbsp;&amp;&#39;b&#x41;</p><div>c</div>"), "a &'bA\nc");
    assert.strictEqual(htmlToText("<style>p{}</style><p>x</p><br>y"), "x\n\ny");
    assert.strictEqual(htmlToText("<div>x</div>y"), "x\ny");
  });
  test("visibleText prefers the text part", () => {
    assert.strictEqual(visibleText({ text: "t", html: "<p>h</p>" }), "t");
    assert.strictEqual(visibleText({ text: "", html: "<p>h</p>" }), "h");
    assert.strictEqual(visibleText({}), "");
  });
});

describe("extractCode", () => {
  test("subject first", () => {
    assert.strictEqual(extractCode("Re: K7M4-P2XQ", "H2WX-Q9TR"), TYPED);
  });
  test("null when nothing matches", () => {
    assert.strictEqual(extractCode("Re: Deploy check-in — 18 Sep 2026 14:01 UTC", "thanks!"), null);
    assert.strictEqual(extractCode("", ""), null);
  });
  test("candidates are deduplicated and ordered", () => {
    assert.deepStrictEqual(extractCodes("k7m4-p2xq", "K7M4P2XQ and H2WX-Q9TR"), [TYPED, QUOTED]);
  });
  test("a separated or digit-bearing candidate outranks a bare word", () => {
    assert.deepStrictEqual(extractCodes("", "STANDARD then K7M4-P2XQ"), [TYPED, "STANDARD"]);
    assert.deepStrictEqual(extractCodes("", "TRANSFER then k7m4p2xq"), [TYPED, "TRANSFER"]);
    // two bare words keep document order
    assert.deepStrictEqual(extractCodes("", "TRANSFER STANDARD"), ["TRANSFER", "STANDARD"]);
    // subject still wins over body regardless of score
    assert.deepStrictEqual(extractCodes("STANDARD", "K7M4-P2XQ"), ["STANDARD", TYPED]);
  });
  test("Deploy's own subjects never yield a code", () => {
    for (const s of [
      "Deploy check-in — 18 Sep 2026 14:01 UTC",
      "URGENT: Deploy check-in overdue — 2 unanswered — 18 Sep 2026 14:01 UTC",
      "Confirm your first check-in to arm your Deploy switch — 18 Sep 2026 14:01 UTC",
      "op@example.com listed you as a trusted contact — please reply to confirm",
      "URGENT: op@example.com has stopped responding — action needed (reminder)",
      "WARNING: your Deploy replies are not being received — 18 Sep 2026 14:01 UTC",
    ]) {
      assert.strictEqual(extractCode(s, ""), null, s);
    }
  });
});
