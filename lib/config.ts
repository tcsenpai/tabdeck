// Pad configuration: schema, strict validation, atomic persistence.
// The file is the single source of truth; the server keeps no derived state.
import { existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseKeys } from "./keys.ts";
import { MOUSE_BUTTONS, type MouseButton } from "./mouse.ts";
import { normalizeArgs, type Args } from "./macos.ts";

export const COLORS = ["slate", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type Color = (typeof COLORS)[number];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export type StepBody =
  | { type: "shell"; cmd: string; cwd: string; timeout: number }
  | { type: "applescript"; script: string }
  | { type: "mac"; action: string; args: Args }
  | { type: "keys"; keys: string; repeat?: number; gap?: number } // repeat/gap are stored only when repeat > 1
  | { type: "text"; text: string }
  | { type: "open"; target: string; app: string }
  | { type: "http"; method: string; url: string; headers: Record<string, string>; body: string }
  | { type: "when"; cmd: string } // shell guard: exit 0 = continue, otherwise stop silently
  | { type: "click"; button: MouseButton; count: number; at: "cursor" | "point"; x: number; y: number }
  | { type: "delay"; ms: number };
// continueOnError: a failure of this step is reported but does not stop the chain.
export type Step = StepBody & { continueOnError?: boolean };

export interface Fader {
  get: string; // prints 0–100
  set: string; // receives the value in $PAD_VALUE
}
export interface Button {
  id: string;
  col: number;
  row: number;
  label: string;
  icon: string;
  color: Color;
  kind: "button" | "fader";
  confirm: boolean;
  showOutput: boolean;
  steps: Step[];
  hold: Step[]; // long press (kind "button" only)
  led: string; // shell command: exit 0 = on (kind "button" only)
  toggle: boolean; // latching: the pad remembers on/off, flipped by each successful tap (ignored when `led` is set)
  fader: Fader; // kind "fader" only
}
export interface Page {
  id: string;
  name: string;
  cols: number;
  rows: number;
  buttons: Button[];
}
export interface PadConfig {
  version: 1;
  pages: Page[];
}

export class ConfigError extends Error {}

const ID_RE = /^[a-z0-9_-]{1,40}$/;
const LIMITS = { pages: 12, cols: 8, rows: 6, steps: 20, headers: 20 };

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where}: expected an object`);
  return v as Record<string, unknown>;
}
function arr(v: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new ConfigError(`${where}: expected a list`);
  if (v.length > max) throw new ConfigError(`${where}: at most ${max} items`);
  return v;
}
function str(v: unknown, where: string, o: { max?: number; required?: boolean } = {}): string {
  const { max = 200, required = false } = o;
  if (v === undefined || v === null) {
    if (required) throw new ConfigError(`${where}: required`);
    return "";
  }
  if (typeof v !== "string") throw new ConfigError(`${where}: expected a string`);
  if (required && !v.trim()) throw new ConfigError(`${where}: required`);
  if (v.length > max) throw new ConfigError(`${where}: at most ${max} characters`);
  return v;
}
function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${where}: integer between ${min} and ${max}`);
  }
  return v;
}
function id(v: unknown, where: string): string {
  const s = str(v, where, { required: true, max: 40 });
  if (!ID_RE.test(s)) throw new ConfigError(`${where}: invalid id (a-z 0-9 _ -)`);
  return s;
}

export function validateStep(raw: unknown, where: string): Step {
  const body = validateStepBody(raw, where);
  const flag = obj(raw, where).continueOnError === true && body.type !== "when";
  return flag ? { ...body, continueOnError: true } : body;
}

function validateStepBody(raw: unknown, where: string): StepBody {
  const s = obj(raw, where);
  switch (s.type) {
    case "shell":
      return {
        type: "shell",
        cmd: str(s.cmd, `${where}.cmd`, { required: true, max: 20000 }),
        cwd: str(s.cwd, `${where}.cwd`, { max: 500 }),
        timeout: s.timeout === undefined ? 30 : int(s.timeout, `${where}.timeout`, 1, 300),
      };
    case "mac": {
      const action = str(s.action, `${where}.action`, { required: true, max: 60 });
      try {
        return { type: "mac", action, args: normalizeArgs(action, s.args) };
      } catch (e) {
        throw new ConfigError(`${where}.args: ${(e as Error).message}`);
      }
    }
    case "when":
      return { type: "when", cmd: str(s.cmd, `${where}.cmd`, { required: true, max: 20000 }) };
    case "applescript":
      return { type: "applescript", script: str(s.script, `${where}.script`, { required: true, max: 20000 }) };
    case "keys": {
      const keys = str(s.keys, `${where}.keys`, { required: true, max: 60 });
      try {
        parseKeys(keys);
      } catch (e) {
        throw new ConfigError(`${where}.keys: ${(e as Error).message}`);
      }
      const repeat = s.repeat === undefined ? 1 : int(s.repeat, `${where}.repeat`, 1, 10);
      if (repeat === 1) return { type: "keys", keys };
      return { type: "keys", keys, repeat, gap: s.gap === undefined ? 80 : int(s.gap, `${where}.gap`, 0, 1000) };
    }
    case "text":
      return { type: "text", text: str(s.text, `${where}.text`, { required: true, max: 5000 }) };
    case "open":
      return {
        type: "open",
        target: str(s.target, `${where}.target`, { max: 1000 }),
        app: str(s.app, `${where}.app`, { max: 200 }),
      };
    case "http": {
      const method = str(s.method ?? "GET", `${where}.method`, { required: true, max: 10 }).toUpperCase();
      if (!METHODS.includes(method)) throw new ConfigError(`${where}.method: ${METHODS.join("/")}`);
      const url = str(s.url, `${where}.url`, { required: true, max: 2000 });
      if (!/^https?:\/\//i.test(url)) throw new ConfigError(`${where}.url: must start with http:// or https://`);
      const headers: Record<string, string> = {};
      const h = s.headers === undefined ? {} : obj(s.headers, `${where}.headers`);
      const names = Object.keys(h);
      if (names.length > LIMITS.headers) throw new ConfigError(`${where}.headers: massimo ${LIMITS.headers}`);
      for (const k of names) headers[str(k, `${where}.headers`, { required: true, max: 100 })] = str(h[k], `${where}.headers.${k}`, { max: 2000 });
      return { type: "http", method, url, headers, body: str(s.body, `${where}.body`, { max: 20000 }) };
    }
    case "click": {
      const button = s.button === undefined ? "left" : s.button;
      if (!MOUSE_BUTTONS.includes(button as MouseButton)) throw new ConfigError(`${where}.button: ${MOUSE_BUTTONS.join("/")}`);
      const at = s.at === undefined ? "cursor" : s.at;
      if (at !== "cursor" && at !== "point") throw new ConfigError(`${where}.at: cursor/point`);
      return {
        type: "click",
        button: button as MouseButton,
        count: s.count === undefined ? 1 : int(s.count, `${where}.count`, 1, 3),
        at,
        x: at === "point" ? int(s.x, `${where}.x`, 0, 20000) : 0,
        y: at === "point" ? int(s.y, `${where}.y`, 0, 20000) : 0,
      };
    }
    case "delay":
      return { type: "delay", ms: int(s.ms, `${where}.ms`, 0, 60000) };
    default:
      throw new ConfigError(`${where}.type: unknown action type`);
  }
}

export function validateSteps(raw: unknown, where = "steps"): Step[] {
  const steps = arr(raw, where, LIMITS.steps).map((s, i) => validateStep(s, `${where}[${i}]`));
  for (const s of steps) {
    if (s.type === "open" && !s.target.trim() && !s.app.trim()) {
      throw new ConfigError(`${where}: "open" needs an address/file or an app`);
    }
  }
  return steps;
}

export function validateConfig(raw: unknown): PadConfig {
  const root = obj(raw, "config");
  const pageIds: Record<string, true> = {};
  const buttonIds: Record<string, true> = {};
  const pages: Page[] = arr(root.pages, "pages", LIMITS.pages).map((p, pi) => {
    const w = `pages[${pi}]`;
    const page = obj(p, w);
    const pid = id(page.id, `${w}.id`);
    if (pageIds[pid]) throw new ConfigError(`${w}.id: duplicate`);
    pageIds[pid] = true;
    const cols = int(page.cols, `${w}.cols`, 1, LIMITS.cols);
    const rows = int(page.rows, `${w}.rows`, 1, LIMITS.rows);
    const cells: Record<string, true> = {};
    const buttons: Button[] = arr(page.buttons, `${w}.buttons`, cols * rows).map((b, bi) => {
      const bw = `${w}.buttons[${bi}]`;
      const btn = obj(b, bw);
      const bid = id(btn.id, `${bw}.id`);
      if (buttonIds[bid]) throw new ConfigError(`${bw}.id: duplicate`);
      buttonIds[bid] = true;
      const col = int(btn.col, `${bw}.col`, 0, cols - 1);
      const row = int(btn.row, `${bw}.row`, 0, rows - 1);
      if (cells[`${col},${row}`]) throw new ConfigError(`${bw}: cell (${col},${row}) already taken`);
      cells[`${col},${row}`] = true;
      const color = btn.color === undefined ? "slate" : btn.color;
      if (!COLORS.includes(color as Color)) throw new ConfigError(`${bw}.color: ${COLORS.join("/")}`);
      const kind = btn.kind === undefined ? "button" : btn.kind;
      if (kind !== "button" && kind !== "fader") throw new ConfigError(`${bw}.kind: button/fader`);
      const f = btn.fader === undefined ? {} : obj(btn.fader, `${bw}.fader`);
      const fader = { get: str(f.get, `${bw}.fader.get`, { max: 2000 }), set: str(f.set, `${bw}.fader.set`, { max: 2000 }) };
      if (kind === "fader" && !fader.set.trim()) throw new ConfigError(`${bw}.fader.set: required`);
      const isFader = kind === "fader";
      return {
        id: bid,
        col,
        row,
        label: str(btn.label, `${bw}.label`, { max: 40 }),
        icon: str(btn.icon, `${bw}.icon`, { max: 12 }),
        color: color as Color,
        kind,
        confirm: !isFader && btn.confirm === true,
        showOutput: !isFader && btn.showOutput === true,
        steps: isFader ? [] : validateSteps(btn.steps ?? [], `${bw}.steps`),
        hold: isFader ? [] : validateSteps(btn.hold ?? [], `${bw}.hold`),
        led: isFader ? "" : str(btn.led, `${bw}.led`, { max: 2000 }),
        toggle: !isFader && btn.toggle === true,
        fader: isFader ? fader : { get: "", set: "" },
      };
    });
    return { id: pid, name: str(page.name, `${w}.name`, { required: true, max: 30 }), cols, rows, buttons };
  });
  if (pages.length === 0) throw new ConfigError("pages: at least one page is required");
  return { version: 1, pages };
}

// Value of a fader: integer 0–100.
export function faderValue(v: unknown): number {
  return int(v, "value", 0, 100);
}

export interface PublicButton {
  id: string;
  col: number;
  row: number;
  label: string;
  icon: string;
  color: Color;
  kind: Button["kind"];
  confirm: boolean;
  showOutput: boolean;
  hasHold: boolean;
  hasLed: boolean;
}
export interface PublicPage extends Omit<Page, "buttons"> {
  buttons: PublicButton[];
}

// What the tablet sees: presentation only, never the commands (steps, hold, led, fader).
export function publicView(cfg: PadConfig): { pages: PublicPage[] } {
  return {
    pages: cfg.pages.map((p) => ({
      ...p,
      buttons: p.buttons.map((x) => ({
        id: x.id,
        col: x.col,
        row: x.row,
        label: x.label,
        icon: x.icon,
        color: x.color,
        kind: x.kind,
        confirm: x.confirm,
        showOutput: x.showOutput,
        hasHold: x.hold.length > 0,
        hasLed: x.led.trim() !== "" || x.toggle,
      })),
    })),
  };
}

const b = (
  id: string, col: number, row: number, label: string, icon: string, color: Color, steps: Step[],
  extra: Partial<Pick<Button, "confirm" | "showOutput" | "hold" | "led" | "toggle">> = {},
): Button => ({
  id, col, row, label, icon, color, kind: "button", confirm: false, showOutput: false, steps,
  hold: [], led: "", toggle: false, fader: { get: "", set: "" }, ...extra,
});

// Example pad on first start: harmless actions, all editable.
export function seedConfig(): PadConfig {
  return {
    version: 1,
    pages: [
      {
        id: "main",
        name: "Main",
        cols: 4,
        rows: 3,
        buttons: [
          b("notifica", 0, 0, "Notification", "🔔", "violet", [
            { type: "applescript", script: 'display notification "The pad works" with title "Macrocenter"' },
          ]),
          b("screenshot", 1, 0, "Screenshot", "📸", "blue", [{ type: "keys", keys: "cmd+shift+4" }]),
          b("muto", 2, 0, "Mute", "🔇", "amber", [
            { type: "applescript", script: "set volume output muted not (output muted of (get volume settings))" },
          ], { led: `[ "$(osascript -e 'output muted of (get volume settings)')" = true ]` }),
          b("vol-su", 3, 0, "Volume +", "🔊", "slate", [
            { type: "applescript", script: "set volume output volume ((output volume of (get volume settings)) + 10)" },
          ]),
          b("dashboard", 0, 1, "Dashboard", "📊", "teal", [{ type: "open", target: "http://localhost:8420", app: "" }], {
            hold: [{ type: "open", target: "http://localhost:8420/kiosk", app: "" }],
          }),
          b("ip", 1, 1, "Mac IP", "🌐", "green", [
            { type: "shell", cmd: "ipconfig getifaddr en0", cwd: "", timeout: 10 },
          ], { showOutput: true }),
          b("vol-giu", 3, 1, "Volume −", "🔉", "slate", [
            { type: "applescript", script: "set volume output volume ((output volume of (get volume settings)) - 10)" },
          ]),
          {
            id: "volume", col: 2, row: 1, label: "Volume", icon: "🎚️", color: "teal", kind: "fader",
            confirm: false, showOutput: false, steps: [], hold: [], led: "", toggle: false,
            fader: {
              get: "osascript -e 'output volume of (get volume settings)'",
              set: 'osascript -e "set volume output volume $PAD_VALUE"',
            },
          },
          b("blocca", 3, 2, "Lock", "🔒", "red", [{ type: "keys", keys: "ctrl+cmd+q" }], { confirm: true }),
        ],
      },
    ],
  };
}

export function createStore(path: string) {
  let cfg: PadConfig;
  let rev = String(Date.now());

  if (existsSync(path)) {
    // Unreadable/invalid file: stop, never overwrite the user's work.
    try {
      cfg = validateConfig(JSON.parse(readFileSync(path, "utf8")));
    } catch (e) {
      throw new Error(`${path} invalid: ${(e as Error).message}`);
    }
  } else {
    cfg = seedConfig();
    persist(cfg);
  }

  function persist(next: PadConfig) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, path);
  }

  return {
    get rev() {
      return rev;
    },
    get config() {
      return cfg;
    },
    save(raw: unknown): PadConfig {
      const next = validateConfig(raw);
      persist(next);
      cfg = next;
      rev = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      return cfg;
    },
    findButton(buttonId: string): Button | undefined {
      for (const p of cfg.pages) {
        const hit = p.buttons.find((x) => x.id === buttonId);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}
