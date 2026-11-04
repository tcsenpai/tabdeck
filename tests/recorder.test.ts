import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { validateSteps, type Step } from "../lib/config.ts";
import { createRecorder, eventsToSteps, type RecEvent, type Recorder, type RecorderOptions } from "../lib/recorder.ts";

// Every conversion result must be something the pad accepts as one button's steps.
const convert = (events: RecEvent[], opts?: { pauseMs?: number; maxSteps?: number }): Step[] => {
  const steps = eventsToSteps(events, opts);
  expect(validateSteps(steps)).toEqual(steps);
  return steps;
};

const key = (t: number, code: number, ch: string, mods: string[] = []): RecEvent => ({ t, e: "key", code, mods, ch });
const click = (t: number, x: number, y: number, count = 1, button: "left" | "right" | "middle" = "left"): RecEvent => ({
  t, e: "click", button, count, x, y,
});
const typed = (t0: number, text: string, every = 60): RecEvent[] =>
  [...text].map((c, i) => key(t0 + i * every, 4, c, c !== c.toLowerCase() ? ["shift"] : []));

describe("eventsToSteps: keys", () => {
  test("no events, no steps", () => {
    expect(convert([])).toEqual([]);
  });

  test("a shortcut is named in canonical modifier order, whatever order the helper listed them", () => {
    expect(convert([key(0, 21, "4", ["shift", "cmd"])])).toEqual([{ type: "keys", keys: "cmd+shift+4" }]);
    expect(convert([key(0, 8, "c", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+c" }]);
    expect(convert([key(0, 0, "a", ["shift", "opt", "ctrl", "cmd"])])).toEqual([{ type: "keys", keys: "cmd+ctrl+opt+shift+a" }]);
    expect(convert([key(0, 14, "E", ["alt"])])).toEqual([{ type: "keys", keys: "opt+e" }]);
  });

  test("the digit row is named by key code, punctuation by its character", () => {
    expect(convert([key(0, 29, "0", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+0" }]);
    expect(convert([key(0, 24, "=", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+=" }]);
    expect(convert([key(0, 27, "-", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+-" }]);
    expect(convert([key(0, 24, "+", ["cmd", "shift"])])).toEqual([{ type: "keys", keys: "cmd+shift+plus" }]);
    expect(convert([key(0, 43, ",", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+," }]);
  });

  test("cmd+space and ctrl+space name the space key", () => {
    expect(convert([key(0, 49, " ", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+space" }]);
    expect(convert([key(0, 49, "", ["ctrl"])])).toEqual([{ type: "keys", keys: "ctrl+space" }]);
  });

  test("keys without a character are always key steps", () => {
    const steps = convert([
      key(0, 36, "\r"), key(100, 48, "\t"), key(200, 53, ""), key(300, 51, ""), key(400, 117, ""),
      key(500, 123, "", []), key(510, 126, "", ["shift"]), key(520, 122, ""), key(530, 111, "", ["cmd"]),
      key(540, 115, ""), key(550, 119, ""), key(560, 116, ""), key(570, 121, ""), key(580, 76, "\r"),
    ]);
    expect(steps.map((s) => (s.type === "keys" ? s.keys : s.type))).toEqual([
      "return", "tab", "escape", "delete", "forwarddelete", "left", "shift+up", "f1", "cmd+f12", "home", "end", "pageup", "pagedown", "enter",
    ]);
  });

  test("a modifier pressed and released alone is a modifier-only step", () => {
    expect(convert([key(0, 58, "", ["opt"])])).toEqual([{ type: "keys", keys: "opt" }]);
    expect(convert([key(0, 55, "", ["shift", "cmd"])])).toEqual([{ type: "keys", keys: "cmd+shift" }]);
    expect(convert([key(0, 58, "", [])])).toEqual([]); // nothing was held: nothing to say
  });

  test("keys that cannot be expressed are dropped, not turned into broken steps", () => {
    expect(convert([key(0, 200, "", ["cmd"]), key(10, 201, "\u0003", ["ctrl"]), key(20, 202, "ab", ["cmd"]), key(30, 203, "", [])])).toEqual([]);
  });
});

describe("eventsToSteps: text", () => {
  test("consecutive typed characters become one text step, shift included", () => {
    expect(convert(typed(0, "Hello, World!"))).toEqual([{ type: "text", text: "Hello, World!" }]);
  });

  test("a space inside typing stays in the text", () => {
    expect(convert(typed(0, "a b"))).toEqual([{ type: "text", text: "a b" }]);
    expect(convert([key(0, 4, "a"), key(50, 49, " "), key(100, 4, " "), key(150, 11, "b")])).toEqual([{ type: "text", text: "a  b" }]);
  });

  test("Return inside typing ends the text step and becomes its own step", () => {
    expect(convert([...typed(0, "hi"), key(200, 36, "\r"), ...typed(300, "yo")])).toEqual([
      { type: "text", text: "hi" },
      { type: "keys", keys: "return" },
      { type: "text", text: "yo" },
    ]);
  });

  test("a shortcut and Backspace inside typing also end the text step", () => {
    expect(convert([...typed(0, "ab"), key(100, 51, ""), ...typed(200, "c"), key(300, 0, "a", ["cmd"]), ...typed(400, "d")])).toEqual([
      { type: "text", text: "ab" },
      { type: "keys", keys: "delete" },
      { type: "text", text: "c" },
      { type: "keys", keys: "cmd+a" },
      { type: "text", text: "d" },
    ]);
  });

  test("typing stays below validateSteps's 5000-character limit by starting a new step", () => {
    const events = Array.from({ length: 5001 }, (_, i) => key(i * 5, 0, "a"));
    const steps = convert(events, { maxSteps: 20 });
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => (s.type === "text" ? s.text.length : 0))).toEqual([5000, 1]);
  });

  test("typed spaces alone become the space key (a blank text step is invalid)", () => {
    expect(convert([key(0, 49, " ")])).toEqual([{ type: "keys", keys: "space" }]);
    expect(convert([key(0, 49, " "), key(50, 49, " "), key(100, 49, " ")])).toEqual([
      { type: "keys", keys: "space", repeat: 3, gap: 80 },
    ]);
  });

  test("a dead key press (empty character) types nothing", () => {
    expect(convert([key(0, 14, ""), key(50, 14, "é")])).toEqual([{ type: "text", text: "é" }]);
  });
});

describe("eventsToSteps: clicks", () => {
  test("a click is a point click with integer coordinates", () => {
    expect(convert([click(0, 512.4, 300.6)])).toEqual([
      { type: "click", button: "left", count: 1, at: "point", x: 512, y: 301 },
    ]);
    expect(convert([click(0, 10, 20, 1, "right"), click(100, 30, 40, 1, "middle")])).toEqual([
      { type: "click", button: "right", count: 1, at: "point", x: 10, y: 20 },
      { type: "click", button: "middle", count: 1, at: "point", x: 30, y: 40 },
    ]);
  });

  test("a double click arrives as count 1 then count 2: only the count 2 is kept", () => {
    expect(convert([click(0, 100, 100, 1), click(90, 100, 100, 2)])).toEqual([
      { type: "click", button: "left", count: 2, at: "point", x: 100, y: 100 },
    ]);
  });

  test("a triple click keeps only the count 3, and a fourth rapid click is capped at 3", () => {
    expect(convert([click(0, 5, 5, 1), click(80, 5, 5, 2), click(160, 5, 5, 3)])).toEqual([
      { type: "click", button: "left", count: 3, at: "point", x: 5, y: 5 },
    ]);
    expect(convert([click(0, 5, 5, 1), click(80, 5, 5, 2), click(160, 5, 5, 3), click(240, 5, 5, 4)])).toEqual([
      { type: "click", button: "left", count: 3, at: "point", x: 5, y: 5 },
    ]);
  });

  test("a click that is not followed by its multi-click stays", () => {
    // different spot, too late, other button, or no count 2 at all
    const far = convert([click(0, 100, 100, 1), click(90, 300, 100, 2)]);
    expect(far.map((s) => (s.type === "click" ? s.count : 0))).toEqual([1, 2]);
    const late = convert([click(0, 100, 100, 1), click(550, 100, 100, 2)], { pauseMs: 5000 });
    expect(late.map((s) => (s.type === "click" ? s.count : 0))).toEqual([1, 2]);
    const other = convert([click(0, 100, 100, 1, "left"), click(90, 100, 100, 2, "right")]);
    expect(other).toHaveLength(2);
    const twoSingles = convert([click(0, 100, 100, 1), click(90, 100, 100, 1)]);
    expect(twoSingles).toHaveLength(2);
  });

  test("a one-pixel jitter between the two clicks still counts as the same spot", () => {
    expect(convert([click(0, 100, 100, 1), click(90, 101, 99, 2)])).toEqual([
      { type: "click", button: "left", count: 2, at: "point", x: 101, y: 99 },
    ]);
  });

  test("coordinates are clamped into what a click step accepts", () => {
    expect(convert([click(0, -50, 99999)])).toEqual([{ type: "click", button: "left", count: 1, at: "point", x: 0, y: 20000 }]);
  });

  test("malformed click events are dropped", () => {
    const bad = [
      { t: 0, e: "click", button: "left" },
      { t: 1, e: "click", x: 1, y: 2 },
      { t: 2, e: "click", button: "back", x: 1, y: 2 },
      { t: 3, e: "click", button: "left", x: Number.NaN, y: 2 },
    ] as unknown as RecEvent[];
    expect(convert(bad)).toEqual([]);
  });
});

describe("eventsToSteps: pauses", () => {
  test("a gap longer than the pause threshold becomes a delay rounded to 50 ms", () => {
    expect(convert([key(0, 8, "c", ["cmd"]), key(720, 9, "v", ["cmd"])])).toEqual([
      { type: "keys", keys: "cmd+c" },
      { type: "delay", ms: 700 },
      { type: "keys", keys: "cmd+v" },
    ]);
    expect(convert([click(0, 1, 1), click(1000 + 25, 2, 2)]).map((s) => (s.type === "delay" ? s.ms : -1))).toEqual([-1, 1050, -1]);
  });

  test("a gap of exactly the threshold is not a pause", () => {
    expect(convert([click(0, 1, 1), click(600, 2, 2)])).toHaveLength(2);
    expect(convert([click(0, 1, 1), click(601, 2, 2)])).toHaveLength(3);
  });

  test("the delay is capped at 60 seconds", () => {
    const steps = convert([click(0, 1, 1), click(90_000, 2, 2)]);
    expect(steps[1]).toEqual({ type: "delay", ms: 60000 });
  });

  test("the threshold is configurable", () => {
    const events = [click(0, 1, 1), click(300, 2, 2)];
    expect(convert(events)).toHaveLength(2);
    expect(convert(events, { pauseMs: 200 })).toEqual([
      { type: "click", button: "left", count: 1, at: "point", x: 1, y: 1 },
      { type: "delay", ms: 300 },
      { type: "click", button: "left", count: 1, at: "point", x: 2, y: 2 },
    ]);
  });

  test("time before the first event and after the last never becomes a delay", () => {
    expect(convert([click(5000, 1, 1)])).toHaveLength(1);
    expect(convert([click(5000, 1, 1), click(5010, 2, 2)])).toHaveLength(2);
  });

  test("a pause inside typing splits the text around a delay", () => {
    expect(convert([...typed(0, "ab"), ...typed(2000, "cd")])).toEqual([
      { type: "text", text: "ab" },
      { type: "delay", ms: 1950 },
      { type: "text", text: "cd" },
    ]);
  });

  test("events given out of order are sorted by time", () => {
    expect(convert([key(300, 9, "v", ["cmd"]), key(0, 8, "c", ["cmd"])])).toEqual([
      { type: "keys", keys: "cmd+c" },
      { type: "keys", keys: "cmd+v" },
    ]);
  });

  test("events without a usable timestamp are skipped", () => {
    const bad = [{ e: "key", code: 8, mods: ["cmd"], ch: "c" }, { t: Number.NaN, e: "key", code: 8, mods: ["cmd"], ch: "c" }] as unknown as RecEvent[];
    expect(convert(bad)).toEqual([]);
  });
});

describe("eventsToSteps: repeats", () => {
  test("the same shortcut again within 400 ms folds into one step with repeat and gap", () => {
    expect(convert([key(0, 6, "z", ["cmd"]), key(100, 6, "z", ["cmd"]), key(200, 6, "z", ["cmd"])])).toEqual([
      { type: "keys", keys: "cmd+z", repeat: 3, gap: 100 },
    ]);
    expect(convert([key(0, 125, ""), key(104, 125, "")])).toEqual([{ type: "keys", keys: "down", repeat: 2, gap: 100 }]);
  });

  test("a gap of 400 ms still folds, 401 ms does not", () => {
    expect(convert([key(0, 6, "z", ["cmd"]), key(400, 6, "z", ["cmd"])])).toEqual([{ type: "keys", keys: "cmd+z", repeat: 2, gap: 400 }]);
    expect(convert([key(0, 6, "z", ["cmd"]), key(401, 6, "z", ["cmd"])])).toHaveLength(2);
  });

  test("the repeat count stops at 10, then a new step starts", () => {
    const events = Array.from({ length: 12 }, (_, i) => key(i * 50, 125, ""));
    expect(convert(events)).toEqual([
      { type: "keys", keys: "down", repeat: 10, gap: 50 },
      { type: "keys", keys: "down", repeat: 2, gap: 50 },
    ]);
  });

  test("different shortcuts, or something in between, do not fold", () => {
    expect(convert([key(0, 6, "z", ["cmd"]), key(50, 6, "z", ["cmd", "shift"])])).toHaveLength(2);
    expect(convert([key(0, 6, "z", ["cmd"]), click(50, 1, 1), key(100, 6, "z", ["cmd"])])).toHaveLength(3);
  });

  test("plain typed characters are never folded: 'll' stays text", () => {
    expect(convert([key(0, 37, "l"), key(50, 37, "l")])).toEqual([{ type: "text", text: "ll" }]);
  });
});

describe("eventsToSteps: caps", () => {
  const manyClicks = (n: number) => Array.from({ length: n }, (_, i) => click(i * 100, i, i));

  test("the result is cut at 19 steps by default, in order", () => {
    const steps = convert(manyClicks(40));
    expect(steps).toHaveLength(19);
    expect(steps.map((s) => (s.type === "click" ? s.x : -1))).toEqual(Array.from({ length: 19 }, (_, i) => i));
  });

  test("maxSteps is honoured and never exceeds the 20 steps a button allows", () => {
    expect(convert(manyClicks(40), { maxSteps: 5 })).toHaveLength(5);
    expect(convert(manyClicks(40), { maxSteps: 20 })).toHaveLength(20);
    expect(convert(manyClicks(40), { maxSteps: 500 })).toHaveLength(20);
    expect(convert(manyClicks(40), { maxSteps: 0 })).toEqual([]);
  });

  test("a delay left dangling at the end by the cut is removed", () => {
    // click, delay, click, delay ... cut after a delay
    const events = Array.from({ length: 6 }, (_, i) => click(i * 1000, i, i));
    const steps = convert(events, { maxSteps: 4 });
    expect(steps.map((s) => s.type)).toEqual(["click", "delay", "click"]);
  });

  test("mixed recordings validate", () => {
    const steps = convert([
      key(0, 8, "c", ["cmd"]),
      ...typed(300, "hello"),
      click(700, 400, 300, 1),
      click(780, 400, 300, 2),
      key(1500, 36, "\r"),
    ]);
    expect(steps.map((s) => s.type)).toEqual(["keys", "text", "click", "delay", "keys"]);
  });
});

// ---------- the recorder with fake helpers ----------
// Real child processes (sh), and tests wait for a condition rather than a guessed duration. The
// machine can be heavily loaded, so every wait has a generous timeout.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (dir: string) => Number(readFileSync(`${dir}/recorder.pid`, "utf8"));
async function until(cond: () => boolean, what: string, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}
const tmp = () => mkdtempSync("/tmp/recorder-");
const sh = (script: string) => ["/bin/sh", "-c", script, "recorder-fake"];
const line = (e: RecEvent) => `echo '${JSON.stringify(e)}'`;
const CMD_C = line(key(0, 8, "c", ["cmd"]));
const CLICK = line(click(100, 40, 50));
// Prints `ready` and two events, then stays alive like the real helper.
const STEADY = sh(`echo ready >&2; ${CMD_C}; ${CLICK}; exec sleep 30`);

const recorders: Recorder[] = [];
afterEach(() => { for (const r of recorders.splice(0)) r.cancel(); });
const make = (opts: Partial<RecorderOptions> & { dir: string }) => {
  const r = createRecorder(opts);
  recorders.push(r);
  return r;
};

describe("recorder lifecycle", () => {
  test("start, record, stop: the events come back as steps and the helper is gone", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: STEADY });
    expect(rec.status()).toEqual({ state: "idle", events: 0 });
    rec.start();
    expect(rec.status().state).toBe("starting");
    await until(() => rec.status().state === "recording" && rec.status().events === 2, "recording with two events");
    const pid = pidOf(dir);
    expect(alive(pid)).toBe(true);
    expect(rec.stop()).toEqual([
      { type: "keys", keys: "cmd+c" },
      { type: "click", button: "left", count: 1, at: "point", x: 40, y: 50 },
    ]);
    expect(rec.status()).toEqual({ state: "idle", events: 0 });
    await until(() => !alive(pid), "helper to exit on SIGTERM");
    expect(existsSync(`${dir}/recorder.pid`)).toBe(false);
  });

  test("stop() with nothing running returns no steps", () => {
    const rec = make({ dir: tmp(), helper: STEADY });
    expect(rec.stop()).toEqual([]);
    expect(rec.status().state).toBe("idle");
  });

  test("stop() before the helper is ready returns no steps and abandons the start", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: sh("sleep 0.2; echo ready >&2; exec sleep 30") });
    rec.start();
    await until(() => existsSync(`${dir}/recorder.pid`), "helper to spawn");
    const pid = pidOf(dir);
    expect(rec.stop()).toEqual([]);
    expect(rec.status().state).toBe("idle");
    await until(() => !alive(pid), "helper to be killed");
    await Bun.sleep(300); // negative check: its late `ready` must not revive the recorder
    expect(rec.status().state).toBe("idle");
  });

  test("cancel discards the recording", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: STEADY });
    rec.start();
    await until(() => rec.status().events === 2, "two events");
    const pid = pidOf(dir);
    rec.cancel();
    expect(rec.status()).toEqual({ state: "idle", events: 0 });
    expect(rec.stop()).toEqual([]);
    await until(() => !alive(pid), "helper to exit");
  });

  test("only one recording at a time: a second start() while recording does nothing", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: STEADY });
    rec.start();
    await until(() => rec.status().state === "recording", "recording");
    const pid = pidOf(dir);
    rec.start();
    expect(pidOf(dir)).toBe(pid);
    expect(rec.status().state).toBe("recording");
    expect(rec.stop()).toHaveLength(2);
  });

  test("a new recording after a stop starts from zero", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: STEADY });
    rec.start();
    await until(() => rec.status().events === 2, "first recording");
    rec.stop();
    rec.start();
    await until(() => rec.status().events === 2, "second recording");
    expect(rec.stop()).toHaveLength(2);
  });

  test("lines that are not events are ignored", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: sh(`echo ready >&2; echo garbage; echo '{"t":1}'; echo '{"t":2,"e":"scroll"}'; ${CMD_C}; exec sleep 30`) });
    rec.start();
    await until(() => rec.status().events >= 1, "the one valid event");
    await Bun.sleep(100); // negative check: the invalid lines must not show up later
    expect(rec.status().events).toBe(1);
    expect(rec.stop()).toEqual([{ type: "keys", keys: "cmd+c" }]);
  });
});

describe("recorder errors", () => {
  test("an error line before ready is an error status with the reason and the permission hint", async () => {
    const rec = make({ dir: tmp(), helper: sh("echo 'error: Input Monitoring permission is not granted' >&2; exit 2") });
    rec.start();
    await until(() => rec.status().state === "error", "error state");
    const msg = rec.status().error ?? "";
    expect(msg).toContain("Input Monitoring permission is not granted");
    expect(msg).toContain("Allow Input Monitoring for the process that runs the server (System Settings → Privacy & Security)");
    expect(rec.stop()).toEqual([]);
    expect(rec.status()).toEqual({ state: "idle", events: 0 });
  });

  test("an exit before ready without a message is an error with the exit code and the hint", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: sh("exit 3") });
    rec.start();
    await until(() => rec.status().state === "error", "error state");
    const msg = rec.status().error ?? "";
    expect(msg).toContain("exit code 3");
    expect(msg).toContain("Input Monitoring");
    expect(existsSync(`${dir}/recorder.pid`)).toBe(false);
  });

  test("a helper that dies while recording is an error, but what it captured is still returned by stop()", async () => {
    const rec = make({ dir: tmp(), helper: sh(`echo ready >&2; ${CMD_C}; sleep 0.1; exit 1`) });
    rec.start();
    await until(() => rec.status().state === "error", "error state");
    expect(rec.status().error).toContain("stopped unexpectedly");
    expect(rec.status().error).not.toContain("Input Monitoring");
    expect(rec.status().events).toBe(1);
    expect(rec.stop()).toEqual([{ type: "keys", keys: "cmd+c" }]);
  });

  test("an error line after ready is an error too", async () => {
    const rec = make({ dir: tmp(), helper: sh("echo ready >&2; sleep 0.1; echo 'error: tap disabled' >&2; exec sleep 30") });
    rec.start();
    await until(() => rec.status().state === "error", "error state");
    expect(rec.status().error).toBe("tap disabled.");
  });

  test("start() after an error tries again", async () => {
    const dir = tmp();
    const flag = `${dir}/second-run`;
    const rec = make({ dir, helper: sh(`if [ -e ${flag} ]; then echo ready >&2; ${CMD_C}; exec sleep 30; fi; touch ${flag}; exit 2`) });
    rec.start();
    await until(() => rec.status().state === "error", "first run to fail");
    rec.start();
    await until(() => rec.status().state === "recording" && rec.status().events === 1, "second run to record");
    expect(rec.status().error).toBeUndefined();
    expect(rec.stop()).toHaveLength(1);
  });

  test("a helper that cannot be spawned is an error status", async () => {
    const rec = make({ dir: tmp(), helper: ["/nonexistent/recorder-helper"] });
    rec.start();
    await until(() => rec.status().state === "error", "error state");
    expect(rec.status().error).toContain("Could not start the recorder helper");
  });

  test("a missing source file is a build error with an install hint", async () => {
    const dir = tmp();
    const rec = make({ dir, source: `${dir}/nope.swift` });
    rec.start();
    await until(() => rec.status().state === "error", "build error");
    expect(rec.status().error).toContain("Could not build the recorder helper");
    expect(rec.status().error).toContain("xcode-select --install");
    expect(existsSync(`${dir}/recorder`)).toBe(false);
    expect(existsSync(`${dir}/recorder.pid`)).toBe(false);
  });

  test("the hard limit stops the helper but keeps what was captured for stop()", async () => {
    const dir = tmp();
    const rec = make({ dir, helper: STEADY, maxMs: 300 });
    rec.start();
    await until(() => rec.status().state === "error", "the limit to hit", 15_000);
    expect(rec.status().error).toContain("Recording stopped after");
    expect(rec.status().events).toBe(2);
    expect(existsSync(`${dir}/recorder.pid`)).toBe(false);
    expect(rec.stop()).toHaveLength(2);
    expect(rec.status().state).toBe("idle");
  });

  test("the limit timer does not fire after a normal stop", async () => {
    const rec = make({ dir: tmp(), helper: STEADY, maxMs: 200 });
    rec.start();
    await until(() => rec.status().events === 2, "two events");
    rec.stop();
    await Bun.sleep(400); // negative check: only a real timer can show up here
    expect(rec.status().state).toBe("idle");
  });
});

describe("recorder orphans", () => {
  test("a helper left behind by a killed server is stopped at the next start", async () => {
    const dir = tmp();
    // "sleep 30; true" keeps sh from exec'ing, so the command line still contains the marker.
    const orphan = Bun.spawn(["/bin/sh", "-c", "sleep 30; true", "recorder-orphan"], { detached: true });
    await Bun.write(`${dir}/recorder.pid`, String(orphan.pid));
    expect(alive(orphan.pid)).toBe(true);
    make({ dir, helper: STEADY });
    await until(() => !alive(orphan.pid), "orphan to be stopped");
    expect(existsSync(`${dir}/recorder.pid`)).toBe(false);
  });

  test("a stale pid that now belongs to something else is left alone", async () => {
    const dir = tmp();
    const other = Bun.spawn(["sleep", "30"], { detached: true });
    await Bun.write(`${dir}/recorder.pid`, String(other.pid));
    make({ dir, helper: STEADY });
    await Bun.sleep(100); // negative check: nothing may happen to the other process
    expect(alive(other.pid)).toBe(true);
    process.kill(other.pid, "SIGKILL");
  });
});

// ---------- the real helper, --test-script only ----------
// The real tap would pop a macOS permission dialog and record the user's actual typing, so only
// the canned script runs.
const HAS_SWIFTC = existsSync("/usr/bin/swiftc");
const HELPER_SOURCE = `${import.meta.dir}/../tools/recorder.swift`;
let builtDir: string | undefined;
async function buildHelper(): Promise<string> {
  if (builtDir) return builtDir;
  const dir = tmp();
  const build = Bun.spawn(["/usr/bin/swiftc", "-O", HELPER_SOURCE, "-o", `${dir}/recorder`], { stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  expect(err).toBe("");
  expect(code).toBe(0);
  builtDir = dir;
  return dir;
}

const SCRIPT_STEPS: Step[] = [
  { type: "keys", keys: "cmd+c" },
  { type: "text", text: "hello" },
  { type: "click", button: "left", count: 2, at: "point", x: 400, y: 300 },
  { type: "delay", ms: 700 },
  { type: "keys", keys: "return" },
];

describe("real helper (--test-script)", () => {
  test.skipIf(!HAS_SWIFTC)("prints ready and the canned events as JSON lines, and exits on SIGTERM", async () => {
    const dir = await buildHelper();
    const p = Bun.spawn([`${dir}/recorder`, "--test-script"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines: string[] = [];
    void (async () => {
      let rest = "";
      for await (const chunk of p.stdout) {
        rest += new TextDecoder().decode(chunk);
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        lines.push(...parts);
      }
    })();
    await until(() => lines.length >= 9, "nine event lines", 60_000);
    const events = lines.map((l) => JSON.parse(l) as RecEvent);
    expect(events[0]).toEqual({ t: 0, e: "key", code: 8, mods: ["cmd"], ch: "c" });
    expect(events[6]).toEqual({ t: 700, e: "click", button: "left", count: 1, x: 400, y: 300 });
    expect(events[8]).toEqual({ t: 1500, e: "key", code: 36, mods: [], ch: "\r" });
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stderr).text()).toBe("ready\n");
  }, 120_000);

  test.skipIf(!HAS_SWIFTC)("exits cleanly when its stdin closes", async () => {
    const dir = await buildHelper();
    const p = Bun.spawn([`${dir}/recorder`, "--test-script"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    p.stdin.end();
    expect(await p.exited).toBe(0);
  }, 120_000);

  test.skipIf(!HAS_SWIFTC)("an unknown argument is an error on stderr with exit code 2", async () => {
    const dir = await buildHelper();
    const p = Bun.spawn([`${dir}/recorder`, "--bogus"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toStartWith("error:");
  }, 120_000);

  test.skipIf(!HAS_SWIFTC)("through the module: the canned recording becomes the expected steps", async () => {
    const built = await buildHelper();
    const dir = tmp();
    const rec = make({ dir, helper: [`${built}/recorder`, "--test-script"] });
    rec.start();
    await until(() => rec.status().state === "recording" && rec.status().events >= 9, "the canned events", 60_000);
    const pid = pidOf(dir);
    expect(rec.stop()).toEqual(SCRIPT_STEPS);
    await until(() => !alive(pid), "helper to exit on SIGTERM");
    expect(existsSync(`${dir}/recorder.pid`)).toBe(false);
  }, 120_000);

  test.skipIf(!HAS_SWIFTC)("the canned events convert to steps validateSteps accepts", () => {
    expect(validateSteps(SCRIPT_STEPS)).toEqual(SCRIPT_STEPS);
  });
});

test("no helper process is left behind", async () => {
  for (const r of recorders.splice(0)) r.cancel();
  await until(() => Bun.spawnSync(["pgrep", "-f", "recorder-(fake|orphan)"]).exitCode !== 0, "fake helpers to be gone");
});
