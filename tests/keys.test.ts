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

describe("modifier-only taps", () => {
  test("a lone modifier is pressed and released; repeat 2 makes a double tap", () => {
    expect(parseKeys("opt")).toEqual({ mods: ["option"], kind: "mod" });
    expect(keysScript(parseKeys("cmd+shift"))).toBe('tell application "System Events"\nkey down command\nkey down shift\ndelay 0.03\nkey up shift\nkey up command\nend tell');
    const dbl = keysScript(parseKeys("opt"), 2, 80);
    expect(dbl).toContain("repeat 2 times");
    expect(dbl.indexOf("key down option")).toBeLessThan(dbl.indexOf("key up option"));
  });
  test("an unknown token next to modifiers is still rejected", () => {
    expect(() => parseKeys("opt+foo+shift")).toThrow();
    expect(() => parseKeys("opt+")).toThrow();
  });
});
