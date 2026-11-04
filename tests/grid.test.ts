import { describe, expect, test } from "bun:test";
import { ConfigError, MIN_SIZE, SUB, migrateConfig, publicView, seedConfig, validateConfig, type PadConfig } from "../lib/config.ts";

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

describe("visualizer tile", () => {
  const withViz = (over: object) => {
    const c = structuredClone(seedConfig());
    c.pages[0].buttons = [{ ...c.pages[0].buttons[0], id: "v", col: 0, row: 0, kind: "viz", ...over }];
    return () => validateConfig(c);
  };
  test("it is resizable from 2×1 up, defaults to 4×2, and carries no actions", () => {
    expect(withViz({ w: undefined, h: undefined })()).toBeDefined();
    const ok = withViz({ w: undefined, h: undefined })().pages[0].buttons[0];
    expect(ok).toMatchObject({ kind: "viz", w: 4, h: 2, steps: [], hold: [], led: "", toggle: false, station: "" });
    expect(withViz({ w: 2, h: 1 })).not.toThrow();
    expect(withViz({ w: 8, h: 6 })).not.toThrow();
    for (const [w, h] of [[1, 1], [1, 2], [9, 1], [2, 0]] as const) expect(withViz({ w, h })).toThrow(ConfigError);
  });
  test("several visualizer tiles are fine (they share one stream)", () => {
    const c = structuredClone(seedConfig());
    const base = c.pages[0].buttons[0];
    c.pages[0].buttons = [
      { ...base, id: "a", col: 0, row: 0, w: 4, h: 2, kind: "viz" },
      { ...base, id: "b", col: 0, row: 2, w: 2, h: 1, kind: "viz" },
    ];
    expect(validateConfig(c).pages[0].buttons).toHaveLength(2);
  });
});

describe("tablet profiles", () => {
  const withProfiles = (profiles: unknown, pageProfile?: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { profiles: unknown }).profiles = profiles;
    if (pageProfile !== undefined) (c.pages[0] as unknown as { profile: unknown }).profile = pageProfile;
    return () => validateConfig(c);
  };
  test("a pad without profiles is valid and every page is for everyone", () => {
    const c = validateConfig(seedConfig());
    expect(c.profiles).toEqual([]);
    expect(c.pages[0].profile).toBe("");
  });
  test("a page can be bound to a declared profile, and only to a declared one", () => {
    const ok = withProfiles([{ id: "desk", name: "Desk" }], "desk")();
    expect(ok.pages[0].profile).toBe("desk");
    expect(withProfiles([{ id: "desk", name: "Desk" }], "wall")).toThrow(ConfigError);
    expect(withProfiles([], "desk")).toThrow(ConfigError);
  });
  test("profile ids are strict and unique, with a cap", () => {
    expect(withProfiles([{ id: "a", name: "A" }, { id: "a", name: "B" }])).toThrow(ConfigError);
    for (const bad of [{ id: "Has Space", name: "x" }, { id: "", name: "x" }, { id: "ok", name: "" }, { id: "../x", name: "x" }]) {
      expect(withProfiles([bad])).toThrow(ConfigError);
    }
    expect(withProfiles(Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: "n" })))).toThrow(ConfigError);
  });
});

describe("automatic pages", () => {
  const withAuto = (auto: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { auto: unknown }).auto = auto;
    return () => validateConfig(c);
  };
  test("off by default; a pad without the block stays valid", () => {
    const c = validateConfig(seedConfig());
    expect(c.auto).toEqual({ enabled: false, rules: [] });
    const old = JSON.parse(JSON.stringify(seedConfig()));
    delete old.auto;
    expect(validateConfig(old).auto.enabled).toBe(false);
  });
  test("rules need an app and an existing page; mode defaults to 'is'", () => {
    const ok = withAuto({ enabled: true, rules: [{ app: "Discord", page: "main" }] })();
    expect(ok.auto.rules[0]).toEqual({ app: "Discord", mode: "is", url: "", title: "", page: "main" });
    for (const bad of [{ app: "", page: "main" }, { app: "x", page: "nope" }, { app: "x", page: "main", mode: "regex" }, { page: "main" }, "str"]) {
      expect(withAuto({ enabled: true, rules: [bad] })).toThrow(ConfigError);
    }
    expect(withAuto({ rules: Array.from({ length: 41 }, () => ({ app: "x", page: "main" })) })).toThrow(ConfigError);
  });
  test("the tablet only learns whether to follow, never the rules", () => {
    const c = withAuto({ enabled: true, rules: [{ app: "Secret App", page: "main", url: "private.example" }] })();
    const view = publicView(c);
    expect(view.auto).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/Secret App|private\.example/);
    expect(publicView(withAuto({ enabled: true, rules: [] })()).auto).toBe(false);
  });
});

describe("info bar", () => {
  const withBar = (bar: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { bar: unknown }).bar = bar;
    return () => validateConfig(c);
  };
  test("empty by default; chips keep their order and drop duplicates", () => {
    expect(validateConfig(seedConfig()).bar).toEqual([]);
    expect(withBar(["mem", "cpu", "mem"])().bar).toEqual(["mem", "cpu"]);
    expect(publicView(withBar(["clock"])()).bar).toEqual(["clock"]);
  });
  test("unknown chips and more than six are rejected", () => {
    expect(withBar(["rm -rf"])).toThrow(ConfigError);
    expect(withBar(["cpu", 3])).toThrow(ConfigError);
    expect(withBar(["cpu", "mem", "battery", "disk", "volume", "uptime", "load"])).toThrow(ConfigError);
    expect(withBar("cpu")).toThrow(ConfigError);
  });
});

describe("radio favourites", () => {
  const UUID = "960cf833-0601-11e8-ae97-52543be04c81";
  const base = (favs: unknown, station?: string) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { radioFavs: unknown }).radioFavs = favs;
    if (station) c.pages[0].buttons[0] = { ...c.pages[0].buttons[0], kind: "station", station, steps: [], hold: [], w: SUB, h: SUB };
    return () => validateConfig(c);
  };
  test("kept as id + name, duplicates dropped, the tablet sees them", () => {
    const c = base([{ uuid: UUID, name: "Groove" }, { uuid: UUID, name: "Again" }])();
    expect(c.radioFavs).toEqual([{ uuid: UUID, name: "Groove" }]);
    expect(publicView(c).radioFavs).toEqual(c.radioFavs);
    expect(validateConfig(seedConfig()).radioFavs).toEqual([]);
  });
  test("ids must be canonical uuids and names present; at most 24", () => {
    for (const bad of [{ uuid: "../x", name: "a" }, { uuid: UUID.toUpperCase(), name: "a" }, { uuid: UUID, name: "" }, { uuid: UUID }, "x"]) {
      expect(base([bad])).toThrow(ConfigError);
    }
    const many = Array.from({ length: 25 }, (_, i) => ({ uuid: `960cf833-0601-11e8-ae97-5254${String(i).padStart(8, "0")}`, name: `s${i}` }));
    expect(base(many)).toThrow(ConfigError);
  });
  test("a station tile may point at a saved favourite, and only at a saved one", () => {
    expect(base([{ uuid: UUID, name: "Groove" }], `rb:${UUID}`)().pages[0].buttons[0].station).toBe(`rb:${UUID}`);
    expect(base([], `rb:${UUID}`)).toThrow(ConfigError);
  });
});

describe("ambient glow flag", () => {
  const withGlow = (glow: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { glow: unknown }).glow = glow;
    return () => validateConfig(c);
  };
  test("off by default, boolean only, visible to the tablet", () => {
    expect(validateConfig(seedConfig()).glow).toBe(false);
    expect(withGlow(true)().glow).toBe(true);
    expect(publicView(withGlow(true)()).glow).toBe(true);
    for (const bad of ["yes", 1, null]) expect(withGlow(bad)).toThrow(ConfigError);
  });
});

describe("decoration tiles and the per-tile border", () => {
  const withButton = (extra: object) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    c.pages[0].buttons = [{ ...c.pages[0].buttons[0], col: 0, row: 0, w: SUB, h: SUB, ...extra } as PadConfig["pages"][0]["buttons"][0]];
    return () => validateConfig(c).pages[0].buttons[0];
  };
  test("a deco tile is inert, defaults to the clock and to no border", () => {
    const b = withButton({ kind: "deco", steps: [{ type: "shell", cmd: "echo x", cwd: "", timeout: 5 }], led: "true", style: undefined, border: undefined })();
    expect(b).toMatchObject({ kind: "deco", style: "clock", border: false, steps: [], hold: [], led: "", toggle: false, confirm: false });
  });
  test("deco styles are a closed list; other kinds keep their own style rules", () => {
    for (const s of ["clock", "hex", "radar", "pulse", "banner", "leds"]) expect(withButton({ kind: "deco", style: s })().style).toBe(s);
    expect(withButton({ kind: "deco", style: "mirror" })).toThrow(ConfigError); // a visualizer style
    expect(withButton({ kind: "viz", style: "radar" })).toThrow(ConfigError); // a decoration style
  });
  test("border defaults to on for keys, can be turned off on any kind, and must be a boolean", () => {
    expect(withButton({ border: undefined })().border).toBe(true);
    expect(withButton({ border: false })().border).toBe(false);
    expect(withButton({ kind: "station", station: "virgin", border: false })().border).toBe(false);
    expect(withButton({ border: "no" })).toThrow(ConfigError);
  });
  test("the tablet sees kind, style and border", () => {
    const c = structuredClone(seedConfig()) as PadConfig;
    Object.assign(c.pages[0].buttons[0], { kind: "deco", style: "radar", border: false });
    expect(publicView(validateConfig(c)).pages[0].buttons[0]).toMatchObject({ kind: "deco", style: "radar", border: false });
  });
});

describe("per-app key variants", () => {
  const sh = (cmd: string) => ({ type: "shell", cwd: "", timeout: 5, cmd });
  const withVariants = (variants: unknown, extra: object = {}) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    c.pages[0].buttons = [{ ...c.pages[0].buttons[0], col: 0, row: 0, w: SUB, h: SUB, variants, ...extra } as unknown as PadConfig["pages"][0]["buttons"][0]];
    return () => validateConfig(c);
  };
  test("kept with defaults filled in; none by default", () => {
    expect(validateConfig(seedConfig()).pages[0].buttons.every((b) => b.variants.length === 0)).toBe(true);
    const v = withVariants([{ app: "us.zoom.xos", label: "Mute", steps: [sh("echo z")] }])().pages[0].buttons[0].variants[0];
    expect(v).toMatchObject({ app: "us.zoom.xos", mode: "is", url: "", title: "", hidden: false, label: "Mute", color: "slate", confirm: false, hold: [] });
    expect(v.steps).toHaveLength(1);
  });
  test("an app is required; mode, colour, steps and the count are checked", () => {
    for (const bad of [{ app: "" }, {}, { app: "x", mode: "regex" }, { app: "x", color: "puce" }, { app: "x", steps: [{ type: "nope" }] }, "str"]) {
      expect(withVariants([bad])).toThrow(ConfigError);
    }
    expect(withVariants(Array.from({ length: 9 }, () => ({ app: "x" })))).toThrow(ConfigError);
  });
  test("only plain keys have variants", () => {
    expect(withVariants([{ app: "x" }], { kind: "fader", fader: { get: "", set: "echo" } })().pages[0].buttons[0].variants).toEqual([]);
  });
  test("the tablet gets the look of each variant, never the app or the commands", () => {
    const view = publicView(withVariants([{ app: "Secret", url: "private.example", label: "Z", steps: [sh("echo hidden-cmd")], hold: [sh("echo h")], hidden: false }])());
    const pv = view.pages[0].buttons[0].variants[0];
    expect(pv).toEqual({ label: "Z", icon: "", color: "slate", confirm: false, showOutput: false, hasHold: true, hidden: false });
    expect(JSON.stringify(view)).not.toMatch(/Secret|private\.example|hidden-cmd/);
  });
});

describe("mic corners flag", () => {
  const withMic = (v: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { micCorners: unknown }).micCorners = v;
    return () => validateConfig(c);
  };
  test("off by default, boolean only, visible to the tablet", () => {
    expect(validateConfig(seedConfig()).micCorners).toBe(false);
    expect(publicView(withMic(true)()).micCorners).toBe(true);
    for (const bad of ["yes", 1, null]) expect(withMic(bad)).toThrow(ConfigError);
  });
});

describe("overlay effects list", () => {
  const withFx = (v: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { fx: unknown }).fx = v;
    return () => validateConfig(c);
  };
  test("empty by default; keeps order, drops duplicates, tablet sees it", () => {
    expect(validateConfig(seedConfig()).fx).toEqual([]);
    expect(withFx(["glitch", "crt", "glitch"])().fx).toEqual(["glitch", "crt"]);
    expect(publicView(withFx(["noise"])()).fx).toEqual(["noise"]);
  });
  test("only the known effects are accepted", () => {
    for (const bad of [["shader"], [3], "crt", ["crt", "crt", "crt", "crt", "crt", "crt", "crt"]]) expect(withFx(bad)).toThrow(ConfigError);
  });
});

describe("forced microphone source", () => {
  const withSrc = (v: unknown) => {
    const c = structuredClone(seedConfig()) as PadConfig;
    (c as unknown as { micSource: unknown }).micSource = v;
    return () => validateConfig(c);
  };
  test("each tablet chooses by default; tablet or mac can be forced; nothing else", () => {
    expect(validateConfig(seedConfig()).micSource).toBe("");
    for (const ok of ["", "tablet", "mac"]) expect(withSrc(ok)().micSource).toBe(ok);
    expect(publicView(withSrc("mac")()).micSource).toBe("mac");
    for (const bad of ["both", 1, null, true]) expect(withSrc(bad)).toThrow(ConfigError);
  });
});
