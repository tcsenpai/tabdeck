import { describe, expect, test } from "bun:test";
import { ConfigError, validateStep } from "../lib/config.ts";
import { clickScript } from "../lib/mouse.ts";

describe("click step", () => {
  test("defaults to a left click at the pointer; coordinates are dropped unless 'point'", () => {
    expect(validateStep({ type: "click" }, "s")).toEqual({ type: "click", button: "left", count: 1, at: "cursor", x: 0, y: 0 });
    expect(validateStep({ type: "click", x: 50, y: 60 }, "s")).toMatchObject({ at: "cursor", x: 0, y: 0 });
    expect(validateStep({ type: "click", at: "point", x: 50, y: 60, count: 2 }, "s")).toMatchObject({ x: 50, y: 60, count: 2 });
  });
  test("rejects out-of-range counts, unknown buttons and bad coordinates", () => {
    for (const bad of [{ count: 0 }, { count: 4 }, { count: 1.5 }, { count: "2" }, { button: "x" }, { at: "nowhere" }, { at: "point", x: -1, y: 0 }, { at: "point", x: "5; rm", y: 0 }]) {
      expect(() => validateStep({ type: "click", ...bad }, "s")).toThrow(ConfigError);
    }
  });
  test("the script sets the click state per repetition, with matching down/up types", () => {
    const left = clickScript({ button: "left", count: 2, at: "point", x: 10, y: 20 });
    expect(left).toContain("i <= 2");
    expect(left).toContain("[1, 2]");
    expect(left).toContain("{ x: 10, y: 20 }");
    expect(clickScript({ button: "right", count: 1, at: "cursor", x: 0, y: 0 })).toContain("[3, 4]");
    expect(clickScript({ button: "middle", count: 1, at: "cursor", x: 0, y: 0 })).toContain("CGEventGetLocation");
  });
});
