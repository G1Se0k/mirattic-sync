import { expect, it } from "vitest";
import { textSizeOf } from "./session";

it("keeps an offered text size and falls back to 100% otherwise", () => {
  expect(textSizeOf(80)).toBe(80);
  expect(textSizeOf(150)).toBe(150);
  expect(textSizeOf(125)).toBe(125);
  for (const bad of [undefined, null, "120", 79, 151, NaN, 82, 125.5]) expect(textSizeOf(bad)).toBe(100);
});
