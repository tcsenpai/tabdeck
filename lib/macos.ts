// Catalog of "Mac actions": typed templates that generate AppleScript.
// Arguments are validated and escaped here (server side), so a button never embeds user text
// into a script by string concatenation done elsewhere. The editor only renders this catalog.
import { asString } from "./keys.ts";

export type Param =
  | { key: string; type: "text"; required?: boolean; max?: number }
  | { key: string; type: "int"; min: number; max: number; default: number }
  | { key: string; type: "select"; options: string[]; default: string };

export type Args = Record<string, string | number>;

export interface ActionDef {
  id: string;
  group: "music" | "spotify" | "system" | "app" | "ui" | "window";
  params: Param[];
  script(a: Args): string;
}

const q = (v: string | number | undefined) => asString(String(v ?? ""));
const n = (v: string | number | undefined) => Number(v);
const SE = 'tell application "System Events"';

const transport = (app: string, verb: string) => `tell application ${q(app)} to ${verb}`;
const percent = (key = "level"): Param => ({ key, type: "int", min: 0, max: 100, default: 50 });
const appParam: Param = { key: "app", type: "text", required: true, max: 100 };

export const ACTIONS: ActionDef[] = [
  { id: "music.playpause", group: "music", params: [], script: () => transport("Music", "playpause") },
  { id: "music.next", group: "music", params: [], script: () => transport("Music", "next track") },
  { id: "music.previous", group: "music", params: [], script: () => transport("Music", "previous track") },
  { id: "music.volume", group: "music", params: [percent()], script: (a) => `tell application "Music" to set sound volume to ${n(a.level)}` },

  { id: "spotify.playpause", group: "spotify", params: [], script: () => transport("Spotify", "playpause") },
  { id: "spotify.next", group: "spotify", params: [], script: () => transport("Spotify", "next track") },
  { id: "spotify.previous", group: "spotify", params: [], script: () => transport("Spotify", "previous track") },
  { id: "spotify.volume", group: "spotify", params: [percent()], script: (a) => `tell application "Spotify" to set sound volume to ${n(a.level)}` },

  { id: "system.volume", group: "system", params: [percent()], script: (a) => `set volume output volume ${n(a.level)}` },
  {
    id: "system.volumeStep",
    group: "system",
    params: [{ key: "delta", type: "int", min: -100, max: 100, default: 10 }],
    script: (a) =>
      `set v to (output volume of (get volume settings)) + (${n(a.delta)})\nif v > 100 then set v to 100\nif v < 0 then set v to 0\nset volume output volume v`,
  },
  {
    id: "system.mute",
    group: "system",
    params: [{ key: "mode", type: "select", options: ["toggle", "on", "off"], default: "toggle" }],
    script: (a) =>
      a.mode === "on" ? "set volume output muted true"
      : a.mode === "off" ? "set volume output muted false"
      : "set volume output muted not (output muted of (get volume settings))",
  },
  {
    id: "system.notify",
    group: "system",
    params: [
      { key: "title", type: "text", max: 100 },
      { key: "message", type: "text", required: true, max: 300 },
    ],
    script: (a) => `display notification ${q(a.message)} with title ${q(a.title)}`,
  },
  {
    id: "system.darkMode",
    group: "system",
    params: [{ key: "mode", type: "select", options: ["toggle", "dark", "light"], default: "toggle" }],
    script: (a) =>
      `${SE} to tell appearance preferences to set dark mode to ` +
      (a.mode === "dark" ? "true" : a.mode === "light" ? "false" : "not dark mode"),
  },
  { id: "system.sleepDisplay", group: "system", params: [], script: () => 'do shell script "pmset displaysleepnow"' },
  { id: "system.lock", group: "system", params: [], script: () => `${SE} to keystroke "q" using {control down, command down}` },

  { id: "app.open", group: "app", params: [appParam], script: (a) => `tell application ${q(a.app)} to activate` },
  { id: "app.quit", group: "app", params: [appParam], script: (a) => `tell application ${q(a.app)} to quit` },
  { id: "app.hide", group: "app", params: [appParam], script: (a) => `${SE} to set visible of application process ${q(a.app)} to false` },

  {
    id: "ui.menu",
    group: "ui",
    params: [
      appParam,
      { key: "menu", type: "text", required: true, max: 100 },
      { key: "item", type: "text", required: true, max: 100 },
    ],
    script: (a) =>
      `${SE} to tell process ${q(a.app)} to click menu item ${q(a.item)} of menu ${q(a.menu)} of menu bar item ${q(a.menu)} of menu bar 1`,
  },

  {
    id: "window.move",
    group: "window",
    params: [
      { key: "x", type: "int", min: 0, max: 10000, default: 0 },
      { key: "y", type: "int", min: 0, max: 10000, default: 25 },
    ],
    script: (a) =>
      `${SE} to tell (first application process whose frontmost is true) to set position of window 1 to {${n(a.x)}, ${n(a.y)}}`,
  },
  {
    id: "window.resize",
    group: "window",
    params: [
      { key: "width", type: "int", min: 100, max: 10000, default: 1200 },
      { key: "height", type: "int", min: 100, max: 10000, default: 800 },
    ],
    script: (a) =>
      `${SE} to tell (first application process whose frontmost is true) to set size of window 1 to {${n(a.width)}, ${n(a.height)}}`,
  },
  { id: "window.fullscreen", group: "window", params: [], script: () => `${SE} to keystroke "f" using {control down, command down}` },
];

export function findAction(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

// Validates and normalizes arguments against the action's schema. Throws a plain Error
// (config.ts wraps it with the field path). Unknown keys are dropped; ints become numbers.
export function normalizeArgs(action: string, raw: unknown): Args {
  const def = findAction(action);
  if (!def) throw new Error(`unknown action "${action}"`);
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Args = {};
  for (const p of def.params) {
    const v = src[p.key];
    if (p.type === "int") {
      const num = v === undefined || v === "" ? p.default : typeof v === "string" ? Number(v) : v;
      if (typeof num !== "number" || !Number.isInteger(num) || num < p.min || num > p.max) {
        throw new Error(`${p.key}: integer between ${p.min} and ${p.max}`);
      }
      out[p.key] = num;
    } else if (p.type === "select") {
      const s = v === undefined ? p.default : v;
      if (typeof s !== "string" || !p.options.includes(s)) throw new Error(`${p.key}: one of ${p.options.join("/")}`);
      out[p.key] = s;
    } else {
      const s = v === undefined || v === null ? "" : v;
      if (typeof s !== "string") throw new Error(`${p.key}: expected text`);
      if (p.required && !s.trim()) throw new Error(`${p.key}: required`);
      if (s.length > (p.max ?? 200)) throw new Error(`${p.key}: at most ${p.max ?? 200} characters`);
      out[p.key] = s;
    }
  }
  return out;
}

// Script for a (validated) mac step. Throws if the action is unknown.
export function macScript(action: string, args: Args): string {
  const def = findAction(action);
  if (!def) throw new Error(`unknown action "${action}"`);
  return def.script(args);
}

// Serializable view for the editor: schema only, never the script templates.
export const catalog = () => ACTIONS.map(({ id, group, params }) => ({ id, group, params }));
