// Inbound reply parsing (v2.2.0). Pure functions over a mailparser
// `simpleParser` result — no I/O, so every client shape can be fixture-tested.
//
// Two rules hold always, both at once (spec "Threat model", item 1):
//   1. A code counts only when found OUTSIDE quoted material.
//   2. Any message carrying an auto-reply marker is discarded outright.
// A dead operator's vacation responder, or a helpdesk that quotes the
// original (code included) back at us, must not be able to keep a switch
// alive. Bounces are never replies either.

const { CODE_REGEX, normalizeCode, isValidCode } = require("./codes");

// ---- header helpers ---------------------------------------------------

// Raw header lines are the most reliable presence check: mailparser folds
// some headers (List-*) into structured fields and drops them from the Map.
function rawHeaderLines(parsed) {
  return Array.isArray(parsed && parsed.headerLines) ? parsed.headerLines : [];
}

function rawHeader(parsed, name) {
  const key = String(name).toLowerCase();
  const hit = rawHeaderLines(parsed).find((h) => h.key === key);
  if (!hit) return null;
  // "Name: value" → value (mailparser keeps the full line)
  const idx = hit.line.indexOf(":");
  return idx >= 0 ? hit.line.slice(idx + 1).trim() : hit.line.trim();
}

function hasRawHeader(parsed, name) {
  const key = String(name).toLowerCase();
  return rawHeaderLines(parsed).some((h) => h.key === key);
}

// Header value as a plain string whatever mailparser made of it (string,
// array, {value,text} object, or a structured address list).
function headerValue(headers, name) {
  if (!headers) return "";
  const key = String(name).toLowerCase();
  let v = null;
  if (typeof headers.get === "function") v = headers.get(key);
  else v = headers[key];
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => headerValue({ get: () => x }, key)).join(", ");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.value === "string") return v.value;
    if (Array.isArray(v.value)) return v.value.map((a) => a.address || "").join(", ");
    return "";
  }
  return String(v);
}

// ---- auto-replies and bounces ------------------------------------------

// `headers` may be the mailparser Map, or a whole parsed message (in which
// case raw header lines are consulted too).
function isAutoReply(input) {
  const parsed = input && Array.isArray(input.headerLines) ? input : null;
  const headers = parsed ? parsed.headers : input;
  const get = (name) => {
    const fromMap = headerValue(headers, name);
    if (fromMap) return fromMap;
    return parsed ? rawHeader(parsed, name) || "" : "";
  };
  const has = (name) =>
    (headers && typeof headers.has === "function" && headers.has(name)) ||
    (parsed && hasRawHeader(parsed, name));

  const autoSubmitted = get("auto-submitted").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (has("x-autoreply") || has("x-autorespond")) return true;
  if (has("x-auto-response-suppress")) return true;
  const precedence = get("precedence").trim().toLowerCase();
  if (/^(bulk|auto_reply|junk|list)$/.test(precedence)) return true;
  if (has("list-id")) return true;
  return false;
}

function fromAddress(parsed) {
  const v = parsed && parsed.from && parsed.from.value;
  const a = Array.isArray(v) && v[0] ? v[0].address : "";
  return String(a || "").trim().toLowerCase();
}

function isBounce(parsed) {
  const from = fromAddress(parsed);
  if (/^(mailer-daemon|postmaster)@/i.test(from)) return true;
  // Empty envelope sender (Return-Path: <>) is the DSN convention.
  const rp = parsed && parsed.headers ? parsed.headers.get("return-path") : null;
  if (rp && Array.isArray(rp.value) && rp.value.length && !rp.value[0].address) {
    return true;
  }
  const rawRp = rawHeader(parsed, "return-path");
  if (rawRp !== null && /^<\s*>$/.test(rawRp)) return true;
  const ct = headerValue(parsed && parsed.headers, "content-type").toLowerCase();
  if (ct.startsWith("multipart/report")) return true;
  return false;
}

// ---- HTML → text -----------------------------------------------------------

// Quote containers by client. Everything from the first one onward is
// dropped before conversion: replies in these clients are top-posted, and
// (Outlook especially) the quoted body is not wrapped in the marker element
// but follows it as siblings.
const HTML_QUOTE_START = [
  /<blockquote\b/i,
  /<div[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b/i,
  /<div[^>]*\bid\s*=\s*["'](?:x_)?divRplyFwdMsg["']/i,
  /<div[^>]*\bid\s*=\s*["'](?:x_)?appendonsend["']/i,
  /<div[^>]*\bclass\s*=\s*["'][^"']*\byahoo_quoted\b/i,
  /<div[^>]*\bclass\s*=\s*["'][^"']*\bprotonmail_quote\b/i,
  /<hr[^>]*\bid\s*=\s*["'](?:x_)?stopSpelling["']/i,
];

function stripQuotedHtml(html) {
  let cut = html.length;
  for (const re of HTML_QUOTE_START) {
    const m = re.exec(html);
    if (m && m.index < cut) cut = m.index;
  }
  return html.slice(0, cut);
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code =
        e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const k = e.toLowerCase();
    return k in ENTITIES ? ENTITIES[k] : m;
  });
}

function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, "\n");
  s = s.replace(/<hr\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/ /g, " ");
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- quote detection in text ----------------------------------------------

// Attribution lines that introduce a quote, possibly wrapped over up to
// three lines. English (Gmail, Apple Mail, Thunderbird, Proton) plus the
// French / German / Spanish variants: the code alphabet is fixed, the
// reader's language is not.
const ATTRIBUTION_END = [
  /^On\b[\s\S]{0,300}?\bwrote:\s*$/i,
  /^Le\b[\s\S]{0,300}?\ba écrit\s*:\s*$/i,
  /^Am\b[\s\S]{0,300}?\bschrieb\b[\s\S]{0,120}?:?\s*$/i,
  /^El\b[\s\S]{0,300}?\bescribió\s*:\s*$/i,
];
const ATTRIBUTION_START = /^(On|Le|Am|El)\b/i;

// Markers after which nothing can be trusted as the reader's own text.
function isHardMarker(line) {
  if (/^\s*-{2,}\s*(Original Message|Forwarded message|Mensaje original|Message d'origine|Ursprüngliche Nachricht)\s*-{2,}\s*$/i.test(line)) return true;
  if (/^\s*_{8,}\s*$/.test(line)) return true; // Outlook web / mobile
  return false;
}

// Outlook header block: "From:" followed within three lines by "Sent:" or
// "Date:" and "To:". Converted HTML may leave the labels bold-marked (*From:*).
function isOutlookHeaderBlock(lines, i) {
  const strip = (l) => String(l || "").replace(/^\s*[*_]*/, "");
  if (!/^(From|De|Von)\s*:/i.test(strip(lines[i]))) return false;
  let sawSent = false;
  let sawTo = false;
  for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
    const l = strip(lines[j]);
    if (/^(Sent|Date|Envoyé|Gesendet|Enviado)\s*:/i.test(l)) sawSent = true;
    if (/^(To|À|An|Para)\s*:/i.test(l)) sawTo = true;
  }
  return sawSent && sawTo;
}

// If an attribution starts at lines[i], return the index of its last line;
// else -1.
function attributionEnd(lines, i) {
  if (!ATTRIBUTION_START.test(lines[i].trim())) return -1;
  let joined = "";
  for (let k = 0; k < 3 && i + k < lines.length; k++) {
    joined = (joined ? joined + " " : "") + lines[i + k].trim();
    if (ATTRIBUTION_END.some((re) => re.test(joined))) return i + k;
    if (k > 0 && lines[i + k].trim() === "") return -1;
  }
  return -1;
}

// Text the reader actually typed. Quoted lines (leading ">") are dropped
// wherever they occur — so a bottom-posted or inline reply from a client that
// prefixes quotes (Thunderbird, Gmail plain text, Apple Mail) still yields
// its code. An attribution that introduces a ">"-prefixed block is dropped
// with it. Any marker that introduces an UNPREFIXED quote (Outlook's header
// block or separators, a bare "On … wrote:" with no ">" lines after it)
// cuts everything from that point on, because nothing below it can be
// distinguished from the quote.
function cutQuotes(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*>/.test(line)) {
      i++;
      continue;
    }
    if (isHardMarker(line) || isOutlookHeaderBlock(lines, i)) break;

    const end = attributionEnd(lines, i);
    if (end >= 0) {
      // Prefixed quote follows? Then only the attribution is dropped.
      let j = end + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\s*>/.test(lines[j])) {
        i = end + 1;
        continue;
      }
      break; // unprefixed quote follows: nothing below is trustworthy
    }
    out.push(line);
    i++;
  }
  return out.join("\n").trim();
}

// The reader's own text from a parsed message: plain-text part when
// present, otherwise HTML with quote containers removed and converted.
//
// mailparser synthesises `text` from the HTML when a message has no plain
// part, and that synthesis knows nothing about Outlook's quote containers —
// so an HTML-only message (top-level Content-Type text/html) takes the HTML
// path even though `text` is populated.
function visibleText(parsed) {
  let text = "";
  const topType = headerValue(parsed && parsed.headers, "content-type")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const html = parsed && typeof parsed.html === "string" ? parsed.html : "";
  const plain = parsed && typeof parsed.text === "string" ? parsed.text : "";
  if (topType === "text/html" && html.trim()) {
    text = htmlToText(stripQuotedHtml(html));
  } else if (plain.trim()) {
    text = plain;
  } else if (html.trim()) {
    text = htmlToText(stripQuotedHtml(html));
  }
  return cutQuotes(text);
}

// ---- code extraction ------------------------------------------------------

const CODE_REGEX_G = new RegExp(CODE_REGEX.source, "gi");

// Every distinct well-formed code candidate, subject before body. Within a
// source, a candidate written with a separator or containing a digit ranks
// ahead of a bare run of eight letters: an English word that happens to fit
// the alphabet ("STANDARD", "TRANSFER") must not shadow the real code typed
// after it. Document order breaks ties. The handler tries each candidate
// against the live codes in this order.
function extractCodes(subject, text) {
  const out = [];
  const seen = new Set();
  for (const src of [subject, text]) {
    const s = String(src || "");
    const found = [];
    CODE_REGEX_G.lastIndex = 0;
    let m;
    while ((m = CODE_REGEX_G.exec(s)) !== null) {
      const code = normalizeCode(m[0]);
      if (!isValidCode(code) || seen.has(code)) continue;
      seen.add(code);
      const separated = m[0].length > 8;
      const hasDigit = /[0-9]/.test(code);
      found.push({ code, score: (separated ? 2 : 0) + (hasDigit ? 1 : 0), idx: m.index });
    }
    found.sort((a, b) => b.score - a.score || a.idx - b.idx);
    out.push(...found.map((f) => f.code));
  }
  return out;
}

// First candidate or null.
function extractCode(subject, text) {
  const all = extractCodes(subject, text);
  return all.length ? all[0] : null;
}

module.exports = {
  isAutoReply,
  isBounce,
  fromAddress,
  visibleText,
  cutQuotes,
  stripQuotedHtml,
  htmlToText,
  extractCode,
  extractCodes,
  headerValue,
  rawHeader,
};
