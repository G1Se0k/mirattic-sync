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
