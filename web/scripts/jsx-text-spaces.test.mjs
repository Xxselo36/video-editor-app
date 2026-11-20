// Next 16's compiler (SWC) drops the leading space of a JSX text that
// starts on the line of the element or expression before it, runs over
// more than one line and holds an HTML character reference (&apos;,
// &amp;, …): `<code>cleo_lang</code> cookie), …⏎ …hasn&apos;t` renders
// "cleo_langcookie)". Such a text needs an explicit {" "} in front.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const REF = /&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/i;

/** "file:line" of every JSX text in `source` whose leading space is lost. */
export function lostSpaces(source, name = "x.tsx") {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = source.slice(node.pos, node.end);
      if (/^[ \t]+\S/.test(raw) && raw.includes("\n") && REF.test(raw)) {
        out.push(`${name}:${sf.getLineAndCharacterOfPosition(node.pos).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function tsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

describe("JSX text keeps its leading space", () => {
  it("finds the pattern the compiler breaks, not the safe ones", () => {
    const broken = "const a = <p>\n  the <code>x</code> cookie), and\n  hasn&apos;t yet.</p>;";
    expect(lostSpaces(broken)).toEqual(["x.tsx:2"]);
    // An explicit space, one line, no character reference: kept.
    expect(lostSpaces('const a = <p>\n  the <code>x</code>{" "}cookie), and\n  hasn&apos;t yet.</p>;')).toEqual([]);
    expect(lostSpaces("const a = <p>the <code>x</code> cookie) hasn&apos;t.</p>;")).toEqual([]);
    expect(lostSpaces("const a = <p>\n  the <code>x</code> cookie), and\n  has not yet.</p>;")).toEqual([]);
  });

  it("no component in src/ has such a text", () => {
    const found = tsxFiles(SRC).flatMap((f) => lostSpaces(fs.readFileSync(f, "utf8"), path.relative(SRC, f)));
    expect(found).toEqual([]);
  });
});
