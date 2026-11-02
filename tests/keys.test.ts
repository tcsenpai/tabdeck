import { describe, expect, test } from "bun:test";
import { ConfigError, validateStep } from "../lib/config.ts";
import { keysScript, parseKeys } from "../lib/keys.ts";

describe("repeated key presses", () => {
  test("a single press keeps the one-line script; repeats run inside one script", () => {
    expect(keysScript(parseKeys("cmd+z"))).toBe('tell application "System Events" to keystroke "z" using {command down}');
    const s = keysScript(parseKeys("return"), 2, 80);
    expect(s).toContain("repeat 2 times");
    expect(s).toContain("key code 36");
    expect(s).toContain("delay 0.08");
  });
  test("repeat/gap are validated and stored only when repeat > 1", () => {
    expect(validateStep({ type: "keys", keys: "a" }, "s")).toEqual({ type: "keys", keys: "a" });
    expect(validateStep({ type: "keys", keys: "a", repeat: 1, gap: 500 }, "s")).toEqual({ type: "keys", keys: "a" });
    expect(validateStep({ type: "keys", keys: "a", repeat: 2 }, "s")).toEqual({ type: "keys", keys: "a", repeat: 2, gap: 80 });
    for (const bad of [{ repeat: 0 }, { repeat: 11 }, { repeat: 1.5 }, { repeat: "2" }, { repeat: 2, gap: -1 }, { repeat: 2, gap: 1001 }]) {
      expect(() => validateStep({ type: "keys", keys: "a", ...bad }, "s")).toThrow(ConfigError);
    }
  });
});
