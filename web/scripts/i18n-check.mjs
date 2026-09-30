#!/usr/bin/env node
/**
 * i18n check — `npm run i18n:check` (CI: .github/workflows/web.yml).
 *
 * Reads the message files (src/i18n/messages; English is the source of
 * truth: en.ts = en.site.ts + en.app.ts) of every language in LANGS
 * (src/i18n/langs.ts) and checks:
 *
 *   errors (exit 1)
 *     missing       a language lacks a key English has
 *     extra         a language has a key English doesn't have
 *     placeholders  a translation's {placeholders} differ from English's
 *     empty         an empty message
 *   warnings (exit 0; --strict turns them into errors)
 *     unused        an English key no source file uses — UX4 removes the
 *                   dead ones, then this becomes an error
 *     glossary      a message uses a term docs/i18n-glossary.md lists
 *                   under "Avoid" for its language (e.g. "rendern" where
 *                   the glossary says "Exportieren")
 *
 * Usage: node scripts/i18n-check.mjs [--strict] [--json]
 *
 * Ported from the audit scripts (i18ncheck.mjs, langs.py, deadkeys.py).
 * The message files are TypeScript: they are transpiled with the
 * project's own `typescript` and evaluated, so any valid syntax works.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(WEB, "src");
const MESSAGES = path.join(SRC, "i18n", "messages");
const GLOSSARY = path.resolve(WEB, "..", "docs", "i18n-glossary.md");

// ── loading ──────────────────────────────────────────────────────────

/** Evaluate a TypeScript module (and the relative modules it imports). */
export function loadTs(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  const ts = createRequire(path.join(WEB, "package.json"))("typescript");
  const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod);
  const req = (spec) => {
    if (!spec.startsWith(".")) throw new Error(`${file}: only relative imports are supported (${spec})`);
    const base = path.resolve(path.dirname(file), spec);
    const target = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!target) throw new Error(`${file}: cannot resolve ${spec}`);
    return loadTs(target, cache);
  };
  new Function("exports", "require", "module", out)(mod.exports, req, mod);
  return mod.exports;
}

/** Language codes of LANGS in src/i18n/langs.ts, English first. */
export function readLangs(indexSource) {
  const block = /export const LANGS\s*=\s*\{([\s\S]*?)\}/.exec(indexSource);
  if (!block) throw new Error("src/i18n/langs.ts: LANGS not found");
  return [...block[1].matchAll(/^\s*["']?([a-z]{2}(?:-[A-Z]{2})?)["']?\s*:/gm)].map((m) => m[1]);
}

/** { lang: { key: message } } for every language; English complete. */
export function loadMessages() {
  const langs = readLangs(fs.readFileSync(path.join(SRC, "i18n", "langs.ts"), "utf8"));
  const cache = new Map();
  const dicts = {};
  for (const lang of langs) {
    const file = path.join(MESSAGES, `${lang}.ts`);
    if (!fs.existsSync(file)) throw new Error(`no message file for ${lang} (${path.relative(WEB, file)})`);
    const mod = loadTs(file, cache);
    const dict = mod[lang] ?? mod.default;
    if (!dict || typeof dict !== "object") throw new Error(`${path.relative(WEB, file)} exports no "${lang}" object`);
    dicts[lang] = dict;
  }
  return dicts;
}

// ── checks ───────────────────────────────────────────────────────────

/** The {placeholders} of a message, sorted and unique. */
export function placeholders(message) {
  return [...new Set([...String(message).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

/** Missing / extra keys, placeholder mismatches, empty messages. */
export function checkDicts(dicts, base = "en") {
  const errors = [];
  const en = dicts[base];
  for (const [key, msg] of Object.entries(en)) {
    if (typeof msg !== "string" || !msg.trim()) errors.push({ rule: "empty", lang: base, key });
  }
  for (const [lang, dict] of Object.entries(dicts)) {
    if (lang === base) continue;
    for (const key of Object.keys(en)) {
      if (!(key in dict)) errors.push({ rule: "missing", lang, key });
    }
    for (const [key, msg] of Object.entries(dict)) {
      if (!(key in en)) {
        errors.push({ rule: "extra", lang, key });
        continue;
      }
      if (typeof msg !== "string" || !msg.trim()) {
        errors.push({ rule: "empty", lang, key });
        continue;
      }
      const want = placeholders(en[key]);
      const got = placeholders(msg);
      if (want.join() !== got.join()) {
        const fmt = (list) => (list.length ? list.map((p) => `{${p}}`).join(" ") : "none");
        errors.push({ rule: "placeholders", lang, key, detail: `${fmt(got)} instead of ${fmt(want)}` });
      }
    }
  }
  return errors;
}

/** Source files that may use message keys (not the messages, not tests). */
function sourceFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== MESSAGES) sourceFiles(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * English keys no source uses. A key counts as used when it appears as a
 * string literal, or when a template literal / concatenation builds keys
 * from its prefix (t(`app.stage.${id}`) uses every app.stage.* key).
 */
export function unusedKeys(keys, sources) {
  const text = sources.join("\n");
  const prefixes = new Set();
  for (const m of text.matchAll(/`([A-Za-z0-9_.-]+\.)\$\{/g)) prefixes.add(m[1]);
  for (const m of text.matchAll(/["'`]([A-Za-z0-9_.-]+\.)["'`]\s*\+/g)) prefixes.add(m[1]);
  const pre = [...prefixes];
  return keys.filter((k) => {
    if (text.includes(`"${k}"`) || text.includes(`'${k}'`) || text.includes(`\`${k}\``)) return false;
    return !pre.some((p) => k.startsWith(p));
  });
}

// ── glossary ─────────────────────────────────────────────────────────

/** Markdown table rows under the first heading matching `heading`. */
function tableUnder(md, heading) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && heading.test(l));
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

const stripMd = (s) => s.replace(/`/g, "").replace(/\*\*/g, "").trim();

/**
 * The glossary of docs/i18n-glossary.md:
 *   terms  { concept: { lang: approved term } }  ("## Terms" table)
 *   avoid  [{ lang, concept, term }]              ("## Avoid" table)
 */
export function parseGlossary(md) {
  const [head, ...rows] = tableUnder(md, /^#{1,6}\s+Terms\b/);
  const terms = {};
  if (head) {
    const langs = head.slice(1).map(stripMd);
    for (const row of rows) {
      const concept = stripMd(row[0]);
      terms[concept] = Object.fromEntries(langs.map((l, i) => [l, stripMd(row[i + 1] ?? "")]));
    }
  }
  const avoid = [];
  const [ahead, ...arows] = tableUnder(md, /^#{1,6}\s+Avoid\b/);
  if (ahead) {
    for (const row of arows) {
      const [lang, concept, list] = row.map(stripMd);
      for (const term of (list ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
        avoid.push({ lang, concept, term });
      }
    }
  }
  return { terms, avoid };
}

// Scripts without spaces between words: plain substring matching.
const NO_WORD_BOUNDARY = new Set(["ja", "ko", "zh", "th", "hi"]);

/**
 * A matcher for an "Avoid" term: case-insensitive, whole words (a `*`
 * at either end allows more letters there: `*render*` catches
 * "gerendert" and "Rendering").
 */
export function avoidRegex(term, lang) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = term.startsWith("*");
  const trail = term.endsWith("*");
  const core = esc(term.replace(/^\*|\*$/g, ""));
  if (NO_WORD_BOUNDARY.has(lang)) return new RegExp(core, "iu");
  const L = "[\\p{L}\\p{M}\\p{N}]";
  return new RegExp(`${lead ? `${L}*` : `(?<!${L})`}${core}${trail ? `${L}*` : `(?!${L})`}`, "iu");
}

/** Voice commands and placeholders stay literal in every language. */
export const stripLiterals = (msg) => String(msg).replace(/\{[A-Za-z0-9_]+\}/g, " ").replace(/\bCleo\s+[A-Za-z]+/g, " ");

/** Glossary warnings: [{ lang, concept, term, use, keys: [...] }]. */
export function checkGlossary(dicts, glossary) {
  const found = [];
  for (const { lang, concept, term } of glossary.avoid) {
    const dict = dicts[lang];
    if (!dict) continue;
    const rx = avoidRegex(term, lang);
    const keys = Object.entries(dict)
      .filter(([, msg]) => rx.test(stripLiterals(msg)))
      .map(([k]) => k);
    if (keys.length) found.push({ lang, concept, term, use: glossary.terms[concept]?.[lang] || null, keys });
  }
  return found;
}

// ── main ─────────────────────────────────────────────────────────────

function main(argv) {
  const strict = argv.includes("--strict");
  const json = argv.includes("--json");
  const gha = Boolean(process.env.GITHUB_ACTIONS);

  const dicts = loadMessages();
  const langs = Object.keys(dicts);
  const enKeys = Object.keys(dicts.en);
  const errors = checkDicts(dicts);
  const sources = sourceFiles().map((f) => fs.readFileSync(f, "utf8"));
  const unused = unusedKeys(enKeys, sources);
  let glossary = { terms: {}, avoid: [] };
  if (fs.existsSync(GLOSSARY)) glossary = parseGlossary(fs.readFileSync(GLOSSARY, "utf8"));
  else errors.push({ rule: "glossary", lang: "-", key: "-", detail: `${path.relative(WEB, GLOSSARY)} is missing` });
  const terms = checkGlossary(dicts, glossary);
  const warnings = unused.length + terms.reduce((n, t) => n + t.keys.length, 0);
  const failed = errors.length > 0 || (strict && warnings > 0);

  if (json) {
    console.log(JSON.stringify({ langs, keys: enKeys.length, errors, unused, glossary: terms, failed }, null, 2));
    return failed ? 1 : 0;
  }

  console.log(`i18n check: ${langs.length} languages (${langs.join(" ")}), ${enKeys.length} keys`);
  const byRule = {};
  for (const e of errors) (byRule[e.rule] ??= []).push(e);
  for (const rule of ["missing", "extra", "placeholders", "empty", "glossary"]) {
    const list = byRule[rule] ?? [];
    if (rule === "glossary" && !list.length) continue;
    console.log(`${list.length ? "✗" : "✓"} ${rule}: ${list.length ? `${list.length} error(s)` : "none"}`);
    for (const e of list) {
      console.log(`    ${e.lang}  ${e.key}${e.detail ? `  ${e.detail}` : ""}`);
      if (gha) console.log(`::error title=i18n ${rule}::${e.lang} ${e.key}${e.detail ? ` — ${e.detail}` : ""}`);
    }
  }
  const mark = strict ? "✗" : "!";
  console.log(`${unused.length ? mark : "✓"} unused keys (${strict ? "error" : "warning"}): ${unused.length || "none"}`);
  for (const k of unused) console.log(`    ${k}`);
  const nTerm = terms.reduce((n, t) => n + t.keys.length, 0);
  console.log(
    `${nTerm ? mark : "✓"} glossary (${strict ? "error" : "warning"}): ${nTerm ? `${nTerm} message(s) use a term to avoid` : "none"}` +
      (glossary.avoid.length ? "" : " (no Avoid list in the glossary)"),
  );
  for (const t of terms) {
    const use = t.use ? ` → use "${t.use}"` : "";
    console.log(`    ${t.lang}  ${t.concept}: "${t.term}"${use}  (${t.keys.length}) ${t.keys.join(", ")}`);
  }
  if (gha && warnings && !strict) {
    console.log(`::warning title=i18n::${unused.length} unused key(s), ${nTerm} glossary deviation(s) — see the i18n check log`);
  }
  console.log(failed ? "i18n check FAILED" : "i18n check passed" + (warnings ? ` with ${warnings} warning(s)` : ""));
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`i18n check: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 2;
  }
}
