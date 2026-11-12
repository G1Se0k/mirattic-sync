import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "./en.json";
import ja from "./ja.json";

/**
 * Every Korean text the code shows is a key (decision 124): each string with Hangul in the panel's and the
 * extension's code (comments aside) has its English and Japanese, with the same `{name}`s.
 */
const ROOT = resolve(__dirname, "../../..");
const SOURCES = ["packages/ui/src", "packages/types/src", "apps/extension"];
/** Korean on purpose, not shown through t(). */
const NOT_SHOWN = new Set(["한국어"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".output" || f === ".wxt" || f.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

export function koreanTexts(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of SOURCES.flatMap((s) => files(join(ROOT, s)))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /[가-힣]/.test(n.text) && !NOT_SHOWN.has(n.text)) {
        found.set(n.text, `${file.slice(ROOT.length + 1)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
      if (ts.isTemplateExpression(n) && /[가-힣]/.test(n.getText())) found.set(n.getText(), "template (use t with params)");
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe.each([["en", en as Record<string, string>], ["ja", ja as Record<string, string>]])("%s", (_, dict) => {
  const texts = koreanTexts();
  it("has every Korean text", () => {
    expect([...texts].filter(([k]) => !(k in dict)).map(([k, at]) => `${at}  ${k}`)).toEqual([]);
  });
  it("fills the same names", () => {
    expect(Object.entries(dict).filter(([k, v]) => names(k).join() !== names(v).join()).map(([k]) => k)).toEqual([]);
  });
  it("keeps no text the code no longer has", () => {
    expect(Object.keys(dict).filter((k) => !texts.has(k))).toEqual([]);
  });
});

describe("t", () => {
  it("shows the language chosen, its names filled", async () => {
    const { setLang, t, tParts } = await import("./index");
    expect(t("{text}님이 들어왔습니다", { text: "민수" })).toBe("민수님이 들어왔습니다");
    setLang("ja");
    expect(t("{text}님이 들어왔습니다", { text: "ミンス" })).toBe("ミンスさんが入室しました");
    expect(tParts("{text}님이 {v}에 스탬프를 찍었습니다", { text: 1, v: 2 })).toEqual([1, "さんが", 2, "にスタンプを付けました"]);
    setLang("en");
    expect(t("{text}님이 들어왔습니다", { text: "Minsu" })).toBe("Minsu joined");
    setLang("ko");
  });
});

/**
 * The site pages (server static, decision 124): every Korean text node and alt / aria-label / content / title outside
 * script, style and data-lang blocks — what landing/page-lang.js looks up — plus each t('…') in their scripts, is in
 * the page's page-text English and Japanese, and nothing else is.
 */
describe("site pages", () => {
  const STATIC = join(ROOT, "server/src/main/resources/static");
  const VOID = new Set(["br", "img", "meta", "link", "input", "source", "path", "circle", "rect", "line", "polyline"]);
  const text = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim().replace(/\s+/g, " ");
  for (const page of ["index.html", "invite.html", "privacy.html"]) {
    it(page, () => {
      const html = readFileSync(join(STATIC, page), "utf8");
      const keys = new Set<string>();
      const open: boolean[] = []; // per open element: skipped
      let skip = 0, at = 0;
      for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
        const between = text(html.slice(at, m.index));
        at = m.index + m[0].length;
        if (!skip && /[가-힣]/.test(between)) keys.add(between);
        const [, close, name, attrs] = m;
        const tag = name.toLowerCase();
        if (close) {
          if (open.pop()) skip--;
          continue;
        }
        if (!skip) for (const a of attrs.matchAll(/\b(alt|aria-label|content|title)="([^"]*)"/g)) if (/[가-힣]/.test(a[2])) keys.add(text(a[2]));
        if (VOID.has(tag) || attrs.endsWith("/")) continue;
        const skipped = tag === "script" || tag === "style" || /\bdata-lang=/.test(attrs);
        open.push(skipped);
        if (skipped) skip++;
      }
      for (const m of html.matchAll(/\bt\((['"])(.*?)\1/g)) keys.add(m[2]);
      const words = JSON.parse(/<script type="application\/json" id="page-text">([\s\S]*?)<\/script>/.exec(html)![1]);
      for (const lang of ["en", "ja"]) {
        expect([...keys].filter((k) => !(k in words[lang])), lang).toEqual([]);
        expect(Object.keys(words[lang]).filter((k) => !keys.has(k)), lang).toEqual([]);
      }
    });
  }
});
