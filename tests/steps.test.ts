import { describe, expect, test } from "bun:test";
import { ConfigError, seedConfig, validateStep, validateSteps } from "../lib/config.ts";
import { ACTIONS, macScript, normalizeArgs } from "../lib/macos.ts";
import { runSteps } from "../lib/run.ts";

const shell = (cmd: string, extra: object = {}) => ({ type: "shell" as const, cmd, cwd: "", timeout: 5, ...extra });

describe("mac actions", () => {
  test("user text is escaped, never able to break out of the AppleScript string", () => {
    const evil = 'x" & (do shell script "touch /tmp/pwn") & "';
    const args = normalizeArgs("system.notify", { title: "t", message: evil });
    const script = macScript("system.notify", args);
    expect(script).toContain('\\"');
    // every quote that came from the input is preceded by a backslash
    expect(script.replace(/\\"/g, "").match(/"/g)?.length).toBe(4); // message + title delimiters only
  });
  test("ints are range-checked, selects restricted, required text enforced, defaults applied", () => {
    expect(() => normalizeArgs("system.volume", { level: 101 })).toThrow();
    expect(() => normalizeArgs("system.volume", { level: 1.5 })).toThrow();
    expect(() => normalizeArgs("system.volume", { level: "5; rm -rf ~" })).toThrow();
    expect(normalizeArgs("system.volume", { level: "40" })).toEqual({ level: 40 });
    expect(normalizeArgs("system.volume", {})).toEqual({ level: 50 });
    expect(() => normalizeArgs("system.mute", { mode: "maybe" })).toThrow();
    expect(() => normalizeArgs("app.open", { app: "  " })).toThrow();
    expect(() => normalizeArgs("nope.nothing", {})).toThrow();
    expect(normalizeArgs("app.open", { app: "Safari", extra: "dropped" })).toEqual({ app: "Safari" });
  });
  test("every action generates a script with its defaults (catalog is self-consistent)", () => {
    for (const a of ACTIONS) {
      const defaults: Record<string, string | number> = {};
      for (const p of a.params) defaults[p.key] = p.type === "text" ? "Finder" : p.default;
      const script = macScript(a.id, normalizeArgs(a.id, defaults));
      expect(script.length).toBeGreaterThan(10);
    }
  });
  test("a mac step is validated when the button config is saved", () => {
    expect(() => validateStep({ type: "mac", action: "system.volume", args: { level: 999 } }, "s")).toThrow(ConfigError);
    expect(validateStep({ type: "mac", action: "music.playpause" }, "s")).toEqual({ type: "mac", action: "music.playpause", args: {} });
  });
});

describe("step chaining", () => {
  test("$PAD_OUT carries the previous step's output", async () => {
    const r = await runSteps([shell("echo hello"), shell('echo "got:$PAD_OUT"')]);
    expect(r.out).toBe("got:hello");
  });
  test("a failing step stops the chain, unless continueOnError", async () => {
    const stop = await runSteps([shell("exit 2"), shell("echo after")]);
    expect(stop.ok).toBe(false);
    expect(stop.steps).toHaveLength(1);

    const go = await runSteps([shell("exit 2", { continueOnError: true }), shell("echo after")]);
    expect(go.ok).toBe(true);
    expect(go.steps).toHaveLength(2);
    expect(go.steps[0]).toMatchObject({ ok: false, ignored: true });
    expect(go.out).toBe("after");
  });
  test("a false guard ends the chain silently; a broken guard is an error", async () => {
    const guarded = await runSteps([{ type: "when", cmd: "test -f /nonexistent/file" }, shell("echo never")]);
    expect(guarded.ok).toBe(true);
    expect(guarded.stopped).toBe(true);
    expect(guarded.steps).toHaveLength(1);

    const pass = await runSteps([{ type: "when", cmd: "true" }, shell("echo ran")]);
    expect(pass.out).toBe("ran");
    expect(pass.stopped).toBeUndefined();

    const broken = await runSteps([{ type: "when", cmd: "definitely-not-a-command-xyz" }, shell("echo never")]);
    expect(broken.ok).toBe(false);
    expect(broken.steps).toHaveLength(1);
  });
  test("continueOnError is stored only when true and never on a guard", () => {
    expect(validateSteps([shell("true", { continueOnError: true }), shell("true", { continueOnError: "yes" })])).toMatchObject([
      { continueOnError: true },
      {},
    ]);
    expect(validateSteps([shell("true", { continueOnError: "yes" })])[0]).not.toHaveProperty("continueOnError");
    expect(validateStep({ type: "when", cmd: "true", continueOnError: true }, "s")).toEqual({ type: "when", cmd: "true" });
  });
});

describe("latching buttons", () => {
  test("toggle is stored only on buttons, defaults off, and counts as an LED for the tablet", async () => {
    const { seedConfig, validateConfig, publicView } = await import("../lib/config.ts");
    const cfg = structuredClone(seedConfig());
    cfg.pages[0].buttons[0].toggle = true;
    const ok = validateConfig(cfg);
    expect(ok.pages[0].buttons[0].toggle).toBe(true);
    expect(ok.pages[0].buttons[1].toggle).toBe(false);
    expect(publicView(ok).pages[0].buttons[0].hasLed).toBe(true);
    cfg.pages[0].buttons.find((b) => b.kind === "fader")!.toggle = true;
    expect(validateConfig(cfg).pages[0].buttons.find((b) => b.kind === "fader")!.toggle).toBe(false);
  });
  test("remembered state flips, survives a restart, and is shown as the LED", async () => {
    const { createState } = await import("../lib/state.ts");
    const { seedConfig, validateConfig } = await import("../lib/config.ts");
    const { mkdtempSync } = await import("node:fs");
    const path = `${mkdtempSync("/tmp/tog-")}/toggles.json`;
    const cfg = structuredClone(seedConfig());
    cfg.pages[0].buttons[0].toggle = true;
    const c = validateConfig(cfg);
    const id = c.pages[0].buttons[0].id;
    const s1 = createState(() => c, () => "r", path);
    expect((await s1.get()).leds[id]).toBe(false);
    s1.flip(id);
    s1.invalidate();
    expect((await s1.get()).leds[id]).toBe(true);
    const s2 = createState(() => c, () => "r", path);
    expect((await s2.get()).leds[id]).toBe(true);
    s2.flip(id);
    s2.invalidate();
    expect((await s2.get()).leds[id]).toBe(false);
  });
});

describe("radio widget", () => {
  const radioCfg = (over: object, extra: object[] = []) => {
    const c = structuredClone(seedConfig());
    c.pages[0].buttons = [
      { ...c.pages[0].buttons[0], id: "r", col: 0, row: 2, kind: "radio", w: 3, ...over },
      ...extra,
    ] as typeof c.pages[0].buttons;
    return c;
  };
  test("a radio covers w cells: it must fit the grid and may not overlap a key", async () => {
    const { validateConfig, ConfigError } = await import("../lib/config.ts");
    expect(validateConfig(radioCfg({})).pages[0].buttons[0]).toMatchObject({ kind: "radio", w: 3, steps: [], hold: [], led: "", toggle: false });
    expect(() => validateConfig(radioCfg({ col: 2, w: 3 }))).toThrow(ConfigError); // 2 + 3 > 4 columns
    const base = seedConfig().pages[0].buttons[0];
    expect(() => validateConfig(radioCfg({}, [{ ...base, id: "x", col: 2, row: 2 }]))).toThrow(ConfigError); // under the radio
    expect(validateConfig(radioCfg({}, [{ ...base, id: "x", col: 3, row: 2 }])).pages[0].buttons).toHaveLength(2);
    for (const bad of [1, 5, 2.5, "3"]) expect(() => validateConfig(radioCfg({ w: bad }))).toThrow(ConfigError);
  });
  test("only one radio per pad, and the tablet is told its width", async () => {
    const { validateConfig, ConfigError, publicView } = await import("../lib/config.ts");
    const base = seedConfig().pages[0].buttons[0];
    expect(() => validateConfig(radioCfg({}, [{ ...base, id: "r2", col: 0, row: 1, kind: "radio", w: 2 }]))).toThrow(ConfigError);
    expect(publicView(validateConfig(radioCfg({}))).pages[0].buttons[0]).toMatchObject({ kind: "radio", w: 3 });
  });
  test("plain keys and faders always span one column, whatever the file says", async () => {
    const { validateConfig } = await import("../lib/config.ts");
    const c = structuredClone(seedConfig());
    (c.pages[0].buttons[0] as { w: number }).w = 4;
    expect(validateConfig(c).pages[0].buttons[0].w).toBe(1);
  });
});

describe("station tile", () => {
  test("kind station needs a known station, spans one column and has no actions of its own", async () => {
    const { validateConfig, ConfigError, publicView } = await import("../lib/config.ts");
    const mk = (over: object) => {
      const c = structuredClone(seedConfig());
      Object.assign(c.pages[0].buttons[0], { kind: "station", steps: [{ type: "shell", cmd: "true", cwd: "", timeout: 5 }], ...over });
      return c;
    };
    const ok = validateConfig(mk({ station: "virgin", w: 3 })).pages[0].buttons[0];
    expect(ok).toMatchObject({ kind: "station", station: "virgin", w: 1, steps: [], hold: [], led: "", toggle: false });
    expect(publicView(validateConfig(mk({ station: "virgin" }))).pages[0].buttons[0]).toMatchObject({ kind: "station", station: "virgin" });
    for (const bad of [{}, { station: "nope" }, { station: "" }, { station: 5 }]) expect(() => validateConfig(mk(bad))).toThrow(ConfigError);
    // a plain key never carries a station
    expect(validateConfig(seedConfig()).pages[0].buttons[0].station).toBe("");
  });
});
