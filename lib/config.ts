// Pad configuration: schema, strict validation, atomic persistence.
// The file is the single source of truth; the server keeps no derived state.
import { existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseKeys } from "./keys.ts";
import { MOUSE_BUTTONS, type MouseButton } from "./mouse.ts";
import { normalizeArgs, type Args } from "./macos.ts";
import { favId, isRbUuid, isStation } from "./stations.ts";
import type { AutoRule } from "./context.ts";
import { isInfoKind, type InfoKind } from "./info.ts";

// The pad grid is measured in units: a classic tile is SUB×SUB units, so a key can be resized in
// quarter-tile steps (1×1 unit = a quarter of a classic tile).
export const SUB = 2;
// How a visualizer tile draws the spectrum (see public/viz.js).
export const VIZ_STYLES = ["bars", "mirror", "blocks", "wave", "ring"] as const;
// Display-only filler tiles (see public/deco.js).
export const DECO_STYLES = ["clock", "hex", "radar", "pulse", "banner", "leds"] as const;
// Smallest size per kind, in units. A fader needs room for its track, the radio for its LCD.
export const MIN_SIZE: Record<"button" | "fader" | "radio" | "station" | "viz" | "deco", [number, number]> = {
  button: [1, 1],
  station: [1, 1],
  fader: [2, 1],
  radio: [4, 2],
  viz: [2, 1],
  deco: [1, 1],
};

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
  kind: "button" | "fader" | "radio" | "station" | "viz" | "deco";
  confirm: boolean;
  showOutput: boolean;
  steps: Step[];
  hold: Step[]; // long press (kind "button" only)
  led: string; // shell command: exit 0 = on (kind "button" only)
  toggle: boolean; // latching: the pad remembers on/off, flipped by each successful tap (ignored when `led` is set)
  fader: Fader; // kind "fader" only
  w: number; // size in grid units (see SUB)
  h: number;
  station: string; // kind "station": the station this tile plays/stops (see lib/stations.ts)
  style: string; // kind "viz": one of VIZ_STYLES, "" for other kinds
  variants: Variant[]; // kind "button" only: look and actions that replace the base ones while a given app is in front
  border: boolean; // false: no frame, no 3D body, the content floats on the background (decorative tiles default to false)
}

// "If <app> is in front, this key becomes …". First matching variant wins; no match = the base key.
// The LED / latching state stays with the base key. `hidden` makes the key disappear for that app.
export interface Variant {
  app: string;
  mode: "is" | "contains";
  url: string;
  title: string;
  hidden: boolean;
  label: string;
  icon: string;
  color: Color;
  confirm: boolean;
  showOutput: boolean;
  steps: Step[];
  hold: Step[];
}

function vizStyle(v: unknown, where: string): string {
  if (v === undefined || v === "") return "bars";
  if (typeof v !== "string" || !(VIZ_STYLES as readonly string[]).includes(v)) throw new ConfigError(`${where}: ${VIZ_STYLES.join("/")}`);
  return v;
}

function decoStyle(v: unknown, where: string): string {
  if (v === undefined || v === "") return "clock";
  if (typeof v !== "string" || !(DECO_STYLES as readonly string[]).includes(v)) throw new ConfigError(`${where}: ${DECO_STYLES.join("/")}`);
  return v;
}

// A profile is one tablet's view: pages with a profile are shown only to the tablets opened with
// `?profile=<id>`; pages with "" are shown to everyone.
export interface Profile {
  id: string;
  name: string;
}

// A station chosen from radio-browser.info. Only the id and the name at the time of adding are kept:
// the stream URL is resolved on every play.
export interface RadioFav {
  uuid: string;
  name: string;
}
export interface Page {
  id: string;
  name: string;
  cols: number;
  rows: number;
  profile: string; // "" = every tablet
  buttons: Button[];
}
// Automatic pages: when enabled, the pad follows the Mac's frontmost app (first matching rule wins).
export interface Auto {
  enabled: boolean;
  rules: AutoRule[];
}
export interface PadConfig {
  version: 2;
  profiles: Profile[];
  auto: Auto;
  bar: InfoKind[]; // system chips in the pad's bottom bar (see lib/info.ts), in order
  radioFavs: RadioFav[]; // stations picked from radio-browser.info; tiles/widget address them as `rb:<uuid>`
  glow: boolean; // ambient glow behind the pad that follows the system audio (each tablet switches it on)
  pages: Page[];
}

export class ConfigError extends Error {}

const ID_RE = /^[a-z0-9_-]{1,40}$/;
const LIMITS = { pages: 12, cols: 8, rows: 6, steps: 20, headers: 20, profiles: 8, autoRules: 40, bar: 6, radioFavs: 24, variants: 8 };

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

// Version 1 stored tile coordinates (a key = 1 cell, a radio = w cells). Version 2 stores grid units.
// Anything that is not a recognisable version-1 object comes back as the same reference, so
// callers can tell whether a migration happened.
export function migrateConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  if (root.version === 2 || !Array.isArray(root.pages)) return raw;
  const times = (v: unknown) => (typeof v === "number" ? v * SUB : v);
  return {
    ...root,
    version: 2,
    pages: root.pages.map((p: unknown) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return p;
      const page = p as Record<string, unknown>;
      if (!Array.isArray(page.buttons)) return page;
      return {
        ...page,
        buttons: page.buttons.map((b: unknown) => {
          if (!b || typeof b !== "object" || Array.isArray(b)) return b;
          const x = b as Record<string, unknown>;
          const cells = typeof x.w === "number" && x.w > 1 ? x.w : 1;
          return { ...x, col: times(x.col), row: times(x.row), w: cells * SUB, h: SUB };
        }),
      };
    }),
  };
}

function validateAuto(raw: unknown, pageIds: Record<string, true>): Auto {
  if (raw === undefined) return { enabled: false, rules: [] };
  const o = obj(raw, "auto");
  const rules: AutoRule[] = arr(o.rules ?? [], "auto.rules", LIMITS.autoRules).map((r, i) => {
    const w = `auto.rules[${i}]`;
    const x = obj(r, w);
    const mode = x.mode === undefined ? "is" : x.mode;
    if (mode !== "is" && mode !== "contains") throw new ConfigError(`${w}.mode: is/contains`);
    const page = id(x.page, `${w}.page`);
    if (!pageIds[page]) throw new ConfigError(`${w}.page: unknown page "${page}"`);
    return {
      app: str(x.app, `${w}.app`, { required: true, max: 100 }),
      mode,
      url: str(x.url, `${w}.url`, { max: 100 }),
      title: str(x.title, `${w}.title`, { max: 100 }),
      page,
    };
  });
  return { enabled: o.enabled === true, rules };
}

function validateVariants(raw: unknown, where: string): Variant[] {
  return arr(raw ?? [], where, LIMITS.variants).map((v, i) => {
    const w = `${where}[${i}]`;
    const x = obj(v, w);
    const mode = x.mode === undefined ? "is" : x.mode;
    if (mode !== "is" && mode !== "contains") throw new ConfigError(`${w}.mode: is/contains`);
    const color = x.color === undefined ? "slate" : x.color;
    if (!COLORS.includes(color as Color)) throw new ConfigError(`${w}.color: ${COLORS.join("/")}`);
    return {
      app: str(x.app, `${w}.app`, { required: true, max: 100 }),
      mode,
      url: str(x.url, `${w}.url`, { max: 100 }),
      title: str(x.title, `${w}.title`, { max: 100 }),
      hidden: x.hidden === true,
      label: str(x.label, `${w}.label`, { max: 40 }),
      icon: str(x.icon, `${w}.icon`, { max: 12 }),
      color: color as Color,
      confirm: x.confirm === true,
      showOutput: x.showOutput === true,
      steps: validateSteps(x.steps ?? [], `${w}.steps`),
      hold: validateSteps(x.hold ?? [], `${w}.hold`),
    };
  });
}

export function validateConfig(raw: unknown): PadConfig {
  const root = obj(migrateConfig(raw), "config");
  const pageIds: Record<string, true> = {};
  const profiles: Profile[] = arr(root.profiles ?? [], "profiles", LIMITS.profiles).map((p, i) => {
    const o = obj(p, `profiles[${i}]`);
    return { id: id(o.id, `profiles[${i}].id`), name: str(o.name, `profiles[${i}].name`, { required: true, max: 30 }) };
  });
  const profileIds: Record<string, true> = {};
  for (const p of profiles) {
    if (profileIds[p.id]) throw new ConfigError(`profiles: duplicate id "${p.id}"`);
    profileIds[p.id] = true;
  }
  const radioFavs: RadioFav[] = [];
  for (const [i, f] of arr(root.radioFavs ?? [], "radioFavs", LIMITS.radioFavs).entries()) {
    const o = obj(f, `radioFavs[${i}]`);
    if (!isRbUuid(o.uuid)) throw new ConfigError(`radioFavs[${i}].uuid: not a station id`);
    const name = str(o.name, `radioFavs[${i}].name`, { required: true, max: 100 });
    if (!radioFavs.some((x) => x.uuid === o.uuid)) radioFavs.push({ uuid: o.uuid, name });
  }
  const buttonIds: Record<string, true> = {};
  let radioSeen = false;
  const pages: Page[] = arr(root.pages, "pages", LIMITS.pages).map((p, pi) => {
    const w = `pages[${pi}]`;
    const page = obj(p, w);
    const pid = id(page.id, `${w}.id`);
    if (pageIds[pid]) throw new ConfigError(`${w}.id: duplicate`);
    pageIds[pid] = true;
    const cols = int(page.cols, `${w}.cols`, 1, LIMITS.cols);
    const rows = int(page.rows, `${w}.rows`, 1, LIMITS.rows);
    const ucols = cols * SUB;
    const urows = rows * SUB;
    const cells: Record<string, true> = {};
    const buttons: Button[] = arr(page.buttons, `${w}.buttons`, ucols * urows).map((b, bi) => {
      const bw = `${w}.buttons[${bi}]`;
      const btn = obj(b, bw);
      const bid = id(btn.id, `${bw}.id`);
      if (buttonIds[bid]) throw new ConfigError(`${bw}.id: duplicate`);
      buttonIds[bid] = true;
      const col = int(btn.col, `${bw}.col`, 0, ucols - 1);
      const row = int(btn.row, `${bw}.row`, 0, urows - 1);
      const kind = btn.kind === undefined ? "button" : btn.kind;
      if (kind !== "button" && kind !== "fader" && kind !== "radio" && kind !== "station" && kind !== "viz" && kind !== "deco") {
        throw new ConfigError(`${bw}.kind: button/fader/radio/station/viz/deco`);
      }
      const isFader = kind === "fader";
      const isRadio = kind === "radio";
      const isStationTile = kind === "station";
      const inert = isFader || isRadio || isStationTile || kind === "viz" || kind === "deco"; // no tap actions of their own
      if (btn.border !== undefined && typeof btn.border !== "boolean") throw new ConfigError(`${bw}.border: expected true/false`);
      const [minW, minH] = MIN_SIZE[kind];
      const width = btn.w === undefined ? (isRadio ? 3 * SUB : kind === "viz" ? 2 * SUB : SUB) : int(btn.w, `${bw}.w`, minW, ucols);
      const height = btn.h === undefined ? SUB : int(btn.h, `${bw}.h`, minH, urows);
      if (col + width > ucols || row + height > urows) {
        throw new ConfigError(`${bw}: does not fit in the ${ucols}×${urows} grid`);
      }
      for (let r = row; r < row + height; r++) {
        for (let c = col; c < col + width; c++) {
          if (cells[`${c},${r}`]) throw new ConfigError(`${bw}: unit (${c},${r}) already taken`);
          cells[`${c},${r}`] = true;
        }
      }
      if (isRadio) {
        if (radioSeen) throw new ConfigError(`${bw}: only one radio is allowed`);
        radioSeen = true; // a single <audio> on the tablet
      }
      const color = btn.color === undefined ? "slate" : btn.color;
      if (!COLORS.includes(color as Color)) throw new ConfigError(`${bw}.color: ${COLORS.join("/")}`);
      const f = btn.fader === undefined ? {} : obj(btn.fader, `${bw}.fader`);
      const fader = { get: str(f.get, `${bw}.fader.get`, { max: 2000 }), set: str(f.set, `${bw}.fader.set`, { max: 2000 }) };
      if (isFader && !fader.set.trim()) throw new ConfigError(`${bw}.fader.set: required`);
      const station = isStationTile ? str(btn.station, `${bw}.station`, { max: 40 }) : "";
      if (isStationTile && !isStation(station) && !radioFavs.some((x) => favId(x.uuid) === station)) throw new ConfigError(`${bw}.station: unknown station`);
      return {
        id: bid,
        col,
        row,
        label: str(btn.label, `${bw}.label`, { max: 40 }),
        icon: str(btn.icon, `${bw}.icon`, { max: 12 }),
        color: color as Color,
        kind,
        confirm: !inert && btn.confirm === true,
        showOutput: !inert && btn.showOutput === true,
        steps: inert ? [] : validateSteps(btn.steps ?? [], `${bw}.steps`),
        hold: inert ? [] : validateSteps(btn.hold ?? [], `${bw}.hold`),
        led: inert ? "" : str(btn.led, `${bw}.led`, { max: 2000 }),
        toggle: !inert && btn.toggle === true,
        fader: isFader ? fader : { get: "", set: "" },
        w: width,
        h: height,
        station,
        style: kind === "viz" ? vizStyle(btn.style, `${bw}.style`) : kind === "deco" ? decoStyle(btn.style, `${bw}.style`) : "",
        variants: kind === "button" ? validateVariants(btn.variants, `${bw}.variants`) : [],
        border: btn.border === undefined ? kind !== "deco" : btn.border,
      };
    });
    const profile = page.profile === undefined || page.profile === "" ? "" : id(page.profile, `${w}.profile`);
    if (profile && !profileIds[profile]) throw new ConfigError(`${w}.profile: unknown profile "${profile}"`);
    return { id: pid, name: str(page.name, `${w}.name`, { required: true, max: 30 }), cols, rows, profile, buttons };
  });
  if (pages.length === 0) throw new ConfigError("pages: at least one page is required");
  const auto = validateAuto(root.auto, pageIds);
  const bar: InfoKind[] = [];
  for (const k of arr(root.bar ?? [], "bar", LIMITS.bar)) {
    if (!isInfoKind(k)) throw new ConfigError(`bar: unknown chip "${String(k)}"`);
    if (!bar.includes(k)) bar.push(k);
  }
  if (root.glow !== undefined && typeof root.glow !== "boolean") throw new ConfigError("glow: expected true/false");
  return { version: 2, profiles, auto, bar, radioFavs, glow: root.glow === true, pages };
}

// Value of a fader: integer 0–100.
export function faderValue(v: unknown): number {
  return int(v, "value", 0, 100);
}

export interface PublicVariant {
  label: string;
  icon: string;
  color: Color;
  confirm: boolean;
  showOutput: boolean;
  hasHold: boolean;
  hidden: boolean;
}
export interface PublicButton {
  id: string;
  col: number;
  row: number;
  label: string;
  icon: string;
  color: Color;
  kind: Button["kind"];
  border: boolean;
  confirm: boolean;
  showOutput: boolean;
  hasHold: boolean;
  hasLed: boolean;
  w: number;
  h: number;
  station: string;
  style: string;
  variants: PublicVariant[]; // presentation only: which app triggers which one stays on the Mac
}
export interface PublicPage extends Omit<Page, "buttons"> {
  buttons: PublicButton[];
}

// What the tablet sees: presentation only, never the commands (steps, hold, led, fader).
export function publicView(cfg: PadConfig): { profiles: Profile[]; auto: boolean; bar: InfoKind[]; radioFavs: RadioFav[]; glow: boolean; pages: PublicPage[] } {
  return {
    profiles: cfg.profiles,
    bar: cfg.bar,
    glow: cfg.glow,
    radioFavs: cfg.radioFavs,
    auto: cfg.auto.enabled && cfg.auto.rules.length > 0, // the tablet only needs to know whether to follow
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
        w: x.w,
        h: x.h,
        station: x.station,
        style: x.style,
        border: x.border,
        variants: x.variants.map((v) => ({ label: v.label, icon: v.icon, color: v.color, confirm: v.confirm, showOutput: v.showOutput, hasHold: v.hold.length > 0, hidden: v.hidden })),
      })),
    })),
  };
}

// Seed helper: coordinates are in whole tiles; a tile is SUB×SUB grid units.
const b = (
  id: string, col: number, row: number, label: string, icon: string, color: Color, steps: Step[],
  extra: Partial<Pick<Button, "confirm" | "showOutput" | "hold" | "led" | "toggle">> = {},
): Button => ({
  id, col: col * SUB, row: row * SUB, label, icon, color, kind: "button", confirm: false, showOutput: false, steps,
  hold: [], led: "", toggle: false, fader: { get: "", set: "" }, w: SUB, h: SUB, station: "", style: "", variants: [], border: true, ...extra,
});

// Example pad on first start: harmless actions, all editable.
export function seedConfig(): PadConfig {
  return {
    version: 2,
    profiles: [],
    auto: { enabled: false, rules: [] },
    bar: [],
    glow: false,
    radioFavs: [],
    pages: [
      {
        id: "main",
        name: "Main",
        cols: 4,
        rows: 3,
        profile: "",
        buttons: [
          b("notifica", 0, 0, "Notification", "🔔", "violet", [
            { type: "applescript", script: 'display notification "The pad works" with title "TabDeck"' },
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
            id: "volume", col: 2 * SUB, row: 1 * SUB, label: "Volume", icon: "🎚️", color: "teal", kind: "fader",
            confirm: false, showOutput: false, steps: [], hold: [], led: "", toggle: false, w: SUB, h: SUB, station: "", style: "", variants: [], border: true,
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
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      cfg = validateConfig(parsed);
      if (migrateConfig(parsed) !== parsed) {
        // First start on the unit grid: keep the old file next to the new one.
        copyFileSync(path, `${path}.v1.bak`);
        persist(cfg);
      }
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
