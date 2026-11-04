import { describe, expect, test } from "bun:test";
import { ConfigError, MIN_SIZE, SUB, migrateConfig, seedConfig, validateConfig, type PadConfig } from "../lib/config.ts";

// A button as it was written by the tile-based format (version 1).
const v1Button = (id: string, col: number, row: number, extra: object = {}) => ({
  id, col, row, label: id, icon: "", color: "slate", kind: "button", confirm: false, showOutput: false,
  steps: [], hold: [], led: "", toggle: false, fader: { get: "", set: "" }, w: 1, station: "", ...extra,
});

describe("unit grid", () => {
  test("a version-1 pad becomes the same layout on the unit grid", () => {
    const v1 = {
      version: 1,
      pages: [{ id: "p", name: "P", cols: 4, rows: 3, buttons: [
        v1Button("a", 0, 0), v1Button("b", 3, 2), v1Button("radio", 0, 1, { kind: "radio", w: 3 }),
      ] }],
    };
    const cfg = validateConfig(v1);
    expect(cfg.version).toBe(2);
    const [a, b, radio] = cfg.pages[0].buttons;
    expect([a.col, a.row, a.w, a.h]).toEqual([0, 0, SUB, SUB]);
    expect([b.col, b.row, b.w, b.h]).toEqual([3 * SUB, 2 * SUB, SUB, SUB]);
    expect([radio.col, radio.row, radio.w, radio.h]).toEqual([0, 1 * SUB, 3 * SUB, SUB]);
    expect(cfg.pages[0].cols).toBe(4); // pages still count whole tiles
  });
  test("migration happens once: version 2 input is returned untouched", () => {
    const cfg = seedConfig();
    expect(migrateConfig(cfg)).toBe(cfg);
    const again = validateConfig(JSON.parse(JSON.stringify(validateConfig(JSON.parse(JSON.stringify(cfg))))));
    expect(again).toEqual(validateConfig(cfg));
    const v1 = { version: 1, pages: [{ id: "p", name: "P", cols: 2, rows: 1, buttons: [v1Button("a", 1, 0)] }] };
    expect(migrateConfig(v1)).not.toBe(v1);
    const once = validateConfig(v1);
    expect(validateConfig(once).pages[0].buttons[0].col).toBe(1 * SUB); // not doubled again
  });
  test("non-objects are left to the validator, which rejects them", () => {
    for (const bad of [null, "x", 5, [], { pages: "nope" }, { version: 1, pages: [null] }]) {
      expect(() => validateConfig(bad)).toThrow(ConfigError);
    }
  });
  test("keys can be any size from a quarter tile up, within the grid", () => {
    const c = structuredClone(seedConfig());
    c.pages[0].buttons = [{ ...c.pages[0].buttons[0], id: "k", col: 0, row: 0, w: 1, h: 1 }];
    expect(validateConfig(c).pages[0].buttons[0]).toMatchObject({ w: 1, h: 1 });
    const set = (w: number, h: number, col = 0, row = 0) => {
      const d = structuredClone(c);
      Object.assign(d.pages[0].buttons[0], { w, h, col, row });
      return () => validateConfig(d);
    };
    expect(set(8, 6)).not.toThrow(); // the whole 8×6 grid
    expect(set(3, 5, 5, 1)).not.toThrow(); // flush against the right edge
    for (const [w, h, col, row] of [[0, 1, 0, 0], [1, 0, 0, 0], [9, 1, 0, 0], [1, 7, 0, 0], [2, 2, 7, 0], [2, 2, 0, 5], [1.5, 1, 0, 0]] as const) {
      expect(set(w, h, col, row)).toThrow(ConfigError);
    }
  });
  test("two keys cannot share a unit, but touching edges are fine", () => {
    const c = structuredClone(seedConfig());
    const base = c.pages[0].buttons[0];
    const two = (second: object) => {
      const d = structuredClone(c) as PadConfig;
      d.pages[0].buttons = [{ ...base, id: "a", col: 0, row: 0, w: 3, h: 2 }, { ...base, id: "b", ...second }] as PadConfig["pages"][0]["buttons"];
      return () => validateConfig(d);
    };
    expect(two({ col: 3, row: 0, w: 1, h: 1 })).not.toThrow(); // right next to it
    expect(two({ col: 0, row: 2, w: 3, h: 1 })).not.toThrow(); // right below it
    expect(two({ col: 2, row: 1, w: 1, h: 1 })).toThrow(ConfigError); // inside its last unit
    expect(two({ col: 2, row: 1, w: 2, h: 2 })).toThrow(ConfigError); // overlapping a corner
  });
  test("each kind has a minimum size", () => {
    expect(MIN_SIZE.button).toEqual([1, 1]);
    const c = structuredClone(seedConfig());
    const fader = c.pages[0].buttons.find((x) => x.kind === "fader")!;
    Object.assign(fader, { w: 1, h: 1 });
    expect(() => validateConfig(c)).toThrow(ConfigError); // a fader needs 2×1
    Object.assign(fader, { w: 2, h: 1 });
    expect(() => validateConfig(c)).not.toThrow();
  });
  test("shrinking a page is only valid when every key still fits", () => {
    const c = structuredClone(seedConfig());
    c.pages[0].cols = 2; // the seed has keys in columns 2..3 tiles
    expect(() => validateConfig(c)).toThrow(ConfigError);
  });
});
