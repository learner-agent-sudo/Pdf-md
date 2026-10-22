// Redacts personal identifiers, sensitive personal data, and commercial terms
// from converted Markdown. Pattern-based and entirely in the browser.
//
// Each detected item becomes a labelled placeholder ([EMAIL], [AMOUNT],
// [PERSON 2] …) so the text stays readable, e.g. for pasting into an AI tool.
// A person keeps the same number throughout a document. In a comparison, both
// files share the numbering so the redline doesn't show false changes.
//
// Detection uses patterns, checksums, keyword lists, field labels ("Name:",
// "Tel:"), and table column headers. It is not AI: it can miss things (a name
// with no label or title in front of it) or over-remove. The page tells the
// user to review the result and lets them add their own words to remove.
//
// While the rules run, each match is swapped for a private-use token
// (U+E000 … U+E001) that contains no letters or digits. So no later rule can
// re-detect an earlier rule's output. Tokens become the visible placeholders
// at the very end.

const T_OPEN = "";
const T_CLOSE = "";
const TOKEN_RE = /([-]+)/g;

// Placeholder label -> noun for the "Removed: …" summary.
const LABEL_NOUN = {
  PERSON: "name", EMAIL: "email", PHONE: "phone number", ADDRESS: "address",
  "ID NUMBER": "ID number", "DATE OF BIRTH": "date of birth", "CARD NUMBER": "card number",
  "BANK ACCOUNT": "bank detail", "IP ADDRESS": "IP address", "PROFILE LINK": "profile link",
  "HEALTH INFO": "health detail", RELIGION: "religion detail", ETHNICITY: "ethnicity detail",
  SEXUALITY: "sexuality detail", "POLITICAL VIEWS": "political detail",
  "UNION MEMBERSHIP": "union detail", "BIOMETRIC DATA": "biometric/genetic detail",
  "CRIMINAL RECORD": "criminal-record detail",
  AMOUNT: "amount", RATE: "rate", TERMS: "commercial term", REDACTED: "custom term",
};

/**
 * Redact one or more texts with shared numbering.
 * opts: { pii, sensitive, commercial, terms: string[] }
 * Returns { texts, counts: {label: n}, total, rename(name) }. rename applies
 * the custom terms and detected names to a file name.
 */
export function redactTexts(texts, opts) {
  const ctx = newContext(opts);
  let out = texts.map((t) => t || "");
  // Emails/links first, so a custom term (a company name) inside one doesn't
  // break the match and leave the rest of the address behind.
  if (opts.pii) out = out.map((t) => redactEmailsAndLinks(t, ctx));
  out = out.map((t) => applyCustomTerms(t, ctx));
  if (opts.pii) {
    out = out.map((t) => redactPii(t, ctx));
    out = out.map((t) => propagateNames(t, ctx)); // once every text has been scanned
  } else if (opts.commercial) {
    out = out.map((t) => redactPaymentDetails(t, ctx)); // bank/card details are commercial too
  }
  if (opts.sensitive) out = out.map((t) => redactSensitive(t, ctx));
  if (opts.commercial) out = out.map((t) => redactCommercial(t, ctx));

  // Number people in reading order (detection order differs: tables first).
  const personNo = new Map();
  for (const t of out) {
    for (const [, idx] of t.matchAll(TOKEN_RE)) {
      const i = decodeIdx(idx);
      if (ctx.tokens[i].label === "PERSON" && !personNo.has(i)) personNo.set(i, personNo.size + 1);
    }
  }
  const counts = {};
  const finish = (t, count) =>
    t
      .replace(TOKEN_RE, (_, idx) => {
        const i = decodeIdx(idx);
        const tok = ctx.tokens[i];
        if (count) counts[tok.label] = (counts[tok.label] || 0) + 1;
        return tok.label === "PERSON" ? `[PERSON ${personNo.get(i) || "?"}]` : tok.text;
      })
      .replace(/[-]/g, ""); // stray pieces of a token cut by a later rule
  const final = out.map((t) => finish(t, true));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rename = (name) => finish(propagateNames(applyCustomTerms(name, ctx), ctx), false);
  return { texts: final, counts, people: personNo.size, total, rename };
}

/** "2 people (5 mentions) · 2 emails · 5 amounts" for the result card. */
export function describeCounts(counts, people = 0) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => {
      if (label === "PERSON" && people) {
        return `${people} ${people === 1 ? "person" : "people"} (${n} mention${n === 1 ? "" : "s"})`;
      }
      const noun = LABEL_NOUN[label] || label.toLowerCase();
      return `${n} ${n === 1 ? noun : plural(noun)}`;
    })
    .join(" · ");
}

function plural(noun) {
  if (/(?:ss|sh|ch|x)$/.test(noun)) return noun + "es";
  return noun + "s";
}

// --- Tokens & context --------------------------------------------------
function newContext(opts) {
  return {
    tokens: [], // [{ label, text }]
    byText: new Map(), // placeholder text -> token, so equal placeholders share one
    people: new Map(), // lower-cased name or name part -> person token (null = ambiguous)
    forms: new Map(), // name as written -> key into `people`
    singles: new Set(), // keys registered from a one-word name ("Mr Smith")
    personCount: 0,
    terms: (opts.terms || []).map((t) => t.trim()).filter((t) => t.length >= 2),
  };
}

function encodeIdx(i) {
  return [...String(i)].map((d) => String.fromCharCode(0xe010 + +d)).join("");
}
function decodeIdx(s) {
  return +[...s].map((c) => c.charCodeAt(0) - 0xe010).join("");
}

// A token whose visible text is `[LABEL]`, or a custom text such as `[PERSON 2]`.
function token(ctx, label, text = `[${label}]`) {
  let tok = ctx.byText.get(text);
  if (!tok) {
    tok = T_OPEN + encodeIdx(ctx.tokens.length) + T_CLOSE;
    ctx.tokens.push({ label, text });
    ctx.byText.set(text, tok);
  }
  return tok;
}

// Same person -> same [PERSON n]. The full name and its distinctive parts are
// remembered, so a later "Mr Smith" or "Smith" maps to "John Smith". A part
// shared by two different people ("John") is marked ambiguous and left alone.
function personToken(ctx, name) {
  const clean = name.replace(HONORIFIC_PREFIX_RE, "").replace(/\s+/g, " ").trim();
  const key = clean.toLowerCase();
  const parts = isCJK(clean) ? [] : clean.split(" ").map((p) => p.replace(/[.,]$/, "")).filter(isDistinctivePart);
  let tok = ctx.people.get(key);
  if (!tok && parts.length === 1) tok = ctx.people.get(parts[0].toLowerCase());
  if (!tok && parts.length > 1) {
    const known = parts.map((p) => p.toLowerCase()).filter((k) => ctx.singles.has(k) && ctx.people.get(k));
    if (known.length === 1) tok = ctx.people.get(known[0]);
  }
  if (!tok) tok = token(ctx, "PERSON", `[PERSON ${++ctx.personCount}]`);

  ctx.people.set(key, tok);
  if (clean.includes(" ") || isDistinctivePart(clean) || (isCJK(clean) && clean.length >= 2)) {
    ctx.forms.set(clean, key);
  }
  if (!clean.includes(" ")) ctx.singles.add(key);
  for (const p of parts) {
    const k = p.toLowerCase();
    const prev = ctx.people.get(k);
    if (prev === undefined) ctx.people.set(k, tok);
    else if (prev !== tok) ctx.people.set(k, null);
    ctx.forms.set(p, k);
  }
  return tok;
}

function isDistinctivePart(p) {
  const w = p.toLowerCase();
  return p.length >= 3 && !NAME_PARTICLES.has(w) && !AMBIGUOUS_NAMES.has(w) && !NOT_NAME.has(w);
}

// Replace every remaining mention of a known person (as written, or in caps).
function propagateNames(text, ctx) {
  const map = new Map();
  for (const [form, key] of ctx.forms) {
    const tok = ctx.people.get(key);
    if (!tok) continue;
    for (const f of [form, form.toUpperCase()]) if (!map.has(f)) map.set(f, tok);
  }
  if (!map.size) return text;
  const forms = [...map.keys()].sort((a, b) => b.length - a.length);
  const latin = forms.filter((f) => !isCJK(f)).map((f) => escapeRe(f).replace(/ /g, "\\s+"));
  const cjk = forms.filter(isCJK).map(escapeRe);
  const get = (m) => map.get(m.replace(/\s+/g, " ")) || m;
  if (latin.length) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${latin.join("|")})(?![\\p{L}\\p{N}])`, "gu"), get);
  }
  if (cjk.length) text = text.replace(new RegExp(cjk.join("|"), "gu"), get);
  // "John Smith" found as two separate parts -> one placeholder, not two.
  return text.replace(/([-]+)(?:[ \t]+\1)+/gu, "$1");
}

// --- Custom terms ------------------------------------------------------
function applyCustomTerms(text, ctx) {
  const terms = ctx.terms.map((t, i) => ({ t, n: i + 1 })).sort((a, b) => b.t.length - a.t.length);
  for (const { t, n } of terms) {
    const body = escapeRe(t).replace(/\s+/g, "\\s+");
    const pre = /^[\p{L}\p{N}]/u.test(t) && !isCJK(t[0]) ? "(?<![\\p{L}\\p{N}])" : "";
    const post = /[\p{L}\p{N}]$/u.test(t) && !isCJK(t.slice(-1)) ? "(?![\\p{L}\\p{N}])" : "";
    text = text.replace(new RegExp(pre + body + post, "giu"), () => token(ctx, "REDACTED", `[REDACTED ${n}]`));
  }
  return text;
}

// --- Helpers for labelled fields ---------------------------------------
// A label starts a line, a table cell, or a sentence, or follows a comma,
// semicolon, or wide gap: "Tel: …", "| Tel | …", "- **Tel:** …",
// "Name: … , Tel: …". It ends with a colon, or with the cell border in a
// two-column "| Label | Value |" table.
// (The wide-gap case matches only the last space of a run, so a long run of
// spaces can't make the regex backtrack quadratically.)
const LBL_PREFIX = String.raw`(?:^|[|,;(>]|[.!?。]\s|(?<=[ \t])[ \t](?![ \t])|\t(?![ \t]))\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?`;
const LBL_SEP = String.raw`(?:\*\*|__)?\s*(?:[:：]|\|)\s*(?:\*\*|__)?\s*`;

// Like String.replace, but `fn(rest, match)` also sees the rest of the line
// after each match, and returns [lengthOfRestConsumed, replacement,
// replaceMatchToo] or null. The rest stays available for further matches.
function replaceWithTail(text, re, fn) {
  let out = "";
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const nl = text.indexOf("\n", start);
    const r = fn(text.slice(start, nl < 0 ? text.length : nl), m);
    if (r) {
      out += text.slice(last, r[2] ? m.index : start) + r[1];
      last = start + r[0];
      re.lastIndex = last;
    } else if (!m[0].length) {
      re.lastIndex++;
    }
  }
  return out + text.slice(last);
}

// Run `fn(value, match)` on what follows any of `labels`; fn returns
// [len, replacement] or null. A table's header row ("| Owner | ARR |") holds
// column titles, not label/value pairs, so it is skipped.
function labelled(text, labels, fn) {
  const re = new RegExp(`${LBL_PREFIX}(${labels})${LBL_SEP}`, "gimu");
  const headers = tableHeaderStarts(text);
  return replaceWithTail(text, re, (rest, m) => {
    if (headers.size && headers.has(text.lastIndexOf("\n", m.index) + 1)) return null;
    const r = fn(rest, m);
    return r && r[0] > 0 ? r : null;
  });
}

// A field's value: up to the end of its cell, line, or clause.
function fieldValue(rest) {
  return rest.match(/^[^|\n;]*/)[0].trimEnd();
}

// --- Personal identifiers ----------------------------------------------
const NAME_LABELS = String.raw`full name|legal name|name|contact person|contact name|contact|attn|attention|signed by|signed|signatory|signature|witness|employee name|employee|staff name|prepared by|approved by|reviewed by|authored by|author|submitted by|requested by|recipient|client name|customer name|patient name|patient|applicant|candidate|tenant|guarantor|beneficiary|account holder|card ?holder|owner|account manager|project manager|manager|sponsor|assignee|responsible|point of contact|poc|lead|by|姓名|联系人|聯絡人|签署人|簽署人|负责人|負責人|申请人|申請人`;
const DOB_LABELS = String.raw`date of birth|d\.?o\.?b\.?|birth ?date|birthday|出生日期|出生年月|生日`;
const ID_LABELS = String.raw`passport(?: no\.?| number| #)?|(?:hk)?id(?: card)?(?: no\.?| number| #)?|identity card(?: no\.?| number)?|hkid|nric|ssn|social security(?: no\.?| number)?|national insurance(?: no\.?| number)?|ni(?: no\.?| number)|nino|tax (?:id|file number|identification number|no\.?)|tin|driver'?s? licen[cs]e(?: no\.?| number)?|employee (?:id|no\.?|number)|staff (?:id|no\.?|number)|member(?:ship)? (?:id|no\.?|number)|patient (?:id|no\.?|number)|身份证(?:号码)?|身份證(?:號碼)?|护照(?:号码)?|護照(?:號碼)?|证件号码|證件號碼`;
const BANK_LABELS = String.raw`(?:bank )?account(?: no\.?| number| #)|bank account|a\/c(?: no\.?)?|acct\.?(?: no\.?)?|iban|sort code|routing(?: no\.?| number)?|aba|账号|帳號|账户|賬戶|银行账号|銀行賬號|户口号码|戶口號碼`;
const PHONE_LABELS = String.raw`tel(?:ephone)?(?: no\.?)?|phone(?: no\.?| number)?|mobile(?: no\.?| number)?|mob|cell(?:phone)?|fax|whatsapp|contact (?:no\.?|number)|direct line|电话|電話|手机|手機|传真|傳真|联系电话|聯絡電話`;
const ADDRESS_LABELS = String.raw`(?:home |residential |mailing |postal |correspondence |registered |business |office )?address|地址|住址|通讯地址|通訊地址`;

const DATE_RE = /^(?:\d{1,4}\s?[\/.\-年]\s?\d{1,2}\s?[\/.\-月]\s?\d{1,4}日?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/;
const ID_VALUE_RE = /^[A-Z0-9]*\d[A-Z0-9]*(?:[ \-\/.][A-Z0-9]*\d[A-Z0-9]*)*(?:\s?\([A-Z0-9]\))?/i;

const STREET_SUFFIX = "Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Square|Sq|Terrace|Crescent|Highway|Hwy|Parkway|Pkwy|Close|Way|Gardens|Row|Walk|Circle";
const STREET_RE = new RegExp(
  String.raw`\b\d{1,5}[A-Za-z]?(?:[ \t]+\p{Lu}[\p{L}'’.\-]*){1,4}[ \t]+(?:${STREET_SUFFIX})\b\.?` +
    String.raw`(?:[ \t]+(?:North|South|East|West|Central|N|S|E|W|NE|NW|SE|SW)\b)?` +
    String.raw`(?:,[ \t]*(?:(?:Suite|Ste|Unit|Apt|Apartment|Flat|Floor|Fl|Room|Rm|#)\.?[ \t]*[\w\-]+` +
    String.raw`|\p{Lu}[\p{L}.'’\-]*(?:[ \t]+\p{Lu}[\p{L}.'’\-]*){0,3}(?:[ \t]+\d{4,6}(?:-\d{4})?)?` +
    String.raw`|[A-Z]{1,2}\d[A-Z\d]?[ \t]\d[A-Z]{2}|\d{4,6}(?:-\d{4})?)){0,4}`,
  "gu"
);
// Hong Kong style: "Flat 3A, 12/F, Some Building, 8 Some Road, Kowloon".
const UNIT_RE = /(?:\b(?:Flat|Room|Rm|Unit|Suite|Shop)\.?[ \t]+[A-Z0-9\-]{1,6},?[ \t]*)?\b(?:\d{1,3}|[GLU])\/F\b(?:,[ \t]*[\p{Lu}\d][^,\n|.;]{0,50}){0,5}/gu;

const PERSON_COL_RE = /^(?:(?:full |legal |first |last |given |family |sur)?name|(?:employee|staff|contact|client|customer|candidate|applicant|patient|member|person|team member|owner|lead|manager|assignee|responsible|signatory|author|reviewer|approver|prepared by|approved by|reviewed by|point of contact|poc|account manager|sales rep|representative|reports to|direct report)(?: name)?|姓名|名字|联系人|聯絡人|负责人|負責人|员工|員工)$/i;
const PII_COLUMNS = [
  [/e-?mail|邮箱|郵箱|电邮|電郵|邮件|郵件/i, "EMAIL"],
  [/phone|mobile|\btel\b|\bcell\b|\bfax\b|whatsapp|电话|電話|手机|手機/i, "PHONE"],
  [/date of birth|\bdob\b|birth ?date|birthday|出生日期|生日/i, "DATE OF BIRTH"],
  [/passport|\bid (?:no|number|card)|identity|\bhkid\b|\bssn\b|social security|national (?:id|insurance)|\bnric\b|employee (?:id|no)|staff (?:id|no)|身份证|身份證|护照|護照|证件|證件/i, "ID NUMBER"],
  [/^(?:home |residential |mailing |postal |correspondence )?address$|^地址$|住址/i, "ADDRESS"],
  [/bank account|account (?:no|number)|\biban\b|a\/c|账号|帳號|账户|賬戶/i, "BANK ACCOUNT"],
];

function redactEmailsAndLinks(text, ctx) {
  // Unwrap mailto:/tel: links so the address isn't left behind in the URL.
  text = text.replace(/\[([^\]\n]*)\]\((?:mailto|tel):[^)\s]*\)/gi, "$1");
  // Emails (Turndown escapes "_" as "\_") and social-profile links.
  text = text.replace(/(?:[\w.%+-]|\\_)+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, () => token(ctx, "EMAIL"));
  return text.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in|facebook\.com|instagram\.com|twitter\.com|x\.com|github\.com|t\.me|wa\.me)\/[^\s)\]|>]+/gi,
    () => token(ctx, "PROFILE LINK")
  );
}

function redactPii(text, ctx) {
  // Labelled fields: date of birth, ID numbers, bank details, phones, addresses.
  text = labelled(text, DOB_LABELS, (rest) => {
    const v = fieldValue(rest);
    const d = (v.match(DATE_RE) || [])[0] || (/\d/.test(v) && v.length <= 30 ? v : "");
    return d ? [d.length, token(ctx, "DATE OF BIRTH")] : null;
  });
  text = text.replace(/\b(born (?:on )?)(\d[^\n,;|]{4,25}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})/g, (m, pre, rest) => {
    const d = rest.match(DATE_RE);
    return d ? pre + token(ctx, "DATE OF BIRTH") + rest.slice(d[0].length) : m;
  });
  text = labelled(text, ID_LABELS, (rest) => {
    const m = rest.match(ID_VALUE_RE);
    return m ? [m[0].length, token(ctx, "ID NUMBER")] : null;
  });
  text = redactPaymentDetails(text, ctx);
  text = labelled(text, PHONE_LABELS, (rest) => {
    const m = rest.match(/^\+?[\d(][\d\s().\-\/]{5,22}\d/);
    return m && digits(m[0]) >= 7 ? [m[0].length, token(ctx, "PHONE")] : null;
  });
  text = labelled(text, ADDRESS_LABELS, (rest) => {
    const v = fieldValue(rest);
    return v && (/\d/.test(v) || isCJK(v)) ? [v.length, token(ctx, "ADDRESS")] : null;
  });

  // Government ID numbers, validated by checksum where one exists.
  text = text.replace(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, () => token(ctx, "ID NUMBER")); // US SSN
  text = text.replace(/\b([A-Z]{1,2}\d{6})\s?(?:\(([\dA])\)|([\dA])(?![\w(]))/g, (m, body, c1, c2) =>
    validHkid(body, c1 || c2) ? token(ctx, "ID NUMBER") : m
  );
  text = text.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, (m) => (validCnId(m) ? token(ctx, "ID NUMBER") : m));
  text = text.replace(/\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g, () =>
    token(ctx, "ID NUMBER")
  ); // UK National Insurance
  text = text.replace(/\b[STFGM]\d{7}[A-Z]\b/g, () => token(ctx, "ID NUMBER")); // Singapore NRIC/FIN

  // Phone numbers.
  const phone = (m) => (digits(m) >= 8 && digits(m) <= 15 ? token(ctx, "PHONE") : m);
  text = text.replace(/(?<![\w+])\+\d{1,3}[\s.\-]?(?:\(\d{1,4}\)[\s.\-]?)?\d{1,5}(?:[\s.\-]?\d{2,5}){1,4}(?!\w)/g, phone);
  text = text.replace(/(?<!\w)\(\d{2,4}\)\s?\d{3,4}[\s.\-]?\d{3,4}(?!\w)/g, phone);
  text = text.replace(/\b\d{3}[.\-\s]\d{3}[.\-]\d{4}\b/g, phone); // 555-123-4567
  text = text.replace(/\b[4-9]\d{3} \d{4}\b/g, phone); // Hong Kong "9123 4567"
  text = text.replace(/(?<!\d)1[3-9]\d(?:[\s\-]?\d{4}){2}(?!\d)/g, phone); // mainland China mobile

  // IPv4 addresses — but not clause numbers like "1.2.3.4 Definitions".
  text = text.replace(
    /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g,
    (m, offset, whole) => {
      const before = whole.slice(whole.lastIndexOf("\n", offset) + 1, offset);
      if (/^[\s#>*_\-+|]*$/.test(before)) return m;
      if (/(?:clause|section|article|para(?:graph)?|cl\.|§|version|ver\.|release|build|firmware)\s*$/i.test(before)) return m;
      return token(ctx, "IP ADDRESS");
    }
  );

  // Street addresses and postcodes.
  text = text.replace(UNIT_RE, () => token(ctx, "ADDRESS"));
  text = text.replace(STREET_RE, () => token(ctx, "ADDRESS"));
  text = text.replace(/\bP\.?\s?O\.?\s?Box\s+\d+/gi, () => token(ctx, "ADDRESS"));
  text = text.replace(/\b[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}\b/g, () => token(ctx, "ADDRESS")); // UK postcode
  text = text.replace(/[一-鿿]{1,8}(?:路|街|道|巷|弄)\s?\d{1,5}\s?(?:号|號)(?:[一-鿿\dA-Za-z\-]{0,12}?(?:室|楼|樓|层|層|座))?/gu, () =>
    token(ctx, "ADDRESS")
  );

  // Table columns whose header says what they hold.
  text = mapTableColumns(text, (header) => {
    if (PERSON_COL_RE.test(header)) return (cell) => replaceNamesInCell(cell, ctx);
    const kind = PII_COLUMNS.find(([re]) => re.test(header));
    return kind ? (cell) => (isBlankCell(cell) ? cell : keepSpace(cell, token(ctx, kind[1]))) : null;
  });

  // Names: after labels ("Name:", "Signed by:"), titles, greetings, sign-offs.
  text = labelled(text, NAME_LABELS, (rest, m) => {
    const lead = rest.match(/^(?:\*\*|__)?/)[0];
    const name = takeFullName(rest.slice(lead.length));
    if (!name || (/^by$/i.test(m[1]) && !name.includes(" "))) return null; // "By: Order of …"
    return [lead.length + name.length, lead + personToken(ctx, name)];
  });
  // A PDF table loses its borders and colons: a line that is just "Name John A. Smith".
  const bareLabel = String.raw`full name|name|contact person|signed by|signatory|prepared by|approved by|reviewed by|姓名|联系人|聯絡人`;
  text = replaceWithTail(text, new RegExp(String.raw`^[ \t]*(?:\*\*|__)?(?:${bareLabel})(?:\*\*|__)?[ \t]+`, "gimu"), (rest) => {
    const name = takeFullName(rest);
    return name && /\s/.test(name) && name.length === rest.trimEnd().length ? [name.length, personToken(ctx, name)] : null;
  });
  text = replaceWithTail(text, new RegExp(String.raw`\b(?:${HONORIFICS})\.?[ \t]+`, "gu"), (rest) => {
    const name = takeName(rest);
    return name ? [name.length, personToken(ctx, name), true] : null;
  });
  text = replaceWithTail(text, /^[ \t]*(?:Dear|Hi|Hello|Attn\.?|Attention)[ \t]+/gimu, (rest) => {
    const name = takeName(rest);
    return name && /^\s*(?:[,:!]|$)/.test(rest.slice(name.length)) ? [name.length, personToken(ctx, name)] : null;
  });
  text = text.replace(/([一-鿿])(先生|小姐|太太)/gu, (m, surname) =>
    "位们們各这這那每".includes(surname) ? m : personToken(ctx, m)
  );
  return redactSignOffs(text, ctx);
}

// "Best regards,\n\nJohn Smith" — the name on the line(s) after a sign-off.
function redactSignOffs(text, ctx) {
  const lines = text.split("\n");
  const signOff = /^(?:(?:best|kind|warm|warmest)\s+regards|regards|sincerely|yours\s+(?:sincerely|faithfully|truly)|thanks|thank you|cheers|best),?$/i;
  for (let i = 0; i < lines.length; i++) {
    if (!signOff.test(lines[i].trim())) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      const t = lines[j].trim().replace(/^(\*\*|__)(.*)\1$/, "$2");
      if (!t) continue;
      const name = takeName(t);
      if (name && name.length === t.length) lines[j] = lines[j].replace(t, personToken(ctx, name));
      break;
    }
  }
  return lines.join("\n");
}

// Bank accounts, IBANs, and payment cards (run for both PII and commercial).
function redactPaymentDetails(text, ctx) {
  text = labelled(text, BANK_LABELS, (rest) => {
    const m = rest.match(ID_VALUE_RE);
    return m && digits(m[0]) >= 4 ? [m[0].length, token(ctx, "BANK ACCOUNT")] : null;
  });
  text = labelled(text, String.raw`swift(?: code)?|bic`, (rest) => {
    const m = rest.match(/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/);
    return m ? [m[0].length, token(ctx, "BANK ACCOUNT")] : null;
  });
  text = text.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, (m) => {
    // Back off trailing groups that aren't part of the IBAN (e.g. a following word).
    for (let s = m; s.replace(/ /g, "").length >= 15; s = s.replace(/ ?[A-Z0-9]{1,4}$/, "")) {
      if (validIban(s)) return token(ctx, "BANK ACCOUNT") + m.slice(s.length);
    }
    return m;
  });
  text = text.replace(
    /(?<![\d-])(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5})(?![\d-])/g,
    (m) => {
      const d = m.replace(/\D/g, "");
      const issuer = /^[3456]/.test(d) || (+d.slice(0, 6) >= 222100 && +d.slice(0, 6) <= 272099);
      return d.length >= 13 && d.length <= 19 && issuer && luhn(d) ? token(ctx, "CARD NUMBER") : m;
    }
  );
  return text;
}

// --- Sensitive personal data -------------------------------------------
// Special-category data (GDPR art. 9/10 and similar laws). A whole sentence
// or table cell that mentions one of these is removed, since the keyword alone
// rarely carries the detail. Generic statements that list several categories
// ("…regardless of race, religion, or disability") are policy text, not data
// about a person, so they're kept.
const SENSITIVE = [
  ["HEALTH INFO", String.raw`diagnos(?:ed|is|es)|medical (?:condition|conditions|history|record|records|certificate|treatment|notes?|report)|health (?:condition|conditions|record|records)|mental (?:illness|health (?:condition|issue|issues|problem|problems|diagnosis))|mentally ill|pregnan(?:t|cy)|miscarriage|on (?:sick|medical|maternity|disability) leave|sick note|doctor'?s note|medication|prescribed|hospitali[sz](?:ed|ation)|chemotherapy|psychiatr(?:ic|ist)|psychologist|therapist|cancer|tumou?r|diabetes|diabetic|hiv|asthma|epilep(?:sy|tic)|depression|anxiety disorder|bipolar|schizophreni[ac]|autism|autistic|adhd|dementia|allerg(?:y|ies|ic)|blood type|vaccination status|tested positive|disabled|disabilit(?:y|ies)|injured`, "疾病|病史|病假|患有|诊断|診斷|确诊|確診|怀孕|懷孕|残疾|殘疾|精神病|抑郁|抑鬱|癌症|糖尿病|艾滋|住院|手术|手術"],
  ["RELIGION", String.raw`religion|religious (?:belief|beliefs|affiliation|views)|christian|muslim|islamic|jewish|hindu|buddhist|catholic|protestant|sikh|atheist|agnostic|attends (?:church|mosque|temple|synagogue)`, "宗教|信仰|基督徒|天主教|佛教徒|穆斯林|伊斯兰|伊斯蘭|回教"],
  ["ETHNICITY", String.raw`ethnicity|ethnic (?:origin|background|group|minority)|racial (?:origin|background)|skin colou?r|caucasian|hispanic|latino|latina`, "种族|種族|族裔|少数民族|少數民族"],
  ["SEXUALITY", String.raw`sexual (?:orientation|preference|life)|sex life|gay|lesbian|bisexual|homosexual|heterosexual|transgender|non-binary|lgbtq?`, "性取向|同性恋|同性戀|双性恋|雙性戀|跨性别|跨性別"],
  ["POLITICAL VIEWS", String.raw`political (?:opinion|opinions|views|affiliation|party|beliefs?|activity)|party member(?:ship)?|member of the (?:\w+ ){1,3}party|voted for`, "政治立场|政治立場|政治观点|政治觀點|党员|黨員|政党|政黨|共产党|共產黨"],
  ["UNION MEMBERSHIP", String.raw`trade union|labou?r union|union member(?:ship)?|member of (?:the |a )?union`, "工会会员|工會會員|工会成员|工會成員"],
  ["BIOMETRIC DATA", String.raw`biometric(?:s| data)?|fingerprints?|facial recognition|retina scan|iris scan|genetic (?:data|test|testing|information|condition)|dna (?:test|sample|profile)`, "指纹|指紋|基因|生物识别|生物識別|人脸识别|人臉識別"],
  ["CRIMINAL RECORD", String.raw`criminal (?:record|records|history|conviction|convictions|offen[cs]es?|charges?|background)|convicted|arrested|imprisoned|prison sentence|jailed|on parole|on bail|sex offender|police record`, "犯罪记录|犯罪記錄|刑事|前科|被捕|判刑|坐牢|入狱|入獄"],
].map(([label, en, zh]) => [label, new RegExp(String.raw`\b(?:${en})\b|${zh}`, "iu")]);

// Field labels / column headers that announce a special-category value.
const SENSITIVE_LABELS = [
  ["HEALTH INFO", /^(?:medical (?:condition|conditions|history|notes|information|records?)|health (?:condition|conditions|records?)|diagnos[ie]s|disabilit(?:y|ies)|allerg(?:y|ies)|blood type|健康状况|健康狀況|病史|残疾|殘疾|血型)$/i],
  ["RELIGION", /^(?:religion|religious (?:belief|beliefs|affiliation)|faith|宗教|宗教信仰|信仰)$/i],
  ["ETHNICITY", /^(?:ethnicity|ethnic (?:origin|group|background)|race|racial origin|民族|种族|種族|族裔)$/i],
  ["SEXUALITY", /^(?:sexual orientation|sexuality|性取向)$/i],
  ["POLITICAL VIEWS", /^(?:political (?:affiliation|party|views|opinions?|beliefs?)|政治面貌|政治立场|政治立場)$/i],
  ["UNION MEMBERSHIP", /^(?:union membership|trade union(?: membership)?|工会|工會)$/i],
  ["BIOMETRIC DATA", /^(?:biometrics?(?: data)?|fingerprints?|genetic (?:data|information)|指纹|指紋|基因)$/i],
  ["CRIMINAL RECORD", /^(?:criminal (?:record|records|history|convictions?)|convictions?|犯罪记录|犯罪記錄|前科)$/i],
];
const POLICY_RE = /discriminat|regardless of|irrespective of|on the basis of|on grounds of|special categor|equal (?:opportunit|employment)|protected characteristic|歧视|歧視|不论|不論|无论|無論/i;

function sensitiveLabel(text) {
  const t = plainCell(text);
  const hit = SENSITIVE_LABELS.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

function redactSensitive(text, ctx) {
  text = mapTableColumns(text, (header) => {
    const label = sensitiveLabel(header);
    return label ? (cell) => (isBlankCell(cell) ? cell : keepSpace(cell, token(ctx, label))) : null;
  });
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableSep(line) || isColumnHeader(lines, i)) continue; // column titles aren't data
    lines[i] = isTableRow(line) ? redactSensitiveRow(line, ctx) : redactSensitiveText(line, ctx);
  }
  return lines.join("\n");
}

// A table row: "| Religion | Buddhist |" keeps the label cell and removes the
// value; any other cell is checked like a sentence.
function redactSensitiveRow(line, ctx) {
  const parts = splitRow(line);
  for (let c = 1; c < parts.length - 1; c++) {
    const label = sensitiveLabel(parts[c]);
    if (!label) {
      parts[c] = redactSensitiveText(parts[c], ctx);
    } else if (c + 1 < parts.length - 1) {
      if (!isBlankCell(parts[c + 1])) parts[c + 1] = keepSpace(parts[c + 1], token(ctx, label));
      c++;
    }
  }
  return parts.join("|");
}

// Check each sentence of a line, keeping list/heading markers. Tracked-change
// markers ({++ ++}, {-- --}, {>> <<} …) also split the text, so a removed
// sentence never takes half of an insertion or comment with it.
function redactSensitiveText(line, ctx) {
  const prefix = line.match(/^\s*(?:(?:[-*+>]|#{1,6}|\d+[.)])\s+)*/)[0];
  const pieces = line
    .slice(prefix.length)
    .split(/((?<=[.!?])\s+|(?<=[。！？；])|\{\+\+|\+\+\}|\{--|--\}|\{>>|<<\}|\{==|==\}|\{~~|~>|~~\})/);
  for (let k = 0; k < pieces.length; k += 2) pieces[k] = redactSensitiveSentence(pieces[k], ctx);
  return prefix + pieces.join("");
}

function redactSensitiveSentence(seg, ctx) {
  // Keep surrounding emphasis markers, spaces, and end punctuation.
  const open = seg.match(/^(?:\s|\*\*|__|~~|[*_`])*/)[0];
  const rest = seg.slice(open.length);
  const close = rest.slice(trimTrailing(rest, /[\s.!?。！？:;,*_`~]/).length);
  const core = rest.slice(0, rest.length - close.length);
  if (!core) return seg;

  // "Religion: Buddhist" — keep the label, remove the value.
  const lv = core.match(/^([^:：]{1,40}?[:：](?:\*\*|__)?\s*)(\S.*)$/u);
  const label = lv && sensitiveLabel(lv[1].replace(/[:：](?:\*\*|__)?\s*$/, ""));
  if (label) return open + lv[1] + token(ctx, label) + close;

  const hits = SENSITIVE.filter(([, re]) => re.test(core)).map(([l]) => l);
  if (!hits.length || hits.length >= 3 || POLICY_RE.test(core)) return seg;
  return open + token(ctx, hits[0]) + close;
}

// `s` without its trailing run of characters matching `re` (one char at a
// time, so a long run can't cause regex backtracking).
function trimTrailing(s, re) {
  let i = s.length;
  while (i && re.test(s[i - 1])) i--;
  return s.slice(0, i);
}

// --- Commercial terms --------------------------------------------------
const NUM = String.raw`\d{1,3}(?:[,.'  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?`;
const MAG = String.raw`(?:\s?(?:thousand|million|billion|trillion|mn|bn|mm|k|m|b)(?![\p{L}\d])|\s?(?:百万|百萬|万|萬|亿|億|千))?`;
const CUR_CODES = "USD|EUR|GBP|HKD|CNY|RMB|JPY|SGD|AUD|CAD|NZD|CHF|INR|KRW|TWD|MYR|THB|IDR|PHP|AED|SAR|ZAR|SEK|NOK|DKK|MXN|BRL";
const CUR_BEFORE = String.raw`(?:US|U\.S\.|HK|NZ|NT|S|A|C|AU|CA|R)?\$|€|£|¥|￥|₹|₩|₱|฿|₫|₪|₺|₦|₽|Rs\.?|(?:${CUR_CODES}|人民币|人民幣|港币|港幣|美元|欧元|歐元|英镑|英鎊|日元)(?=\s?\d)`;
const CUR_AFTER = String.raw`(?:(?:${CUR_CODES}|(?:US |Hong Kong |Singapore |Australian |Canadian |New Zealand )?dollars?|euros?|pounds?(?: sterling)?|yuan|renminbi|yen|rupees?|francs?)(?![\p{L}])|港元|港币|港幣|美元|人民币|人民幣|欧元|歐元|英镑|英鎊|日元|元|块|円)`;
const RANGE = String.raw`\s?(?:-|–|—|to)\s?`;
const AMOUNT_BEFORE_RE = new RegExp(
  String.raw`(?:${CUR_BEFORE})\s?(?:${NUM})${MAG}(?:${RANGE}(?:${CUR_BEFORE})?\s?(?:${NUM})${MAG})?(?:\s?(?:元|港元|美元))?`,
  "giu"
);
const AMOUNT_AFTER_RE = new RegExp(
  String.raw`(?<![\w.])(?:${NUM})${MAG}(?:${RANGE}(?:${NUM})${MAG})?\s?${CUR_AFTER}`,
  "giu"
);
const NUM_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion";
const AMOUNT_WORDS_RE = new RegExp(
  String.raw`\b(?:${NUM_WORD})(?:[\s-]+(?:and[\s-]+)?(?:${NUM_WORD}))*\s+(?:(?:US|U\.S\.|Hong Kong|Singapore|Australian|Canadian|New Zealand)\s+)?(?:dollars?|euros?|pounds?(?:\s+sterling)?|yuan|renminbi|yen|rupees?|francs?)\b(?:\s+(?:and\s+)?(?:${NUM_WORD})(?:[\s-]+(?:${NUM_WORD}))*\s+cents?\b)?`,
  "gi"
);
const PERCENT_RE = new RegExp(
  String.raw`(?:(?<![\w.])[+\-−±]?\d+(?:[.,]\d+)?\s?%?${RANGE})?(?<![\w.])[+\-−±]?\d+(?:[.,]\d+)?\s?(?:%|％|percent\b|per\s?cent\b|pct\b|bps\b|basis points?\b)|百分之[零〇一二三四五六七八九十百点點\d.]+`,
  "giu"
);
const PAYMENT_TERMS_RE = new RegExp(
  [
    String.raw`\bnet\s?\d{1,3}(?:\s?days)?\b(?!\s?%)`,
    String.raw`\b(?:within|no later than|not later than)\s+(?:[a-z]+(?:[\s-][a-z]+)?\s*\(\d{1,3}\)|\d{1,3}|[a-z]+(?:-[a-z]+)?)\s+(?:business\s+|calendar\s+|working\s+|banking\s+)?days?\s+(?:of|from|after|following)\s+(?:the\s+)?(?:(?:date|receipt|issuance|issue)\s+of\s+(?:the\s+|an?\s+|each\s+|such\s+)?)?(?:invoice|receipt|delivery|billing|statement|acceptance)s?\b`,
    String.raw`\b\d{1,3}\s?days?\s+(?:net|credit|payment terms?)\b`,
    String.raw`(?:收到发票|收到發票|开具发票|開具發票|验收|驗收)后?(?:\d{1,3}|[一二三四五六七八九十]+)\s?个?(?:工作日|日|天)内?|月结\d{1,3}天|月結\d{1,3}天`,
  ].join("|"),
  "giu"
);
const COMMERCIAL_LABELS = String.raw`unit price|list price|price(?: per [a-z]+)?|pricing|fees?|costs?|(?:hourly |daily |day |monthly |annual )?rates?|discount|rebate|budget|(?:total )?contract value|tcv|acv|arr|mrr|(?:grand |sub-?)?total|amount(?: due| payable)?|deposit|commission|margin|mark-?up|penalty|liquidated damages|service credits?|credit limit|liability cap|cap on liability|retainer|salary|compensation|bonus|payment terms?|terms of payment|(?:initial |renewal |contract |minimum )?term|notice period|minimum commitment|volume commitment|价格|價格|单价|單價|费用|費用|金额|金額|总价|總價|总额|總額|折扣|预算|預算|佣金|付款条件|付款條件|付款方式|合同期限|合約期限`;
const TERMS_LABEL_RE = /term|period|commitment|条件|條件|方式|期限/i;
const COMMERCIAL_COL_RE = /price|pricing|cost|fee|amount|rate|total|subtotal|value|budget|discount|rebate|revenue|salary|compensation|commission|margin|payment|deposit|invoice|tariff|charge|spend|\b(?:arr|mrr|acv|tcv|gmv|capex|opex)\b|价格|價格|费用|費用|金额|金額|单价|單價|总价|總價|折扣|预算|預算|收入|工资|工資|薪/i;

function redactCommercial(text, ctx) {
  const amount = () => token(ctx, "AMOUNT");
  text = text.replace(PAYMENT_TERMS_RE, () => token(ctx, "TERMS"));
  text = text.replace(AMOUNT_WORDS_RE, amount);
  text = text.replace(AMOUNT_BEFORE_RE, amount);
  text = text.replace(AMOUNT_AFTER_RE, amount);
  text = text.replace(/[零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬万亿億]{2,}(?:元|圆|圓)(?:[零〇壹贰貳叁參肆伍陆陸柒捌玖][角分])*整?/gu, amount);
  text = text.replace(/[一二三四五六七八九十两兩]+[十百千万萬亿億]+(?:元|美元|港元)/gu, amount);
  text = text.replace(PERCENT_RE, () => token(ctx, "RATE"));

  // "Price: 150/hour", "| Payment terms | 30 days |".
  text = labelled(text, COMMERCIAL_LABELS, (rest, m) => {
    const v = fieldValue(rest).split(/\.\s/)[0].slice(0, 120).replace(/[\s.,:]+$/, "");
    if (!/\d/.test(v)) return null;
    return [v.length, token(ctx, TERMS_LABEL_RE.test(m[1]) ? "TERMS" : "AMOUNT")];
  });

  // Number cells under a price/fee/total… column.
  return mapTableColumns(text, (header) => {
    if (!COMMERCIAL_COL_RE.test(header)) return null;
    const label = /term/i.test(header) ? "TERMS" : "AMOUNT";
    return (cell) => (/\d/.test(cell) ? keepSpace(cell, token(ctx, label)) : cell);
  });
}

// --- Names -------------------------------------------------------------
const HONORIFICS = "Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Madam|Mdm|Mme|Mlle|Herr|Frau";
const HONORIFIC_PREFIX_RE = new RegExp(String.raw`^(?:(?:${HONORIFICS})\.?\s+)+`, "u");
const HONORIFIC_WORDS = new Set(HONORIFICS.toLowerCase().split("|"));
const NAME_PARTICLES = new Set("van von de der den del della di da das dos du le la al el bin binti ibn st".split(" "));
const NAME_SUFFIXES = new Set("jr sr ii iii iv".split(" "));
// Capitalised words that end a name: labels, job titles, departments, etc.
const NOT_NAME = new Set(
  `the a an and or of for to in on at by with from as is are was be this that these those it its our we us you your he she they his her their i my me
  all any each every no not none nil n/a na tbd tbc tba unknown various other others see refer per above below here there yes
  name names title job position role roles date dates signature signed sign email e-mail mail phone tel telephone mobile fax address
  company organisation organization org department dept division unit team teams client clients customer customers supplier vendor
  party parties buyer seller licensor licensee provider contractor employer employee employees staff member members status notes note
  comments comment description details detail location id owner contact type category priority amount price total remarks remark
  action actions item items task tasks deadline due summary overview background objective objectives goal goals
  ceo cfo cto coo cio cmo cpo ciso vp svp evp avp md gm head lead leader manager director president chairman chairwoman chair
  chairperson officer secretary treasurer engineer developer designer architect partner consultant analyst associate specialist
  coordinator administrator admin executive intern trainee assistant representative rep agent advisor adviser counsel attorney
  lawyer solicitor sir madam dear valued hiring colleagues friends shareholders everyone
  sales marketing engineering finance legal hr operations ops it support product products project projects service services
  management board committee office plan plans tier package edition enterprise basic standard premium pro professional starter
  business free plus ultimate advanced essentials please thanks thank regards best kind sincerely yours cheers
  order accounts account payable receivable procurement purchasing reception billing compliance security privacy info general
  inquiries enquiries responsibilities responsibility value values field fields information purpose scope area areas region country
  city function skills experience education level grade score rating result results metric metrics target targets kpi kpis timeline
  quarter year month week time hours cost costs fee fees rate rates budget quantity qty units version link url website reference ref
  number code feature features requirement requirements risk risks issue issues mitigation dependency dependencies decision
  decisions question questions answer answers step steps phase stage milestone milestones deliverable deliverables outcome outcomes
  impact effort done open closed pending approved draft final subtotal hi hello change changes request requests form forms list
  policy procedure process template record records register index section schedule appendix annex table figure`.split(/\s+/)
);
// A value containing one of these is a company, not a person.
const ORG_WORDS = new Set(
  `limited ltd inc incorporated llc llp lp plc corp corporation company co gmbh ag sa sas sarl bv nv pty pte bhd sdn kk holdings
  group partners associates bank university college school hospital clinic foundation trust council ministry government agency
  authority association institute society`.split(/\s+/)
);
// First names / surnames that are also everyday words: replaced where
// detected, but not hunted for on their own elsewhere in the document.
const AMBIGUOUS_NAMES = new Set(
  `january february march april may june july august september october november december monday tuesday wednesday thursday friday
  saturday sunday will bill mark grant rose hope joy frank guy ray art dean earl gene jack rich rob sue pat don ben max dawn eve iris
  ruby amber holly ivy lily crystal heather brook lane long young king white black brown green gray grey hill wood ward park bell cook
  baker hunter mason carter cooper turner parker walker hall man sun star summer winter page price case chase bishop major
  christian`.split(/\s+/)
);
const CJK_NOT_NAMES = /^(?:先生|小姐|女士|太太|男|女|未知|不详|不詳|待定|无|無|本人|客户|客戶|公司|部门|部門|经理|經理|主管|员工|員工)$/u;

// The person-name-like start of `s` ("John A. Smith", "陈大文"), or "".
function takeName(s) {
  if (!s) return "";
  const cjk = s.match(/^[㐀-鿿]{2,4}(?![㐀-鿿])/u) || s.match(/^[㐀-鿿]{2,3}/u);
  if (cjk) return CJK_NOT_NAMES.test(cjk[0]) ? "" : cjk[0];

  const re = /([ \t]*)([^\s|,;:()[\]{}<>"“”*!?]+)/uy;
  let end = 0;
  let words = 0;
  let m;
  while (words < 4 && (m = re.exec(s))) {
    if (m.index === 0 && m[1]) return "";
    let w = m[2];
    let wEnd = m.index + m[0].length;
    let stop = false;
    const poss = w.match(/^(.+?)['’]s$/u); // "Smith's" -> stop after "Smith"
    if (poss) {
      w = poss[1];
      wEnd -= 2;
      stop = true;
    }
    const bare = w.replace(/\.$/, "");
    const lower = bare.toLowerCase();
    if (HONORIFIC_WORDS.has(lower)) {
      if (words) break;
      end = wEnd;
      continue;
    }
    if (/^\p{Lu}\.?$/u.test(w)) {
      end = wEnd; // initial
    } else if (/^\p{Lu}[\p{L}'’-]*\p{L}$/u.test(bare)) {
      if (ORG_WORDS.has(lower)) return "";
      if (NOT_NAME.has(lower) || /^[:：]/.test(s.slice(wEnd))) break; // a label, not a name
      words++;
      if (w.endsWith(".") && !NAME_SUFFIXES.has(lower)) {
        end = wEnd - 1; // "Smith." ends the sentence
        break;
      }
      end = wEnd;
    } else if (!NAME_PARTICLES.has(w)) {
      break; // ("van der" etc. are kept only if a capitalised word follows)
    }
    if (stop) break;
  }
  const name = words ? s.slice(0, end) : "";
  // A lone all-caps word is an acronym (ARR, SLA), not a name; "JOHN SMITH" is fine.
  return words === 1 && /^\P{Ll}+$/u.test(name.replace(HONORIFIC_PREFIX_RE, "")) ? "" : name;
}

// Also takes a trailing ", Peter" in "CHAN Tai Man, Peter".
function takeFullName(s) {
  const n = takeName(s);
  if (!n) return "";
  const comma = s.slice(n.length).match(/^,\s*/);
  if (comma) {
    const from = n.length + comma[0].length;
    const n2 = takeName(s.slice(from));
    if (n2 && !n2.includes(" ") && /^\s*(?:$|[|;(])/.test(s.slice(from + n2.length))) return s.slice(0, from + n2.length);
  }
  return n;
}

// A cell of a "Name"/"Owner" column: one name, or several separated by , / & and.
function replaceNamesInCell(cell, ctx) {
  const whole = cell.trim().replace(/^(\*\*|__)(.*)\1$/, "$2");
  const full = whole && takeFullName(whole);
  if (full && full.length === whole.length) return cell.replace(whole, personToken(ctx, full));
  const parts = cell.split(/(\s*(?:[,\/&;]|<br\s*\/?>|\band\b)\s*)/);
  for (let k = 0; k < parts.length; k += 2) {
    const t = parts[k].trim().replace(/^(\*\*|__)(.*)\1$/, "$2");
    const n = t && takeName(t);
    if (n && n.length === t.length) parts[k] = parts[k].replace(t, personToken(ctx, n));
  }
  return parts.join("");
}

// --- Markdown tables ---------------------------------------------------
const isTableRow = (l) => /^\|.*\|$/.test(l.trim());
const isTableSep = (l) => l.includes("--") && /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(l.trim());
const splitRow = (l) => l.split(/(?<!\\)\|/); // [before, cell1, …, cellN, after]

// A table header row: its column titles describe the cells below it.
// Two-column "| Label | Value |" tables (Word forms) are the exception: Word's
// first row is promoted to the header, but it's just the first label/value
// pair, so these tables are read row by row instead.
function isColumnHeader(lines, i) {
  if (!isTableRow(lines[i]) || !isTableSep(lines[i + 1] || "")) return false;
  const head = splitRow(lines[i]).slice(1, -1).map(plainCell);
  if (head.length !== 2 || !isFieldLabel(head[0])) return true;
  const firstCol = [];
  for (let j = i + 2; j < lines.length && isTableRow(lines[j]); j++) firstCol.push(plainCell(splitRow(lines[j])[1] || ""));
  if (firstCol.length) return firstCol.filter(isFieldLabel).length * 2 < firstCol.length;
  return isFieldLabel(head[1]) || NOT_NAME.has(head[1].toLowerCase().split(" ")[0]);
}

let fieldLabelRe = null;
function isFieldLabel(s) {
  fieldLabelRe ||= new RegExp(
    `^(?:${[NAME_LABELS, DOB_LABELS, ID_LABELS, BANK_LABELS, PHONE_LABELS, ADDRESS_LABELS, COMMERCIAL_LABELS].join("|")}` +
      String.raw`|e-?mail(?: address)?|swift(?: code)?|bic|(?:job )?title|position|role|department|company|organi[sz]ation|date|gender|sex|nationality|age|marital status|status|notes?|remarks?)$`,
    "iu"
  );
  return fieldLabelRe.test(s) || !!sensitiveLabel(s);
}

// Start offsets of every column-header row.
function tableHeaderStarts(text) {
  const starts = new Set();
  const lines = text.split("\n");
  for (let i = 0, at = 0; i < lines.length; at += lines[i].length + 1, i++) {
    if (isColumnHeader(lines, i)) starts.add(at);
  }
  return starts;
}

// For each table, `classify(headerText)` returns a cell mapper for that
// column (or null); the mapper is applied to every body cell in the column.
function mapTableColumns(text, classify) {
  const lines = text.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isColumnHeader(lines, i)) continue;
    const fns = splitRow(lines[i]).slice(1, -1).map((h) => classify(plainCell(h)));
    if (!fns.some(Boolean)) continue;
    for (let j = i + 2; j < lines.length && isTableRow(lines[j]); j++) {
      const parts = splitRow(lines[j]);
      for (let c = 1; c < parts.length - 1; c++) if (fns[c - 1]) parts[c] = fns[c - 1](parts[c]);
      lines[j] = parts.join("|");
    }
  }
  return lines.join("\n");
}

function plainCell(s) {
  return s.replace(/\*\*|__|\\/g, "").replace(/\s+/g, " ").replace(/[:：]\s*$/, "").trim();
}

function isBlankCell(cell) {
  return /^(?:|\\?[-—–]|n\/?a|tbd|tbc|none|nil)$/i.test(cell.trim());
}

function keepSpace(cell, rep) {
  return cell.slice(0, cell.length - cell.trimStart().length) + rep + cell.slice(cell.trimEnd().length);
}

// --- Validators & small helpers ----------------------------------------
function luhn(d) {
  let sum = 0;
  for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let n = +d[i];
    if (alt && (n *= 2) > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

function validIban(s) {
  const v = s.replace(/ /g, "");
  if (v.length < 15 || v.length > 34) return false;
  let mod = 0;
  for (const ch of v.slice(4) + v.slice(0, 4)) {
    for (const c of /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)) mod = (mod * 10 + +c) % 97;
  }
  return mod === 1;
}

// Hong Kong ID: letters A=10…Z=35 (a missing first letter counts as 36), weights 9…2.
function validHkid(body, check) {
  const chars = body.length === 8 ? body : " " + body;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const c = chars[i];
    sum += (c === " " ? 36 : /\d/.test(c) ? +c : c.charCodeAt(0) - 55) * (9 - i);
  }
  const cd = (11 - (sum % 11)) % 11;
  return (cd === 10 ? "A" : String(cd)) === check;
}

// Mainland China resident ID (ISO 7064 MOD 11-2).
function validCnId(id) {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += +id[i] * w[i];
  return "10X98765432"[sum % 11] === id[17].toUpperCase();
}

function digits(s) {
  return (s.match(/\d/g) || []).length;
}

function isCJK(s) {
  return /[㐀-鿿豈-﫿]/u.test(s);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
