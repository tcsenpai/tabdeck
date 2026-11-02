// Parses combinations like "cmd+shift+4" → AppleScript for System Events.

const MODS: Record<string, string> = {
  cmd: "command", command: "command", meta: "command", super: "command",
  ctrl: "control", control: "control",
  alt: "option", opt: "option", option: "option",
  shift: "shift",
};

// Keys without a character: Mac keyboard key codes (layout-independent).
const CODES: Record<string, number> = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51,
  forwarddelete: 117, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
  // Top-row digits by physical key: `keystroke "2"` with modifiers is delivered as the numeric
  // keypad 2 (code 84), which hotkey apps bound to the top-row 2 (code 19) ignore.
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
};

// Names for characters that cannot be written next to the "+" separator.
const CHAR_ALIASES: Record<string, string> = { plus: "+", minus: "-", comma: ",", period: ".", slash: "/" };

// kind "mod": only modifiers (e.g. "opt", "cmd+shift"): pressed together, then released.
export type ParsedKeys =
  | { mods: string[]; kind: "char"; value: string }
  | { mods: string[]; kind: "code"; value: number }
  | { mods: string[]; kind: "mod" };

export function parseKeys(spec: string): ParsedKeys {
  const tokens = spec.split("+").map((t) => t.trim().toLowerCase());
  // "cmd++" = cmd and the "+" key: the split leaves two empty tokens at the end.
  if (tokens.length >= 2 && tokens[tokens.length - 1] === "" && tokens[tokens.length - 2] === "") {
    tokens.splice(tokens.length - 2, 2, "plus");
  }
  if (tokens.some((t) => t === "")) throw new Error(`Invalid key combination: "${spec}"`);
  const key = tokens[tokens.length - 1];
  if (Object.hasOwn(MODS, key)) {
    const all: string[] = [];
    for (const t of tokens) {
      if (!Object.hasOwn(MODS, t)) throw new Error(`Unknown modifier "${t}" in "${spec}"`);
      if (!all.includes(MODS[t])) all.push(MODS[t]);
    }
    return { mods: all, kind: "mod" };
  }
  const mods: string[] = [];
  for (const t of tokens.slice(0, -1)) {
    if (!Object.hasOwn(MODS, t)) throw new Error(`Unknown modifier "${t}" in "${spec}"`);
    const m = MODS[t];
    if (!mods.includes(m)) mods.push(m);
  }
  if (Object.hasOwn(CODES, key)) return { mods, kind: "code", value: CODES[key] };
  const ch = Object.hasOwn(CHAR_ALIASES, key) ? CHAR_ALIASES[key] : key;
  if ([...ch].length !== 1) throw new Error(`Unknown key "${key}" in "${spec}"`);
  return { mods, kind: "char", value: ch };
}

export const asString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// `repeat` presses inside ONE osascript run, `gap` ms apart: a double press needs to be faster than
// the ~200 ms it takes to spawn a separate step.
export function keysScript(p: ParsedKeys, repeat = 1, gap = 80): string {
  let press: string;
  if (p.kind === "mod") {
    press = [...p.mods.map((m) => `key down ${m}`), "delay 0.03", ...[...p.mods].reverse().map((m) => `key up ${m}`)].join("\n");
  } else {
    const using = p.mods.length ? ` using {${p.mods.map((m) => `${m} down`).join(", ")}}` : "";
    press = (p.kind === "code" ? `key code ${p.value}` : `keystroke ${asString(p.value)}`) + using;
  }
  if (repeat <= 1 && p.kind !== "mod") return `tell application "System Events" to ${press}`;
  const body = repeat <= 1 ? press : `repeat ${repeat} times\n${press}\ndelay ${gap / 1000}\nend repeat`;
  return `tell application "System Events"\n${body}\nend tell`;
}

// Types text; newlines become the Return key.
export function textScript(text: string): string {
  const stmts: string[] = [];
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, i) => {
      if (i > 0) stmts.push("key code 36");
      if (line) stmts.push(`keystroke ${asString(line)}`);
    });
  return `tell application "System Events"\n${stmts.join("\n")}\nend tell`;
}
