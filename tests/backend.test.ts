import { describe, expect, test } from "bun:test";
import { ConfigError, faderValue, publicView, seedConfig, validateConfig, type PadConfig, type Step } from "../lib/config.ts";
import { editorAllowed, sameOriginOk } from "../lib/guard.ts";
import { keysScript, parseKeys, textScript } from "../lib/keys.ts";
import { runSteps } from "../lib/run.ts";

describe("keys", () => {
  test("combination with modifiers and a character", () => {
    expect(keysScript(parseKeys("Cmd+Shift+4"))).toBe(
      'tell application "System Events" to key code 21 using {command down, shift down}',
    );
  });
  test("tasti speciali usano key code; '+' come tasto finale", () => {
    expect(keysScript(parseKeys("ctrl+left"))).toBe('tell application "System Events" to key code 123 using {control down}');
    expect(parseKeys("cmd++")).toEqual({ mods: ["command"], kind: "char", value: "+" });
  });
  test("hostile or wrong input is rejected, prototype names included", () => {
    for (const bad of ["", "cmd+", "cmd+shift", "foo+a", "cmd+constructor", "toString", "cmd+ab"]) {
      expect(() => parseKeys(bad)).toThrow();
    }
  });
  test("text is escaped and newlines become Return", () => {
    const s = textScript('hello "x" \\ \nsecond');
    expect(s).toContain('keystroke "hello \\"x\\" \\\\ "');
    expect(s).toContain("key code 36");
  });
});

describe("config", () => {
  test("the seed is valid and the tablet never receives the commands", () => {
    const cfg = validateConfig(seedConfig());
    expect(JSON.stringify(publicView(cfg))).not.toMatch(/steps|osascript|keystroke|cmd\+/);
  });
  test("rejects overlapping cells, out-of-grid, duplicate ids, invalid steps", () => {
    const mk = (mut: (c: PadConfig) => void) => {
      const c = structuredClone(seedConfig());
      mut(c);
      return () => validateConfig(c);
    };
    const bad = (s: unknown) => [s] as unknown as Step[]; // deliberately invalid steps
    expect(mk((c) => (c.pages[0].buttons[1].col = 0))).toThrow(ConfigError);
    expect(mk((c) => (c.pages[0].buttons[0].col = 9))).toThrow(ConfigError);
    expect(mk((c) => (c.pages[0].buttons[1].id = c.pages[0].buttons[0].id))).toThrow(ConfigError);
    expect(mk((c) => (c.pages[0].buttons[0].steps = bad({ type: "rm-rf" })))).toThrow(ConfigError);
    expect(mk((c) => (c.pages[0].buttons[0].steps = bad({ type: "keys", keys: "cmd+nope" })))).toThrow(ConfigError);
    expect(mk((c) => (c.pages[0].buttons[0].steps = bad({ type: "http", url: "file:///etc/passwd" })))).toThrow(ConfigError);
  });
});

describe("guard", () => {
  test("l'editor richiede socket E Host in loopback (DNS rebinding)", () => {
    expect(editorAllowed("localhost:8430", "127.0.0.1")).toBe(true);
    expect(editorAllowed("[::1]:8430", "::1")).toBe(true);
    expect(editorAllowed("192.168.1.17:8430", "127.0.0.1")).toBe(false);
    expect(editorAllowed("evil.example:8430", "127.0.0.1")).toBe(false);
    expect(editorAllowed("localhost:8430", "192.168.1.50")).toBe(false);
    expect(editorAllowed("localhost:8430", undefined)).toBe(false);
    // LAN address opened from the Mac itself: source = the Mac's IP. From another device: no.
    const mine = ["192.168.1.17"];
    expect(editorAllowed("192.168.1.17:8430", "192.168.1.17", mine)).toBe(true);
    expect(editorAllowed("192.168.1.17:8430", "192.168.1.50", mine)).toBe(false);
    expect(editorAllowed("evil.example:8430", "192.168.1.17", mine)).toBe(false);
    expect(editorAllowed("192.168.1.99:8430", "192.168.1.17", mine)).toBe(false);
  });

  test("Origin from another site is rejected", () => {
    expect(sameOriginOk(null, "localhost:8430")).toBe(true);
    expect(sameOriginOk("http://localhost:8430", "localhost:8430")).toBe(true);
    expect(sameOriginOk("https://evil.example", "localhost:8430")).toBe(false);
    expect(sameOriginOk("null", "localhost:8430")).toBe(false);
  });
});
describe("hold, led, fader", () => {
  test("the tablet never sees hold, led and fader commands", () => {
    const view = JSON.stringify(publicView(validateConfig(seedConfig())));
    expect(view).not.toMatch(/osascript|"hold"|"led"|"fader":\{|PAD_VALUE|kiosk/);
    expect(view).toContain('"hasHold":true');
    expect(view).toContain('"hasLed":true');
  });
  test("a fader requires the set command; fields of the other kind are cleared", () => {
    const mk = (mut: (c: PadConfig) => void) => {
      const c = structuredClone(seedConfig());
      mut(c);
      return c;
    };
    const fader = (c: PadConfig) => c.pages[0].buttons.find((x) => x.kind === "fader")!;
    expect(() => validateConfig(mk((c) => (fader(c).fader.set = "  ")))).toThrow(ConfigError);
    const asButton = validateConfig(mk((c) => (fader(c).kind = "button")));
    expect(asButton.pages[0].buttons.find((x) => x.id === "volume")!.fader).toEqual({ get: "", set: "" });
    expect(() => validateConfig(mk((c) => (c.pages[0].buttons[0].kind = "fader")))).toThrow(ConfigError);
  });
  test("a file without the new fields (old pad.json) stays valid", () => {
    const old = JSON.parse(JSON.stringify(seedConfig()));
    for (const p of old.pages) for (const x of p.buttons) { delete x.kind; delete x.hold; delete x.led; delete x.fader; }
    old.pages[0].buttons = old.pages[0].buttons.filter((x: { id: string }) => x.id !== "volume");
    const cfg = validateConfig(old);
    expect(cfg.pages[0].buttons.every((x) => x.kind === "button" && x.hold.length === 0 && x.led === "")).toBe(true);
  });
  test("the fader value is an integer 0–100", () => {
    expect(faderValue(0)).toBe(0);
    expect(faderValue(100)).toBe(100);
    for (const bad of [-1, 101, 5.5, "50", null, undefined, "50; rm -rf ~"]) expect(() => faderValue(bad)).toThrow(ConfigError);
  });
  test("PAD_VALUE reaches commands as an environment variable, never interpolated", async () => {
    const r = await runSteps([{ type: "shell", cmd: 'echo "[$PAD_VALUE]"', cwd: "", timeout: 5 }], "x", { PAD_VALUE: "42" });
    expect(r.out).toBe("[42]");
  });
});

describe("run", () => {
  test("runs in order, captures output, stops at the first error", async () => {
    const r = await runSteps([
      { type: "shell", cmd: "echo hello; echo err >&2", cwd: "", timeout: 5 },
      { type: "shell", cmd: "exit 3", cwd: "", timeout: 5 },
      { type: "shell", cmd: "echo mai", cwd: "", timeout: 5 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].out).toBe("hello\nerr");
    expect(r.error).toContain("code 3");
  });
  test("timeout also kills the children", async () => {
    const t0 = performance.now();
    const r = await runSteps([{ type: "shell", cmd: "sleep 30 & sleep 30", cwd: "", timeout: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Timed out");
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  test("a background child does not block the button", async () => {
    const t0 = performance.now();
    const r = await runSteps([{ type: "shell", cmd: "(sleep 5 &) ; echo started", cwd: "", timeout: 20 }]);
    expect(r.ok).toBe(true);
    expect(r.out).toBe("started");
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
