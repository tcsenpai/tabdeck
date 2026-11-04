// Macro recorder, Mac side: runs tools/recorder.swift (a listen-only CGEventTap), collects the
// keyboard and mouse events it prints and turns them into pad steps. The helper is compiled on first
// use and runs only between start() and stop(). eventsToSteps is pure so the rules are testable.
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import type { Step } from "./config.ts";
import { parseKeys } from "./keys.ts";

export interface RecEvent {
  t: number; // ms since the helper's tap went live
  e: "key" | "click";
  code?: number;
  mods?: string[];
  ch?: string;
  button?: "left" | "right" | "middle";
  count?: number;
  x?: number;
  y?: number;
}

export interface ConvertOptions {
  pauseMs?: number; // a gap longer than this becomes a delay step (default 600)
  maxSteps?: number; // result cap (default 19; the pad allows 20 steps per button)
}

// ---------- events → steps ----------

const STEP_LIMIT = 20; // what validateSteps accepts
const TEXT_MAX = 5000; // longest text step validateSteps accepts
const FOLD_MS = 400; // the same shortcut again within this folds into `repeat`
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;
const MAX_REPEAT = 10;
const MAX_DELAY = 60000;
const CLICK_MAX = 20000;

// code → key name, built through parseKeys so the key tables of lib/keys.ts stay the only source
// (its CODES map is private). First name wins where several share a code (delete/backspace).
const KEY_NAMES = new Map<number, string>();
const CHARLESS = new Set<number>(); // keys that never type a character: always a shortcut
for (const name of [
  "return", "enter", "tab", "delete", "forwarddelete", "escape", "left", "right", "down", "up",
  "home", "end", "pageup", "pagedown", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "space", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
]) {
  const p = parseKeys(name);
  if (p.kind !== "code" || KEY_NAMES.has(p.value)) continue;
  KEY_NAMES.set(p.value, name);
  if (name !== "space" && !/^\d$/.test(name)) CHARLESS.add(p.value);
}

// Modifier key codes: left/right command, shift, option, control. A key event with one of these
// and no character is a modifier pressed on its own.
const MODIFIER_CODES = new Set([54, 55, 56, 58, 59, 60, 61, 62]);

const MOD_ORDER = ["cmd", "ctrl", "opt", "shift"];
const MOD_ALIASES: Record<string, string> = {
  cmd: "cmd", command: "cmd", meta: "cmd", super: "cmd",
  ctrl: "ctrl", control: "ctrl",
  opt: "opt", alt: "opt", option: "opt",
  shift: "shift",
};
const CHAR_NAMES: Record<string, string> = { "+": "plus" };

type Atom =
  | { t: number; kind: "text"; text: string }
  | { t: number; kind: "keys"; keys: string }
  | { t: number; kind: "click"; button: "left" | "right" | "middle"; rawCount: number; x: number; y: number };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

function normalizeMods(mods: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const m of mods ?? []) {
    const n = MOD_ALIASES[String(m).toLowerCase()];
    if (n) set.add(n);
  }
  return MOD_ORDER.filter((m) => set.has(m));
}

function keyAtom(e: RecEvent): Atom | null {
  const mods = normalizeMods(e.mods);
  const ch = typeof e.ch === "string" ? e.ch : "";
  const code = finite(e.code) ? e.code : undefined;
  if (ch === "" && code !== undefined && MODIFIER_CODES.has(code)) {
    return mods.length ? { t: e.t, kind: "keys", keys: mods.join("+") } : null;
  }
  const name = code === undefined ? undefined : KEY_NAMES.get(code);
  const shortcut = mods.some((m) => m !== "shift") || (code !== undefined && CHARLESS.has(code));
  if (!shortcut) return ch !== "" && !hasControl(ch) ? { t: e.t, kind: "text", text: ch } : null;
  let key = name;
  if (key === undefined && [...ch].length === 1 && !hasControl(ch) && ch !== " ") {
    key = CHAR_NAMES[ch] ?? ch.toLowerCase();
  }
  return key === undefined ? null : { t: e.t, kind: "keys", keys: [...mods, key].join("+") };
}

function clickAtom(e: RecEvent): Atom | null {
  if (e.button !== "left" && e.button !== "right" && e.button !== "middle") return null;
  if (!finite(e.x) || !finite(e.y)) return null;
  const clamp = (n: number) => Math.min(CLICK_MAX, Math.max(0, Math.round(n)));
  const rawCount = finite(e.count) && e.count >= 1 ? Math.floor(e.count) : 1;
  return { t: e.t, kind: "click", button: e.button, rawCount, x: clamp(e.x), y: clamp(e.y) };
}

// A double click arrives as count 1 and then count 2 at the same spot: only the last one counts.
function dropSupersededClicks(atoms: Atom[]): Atom[] {
  return atoms.filter((a, i) => {
    const next = atoms[i + 1];
    return !(
      a.kind === "click" && next?.kind === "click" &&
      next.button === a.button && next.rawCount === a.rawCount + 1 &&
      next.t - a.t <= MULTI_CLICK_MS &&
      Math.abs(next.x - a.x) <= MULTI_CLICK_PX && Math.abs(next.y - a.y) <= MULTI_CLICK_PX
    );
  });
}

// validateSteps rejects an all-blank text step: spaces typed alone become the space key instead.
function textStep(text: string): Step | null {
  if (text.trim() !== "") return { type: "text", text };
  const n = [...text].filter((c) => c === " ").length;
  if (n === 0) return null;
  return n === 1 ? { type: "keys", keys: "space" } : { type: "keys", keys: "space", repeat: Math.min(n, MAX_REPEAT), gap: 80 };
}

export function eventsToSteps(events: RecEvent[], opts: ConvertOptions = {}): Step[] {
  const pauseMs = opts.pauseMs ?? 600;
  const cap = Math.max(0, Math.min(STEP_LIMIT, Math.floor(opts.maxSteps ?? 19)));
  const ordered = events.filter((e) => finite(e.t)).sort((a, b) => a.t - b.t); // stable
  const atoms = dropSupersededClicks(
    ordered.flatMap((e): Atom[] => {
      const a = e.e === "key" ? keyAtom(e) : e.e === "click" ? clickAtom(e) : null;
      return a ? [a] : [];
    }),
  );

  const out: Step[] = [];
  let prev: Atom | undefined;
  for (const a of atoms) {
    const gap = prev ? a.t - prev.t : 0;
    const last = out[out.length - 1];
    if (a.kind === "text" && prev?.kind === "text" && last?.type === "text" && gap <= pauseMs && last.text.length + a.text.length <= TEXT_MAX) {
      last.text += a.text;
    } else if (
      a.kind === "keys" && prev?.kind === "keys" && last?.type === "keys" && last.keys === a.keys &&
      gap <= FOLD_MS && gap <= pauseMs && (last.repeat ?? 1) < MAX_REPEAT
    ) {
      last.gap ??= Math.min(1000, Math.round(gap / 10) * 10);
      last.repeat = (last.repeat ?? 1) + 1;
    } else {
      if (prev && out.length > 0 && gap > pauseMs) {
        out.push({ type: "delay", ms: Math.min(MAX_DELAY, Math.round(gap / 50) * 50) });
      }
      if (a.kind === "text") out.push({ type: "text", text: a.text });
      else if (a.kind === "keys") out.push({ type: "keys", keys: a.keys });
      else out.push({ type: "click", button: a.button, count: Math.min(3, a.rawCount), at: "point", x: a.x, y: a.y });
    }
    prev = a;
  }

  const steps = out.flatMap((s): Step[] => {
    if (s.type !== "text") return [s];
    const fixed = textStep(s.text);
    return fixed ? [fixed] : [];
  });
  steps.length = Math.min(steps.length, cap);
  while (steps.length > 0 && steps[steps.length - 1].type === "delay") steps.pop(); // a wait at the very end is pointless
  return steps;
}

// ---------- recorder process ----------

export interface RecState {
  state: "idle" | "starting" | "recording" | "error";
  error?: string;
  events: number;
}

export interface Recorder {
  start(): void; // no-op while a recording is already running or starting
  stop(): Step[]; // ends the recording, returns the converted steps ([] when none was running)
  status(): RecState;
  cancel(): void; // ends the recording and discards it
}

export interface RecorderOptions {
  dir: string; // data directory: holds the compiled helper and recorder.pid
  helper?: string[]; // argv used instead of compiling and running tools/recorder (tests)
  source?: string;
  maxMs?: number; // hard stop (default 120000)
  pauseMs?: number;
  maxSteps?: number;
}

type BuildResult = { ok: true } | { ok: false; error: string };

const SWIFTC = existsSync("/usr/bin/swiftc") ? "/usr/bin/swiftc" : "swiftc"; // launchd runs us with a minimal PATH
const COMPILE_MS = 120_000;
const MAX_EVENTS = 5000; // memory bound; far more than 2 minutes of human input
const PERMISSION_HINT = "Allow Input Monitoring for the process that runs the server (System Settings → Privacy & Security)";
const BUILD_HINT = "Install the Xcode Command Line Tools: xcode-select --install";

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        onLine(rest.slice(0, nl).trim());
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
      }
    }
  } catch {} // stream torn down with the process
}

function terminate(p: Subprocess) {
  try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} }
  // The helper switches its tap off on SIGTERM; anything that ignores it is killed shortly after.
  setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 1000);
}

function parseEvent(line: string): RecEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    const v = JSON.parse(line) as Partial<RecEvent> | null;
    if (!v || typeof v !== "object" || !finite(v.t) || (v.e !== "key" && v.e !== "click")) return null;
    return v as RecEvent;
  } catch {
    return null;
  }
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const maxMs = opts.maxMs ?? 120_000;
  const source = opts.source ?? `${import.meta.dir}/../tools/recorder.swift`;
  const bin = `${opts.dir}/recorder`;
  const pidFile = `${opts.dir}/recorder.pid`;

  // A helper left over by a server that was killed hard would keep listening to the keyboard.
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    const cmdline = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
    if (pid > 1 && cmdline.includes("recorder")) {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch {}
  try { unlinkSync(pidFile); } catch {}

  let state: RecState["state"] = "idle";
  let error: string | undefined;
  let events: RecEvent[] = [];
  let proc: Subprocess | null = null;
  let gen = 0; // bumped on every end, so a launch that was waiting on the compiler notices it is obsolete
  let limitTimer: Timer | undefined;
  let building: Promise<BuildResult> | null = null;

  const fail = (reason: string, hint?: string) => {
    const text = reason.trim().replace(/[.\s]+$/, "") || "The recorder failed";
    state = "error";
    error = hint ? `${text}. ${hint}.` : `${text}.`;
  };

  function buildFailure(msg: string): BuildResult {
    const text = msg.trim().replace(/\s+/g, " ");
    const short = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return { ok: false, error: `Could not build the recorder helper (${short || "no output"}). ${BUILD_HINT}` };
  }

  // Compiles tools/recorder.swift when the binary is missing or older than the source.
  // Async spawn: the event loop (and the pad) stays responsive during the build.
  async function compile(): Promise<BuildResult> {
    try {
      const srcTime = statSync(source).mtimeMs;
      if (existsSync(bin) && statSync(bin).mtimeMs >= srcTime) return { ok: true };
      const out = `${bin}.tmp`;
      const p = Bun.spawn([SWIFTC, "-O", source, "-o", out], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, COMPILE_MS);
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      clearTimeout(timer);
      if (timedOut) return buildFailure("swiftc timed out");
      if (code !== 0) return buildFailure(err || `swiftc exited with code ${code}`);
      renameSync(out, bin);
      return { ok: true };
    } catch (e) {
      return buildFailure(e instanceof Error ? e.message : String(e));
    }
  }

  function ensureBinary(): Promise<BuildResult> {
    building ??= compile().finally(() => { building = null; });
    return building;
  }

  function onStderr(p: Subprocess, line: string) {
    if (proc !== p || !line) return;
    if (line === "ready") {
      if (state === "starting") state = "recording";
    } else if (line.startsWith("error:")) {
      const reason = line.slice(6).trim() || "The recorder helper failed";
      if (state === "starting") fail(reason, PERMISSION_HINT);
      else fail(reason);
    }
  }

  function onExit(p: Subprocess, code: number | null) {
    if (proc !== p) return; // ended on purpose
    proc = null;
    clearTimeout(limitTimer);
    try { unlinkSync(pidFile); } catch {}
    if (state === "error") return; // the helper already said why
    if (state === "starting") fail(`The recorder helper exited before it was ready (exit code ${code ?? "?"})`, PERMISSION_HINT);
    else fail(`The recorder helper stopped unexpectedly (exit code ${code ?? "?"})`);
  }

  function spawnHelper(argv: string[], mine: number) {
    const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true }); // stdin stays open: EOF tells the helper we are gone
    proc = p;
    writeFileSync(pidFile, String(p.pid));
    void readLines(p.stdout, (line) => {
      if (proc !== p || events.length >= MAX_EVENTS) return;
      const ev = parseEvent(line);
      if (ev) events.push(ev);
    });
    void readLines(p.stderr, (line) => onStderr(p, line));
    void p.exited.then((code) => onExit(p, code));
    limitTimer = setTimeout(() => {
      if (gen !== mine || proc !== p) return;
      // Keep what was captured: stop() still returns it.
      proc = null;
      terminate(p);
      try { unlinkSync(pidFile); } catch {}
      fail(`Recording stopped after ${Math.round(maxMs / 1000)} s, the limit; press Stop to keep what was captured`);
    }, maxMs);
  }

  async function launch(mine: number): Promise<void> {
    let argv = opts.helper;
    if (!argv) {
      const built = await ensureBinary();
      if (gen !== mine) return;
      if (!built.ok) {
        state = "error";
        error = built.error;
        return;
      }
      argv = [bin];
    }
    try {
      spawnHelper(argv, mine);
    } catch (e) {
      fail(`Could not start the recorder helper: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Ends the helper and returns to idle; the collected events are returned to the caller.
  function end(): RecEvent[] {
    gen++;
    clearTimeout(limitTimer);
    limitTimer = undefined;
    const p = proc;
    proc = null;
    if (p) terminate(p);
    try { unlinkSync(pidFile); } catch {}
    const collected = events;
    events = [];
    state = "idle";
    error = undefined;
    return collected;
  }

  return {
    start() {
      if (state === "starting" || state === "recording") return;
      end(); // clears a previous error and its leftovers
      state = "starting";
      void launch(gen);
    },
    stop() {
      const was = state;
      const collected = end();
      return was === "idle" ? [] : eventsToSteps(collected, { pauseMs: opts.pauseMs, maxSteps: opts.maxSteps });
    },
    status() {
      return error === undefined ? { state, events: events.length } : { state, error, events: events.length };
    },
    cancel() {
      end();
    },
  };
}
