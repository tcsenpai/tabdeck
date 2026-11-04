// "Which app is in front" probe and rule matcher for automatic pages: the pad switches page by the
// Mac's frontmost app. The probe is read-only: it never launches or activates anything.

export interface AppContext { app: string; bundle: string; title: string; url: string }
export interface ContextOptions {
  run?: (script: string, lang: "applescript" | "javascript") => Promise<string>;
  ttlMs?: number;
}
export interface ContextProbe { get(): Promise<AppContext> }

export interface AutoRule { app: string; mode: "is" | "contains"; url: string; title: string; page: string }
export interface AppPreset { id: string; name: string; bundles: string[]; hint: string }

const SEP = "\u001f"; // unit separator: cannot appear in app names or titles worth keeping
const MAX_FIELD = 300;
const TIMEOUT_MS = 3000;
const BUNDLE_RE = /^[A-Za-z0-9.-]+$/;

// Scripting-capable browsers (Firefox has no dictionary: it falls through to the window title).
// Safari exposes `document`, the Chromium family exposes `active tab`.
const SAFARI_BUNDLES = ["com.apple.Safari"];
const CHROMIUM_BUNDLES = [
  "com.google.Chrome",
  "company.thebrowser.Browser", // Arc
  "com.brave.Browser",
  "com.microsoft.edgemac",
  "org.chromium.Chromium",
];

const list = (b: string[]) => `{${b.map((x) => `"${x}"`).join(", ")}}`;

// `tell application id` is resolved at run time through `run script`, so a browser that is not
// installed can never trigger a "where is X?" dialog at compile time, and only a bundle taken from
// the fixed whitelist above is ever told anything (telling a non-running app would launch it, but
// the frontmost process is running by definition).
const SCRIPT = `
set sep to character id 31
tell application "System Events"
  set fp to first application process whose frontmost is true
  set appName to name of fp
  set bid to bundle identifier of fp
end tell
if bid is missing value then set bid to ""
set theTitle to ""
set theUrl to ""
set safariIds to ${list(SAFARI_BUNDLES)}
set chromiumIds to ${list(CHROMIUM_BUNDLES)}
try
  if safariIds contains bid then
    set theUrl to run script "tell application id \\"" & bid & "\\" to return (URL of front document) as text"
    set theTitle to run script "tell application id \\"" & bid & "\\" to return (name of front document) as text"
  else if chromiumIds contains bid then
    set theUrl to run script "tell application id \\"" & bid & "\\" to return (URL of active tab of front window) as text"
    set theTitle to run script "tell application id \\"" & bid & "\\" to return (title of active tab of front window) as text"
  else
    tell application "System Events" to tell fp to set theTitle to (name of front window) as text
  end if
end try
return appName & sep & bid & sep & theTitle & sep & theUrl
`;

const EMPTY = (): AppContext => ({ app: "", bundle: "", title: "", url: "" });

function sanitise(s: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim().slice(0, MAX_FIELD);
}

export function parseProbe(out: string): AppContext {
  const [app, bundle, title, url] = out.replace(/[\r\n]+$/, "").split(SEP);
  const b = sanitise(bundle);
  return { app: sanitise(app), bundle: BUNDLE_RE.test(b) ? b : "", title: sanitise(title), url: sanitise(url) };
}

async function osascript(script: string, lang: "applescript" | "javascript"): Promise<string> {
  const args = ["/usr/bin/osascript", ...(lang === "javascript" ? ["-l", "JavaScript"] : []), "-"];
  const p = Bun.spawn(args, { stdin: new Blob([script]), stdout: "pipe", stderr: "ignore", detached: true });
  const timer = setTimeout(() => {
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
  }, TIMEOUT_MS);
  try {
    const out = await new Response(p.stdout).text();
    await p.exited;
    if (p.exitCode !== 0) throw new Error(`osascript exited with ${p.exitCode}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export function createContext(opts: ContextOptions = {}): ContextProbe {
  const run = opts.run ?? osascript;
  const ttl = opts.ttlMs ?? 800;
  let cached: AppContext | null = null;
  let at = 0;
  let inflight: Promise<AppContext> | null = null;

  async function probe(): Promise<AppContext> {
    try {
      return parseProbe(await run(SCRIPT, "applescript"));
    } catch {
      return EMPTY(); // no Accessibility, osascript missing, timeout: an empty context, never an error
    }
  }

  return {
    get() {
      if (cached && Date.now() - at < ttl) return Promise.resolve({ ...cached });
      inflight ??= probe().then((c) => {
        cached = c;
        at = Date.now();
        inflight = null;
        return c;
      });
      return inflight.then((c) => ({ ...c }));
    },
  };
}

const lc = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");

export function matchRule(rules: AutoRule[], ctx: AppContext): AutoRule | undefined {
  if (!Array.isArray(rules) || !ctx || typeof ctx !== "object") return undefined;
  const names = [lc(ctx.app), lc(ctx.bundle)].filter((n) => n !== "");
  const url = lc(ctx.url);
  const title = lc(ctx.title);
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const want = lc(r.app).trim();
    if (!want) continue;
    const appOk = r.mode === "contains" ? names.some((n) => n.includes(want)) : names.some((n) => n === want);
    if (!appOk) continue;
    const u = lc(r.url);
    const t = lc(r.title);
    if (u && !url.includes(u)) continue;
    if (t && !title.includes(t)) continue;
    return r;
  }
  return undefined;
}

export const APP_PRESETS: AppPreset[] = [
  { id: "discord", name: "Discord", bundles: ["com.hnc.Discord"], hint: "Mute, deafen, push-to-talk, voice channels" },
  { id: "zoom", name: "Zoom", bundles: ["us.zoom.xos"], hint: "Mute, video, share screen, leave meeting" },
  { id: "slack", name: "Slack", bundles: ["com.tinyspeck.slackmacgap"], hint: "Quick switcher, huddle, status, unread jump" },
  { id: "teams", name: "Microsoft Teams", bundles: ["com.microsoft.teams2", "com.microsoft.teams"], hint: "Mute, camera, raise hand, leave call" },
  { id: "safari", name: "Safari", bundles: ["com.apple.Safari"], hint: "Tabs, reload, bookmarks, reader mode" },
  { id: "chrome", name: "Google Chrome", bundles: ["com.google.Chrome"], hint: "Tabs, reload, dev tools, incognito" },
  { id: "arc", name: "Arc", bundles: ["company.thebrowser.Browser"], hint: "Spaces, command bar, split view, sidebar" },
  { id: "terminal", name: "Terminal", bundles: ["com.apple.Terminal"], hint: "New tab, clear, interrupt, history search" },
  { id: "iterm2", name: "iTerm2", bundles: ["com.googlecode.iterm2"], hint: "Split panes, profiles, clear, broadcast input" },
  { id: "xcode", name: "Xcode", bundles: ["com.apple.dt.Xcode"], hint: "Build, run, stop, clean, jump to definition" },
  { id: "vscode", name: "Visual Studio Code", bundles: ["com.microsoft.VSCode"], hint: "Command palette, terminal, format, git" },
  { id: "finder", name: "Finder", bundles: ["com.apple.finder"], hint: "New folder, go to folder, quick look, trash" },
  { id: "music", name: "Music", bundles: ["com.apple.Music"], hint: "Play/pause, next, previous, shuffle" },
  { id: "spotify", name: "Spotify", bundles: ["com.spotify.client"], hint: "Play/pause, next, previous, like track" },
  { id: "photoshop", name: "Photoshop", bundles: ["com.adobe.Photoshop"], hint: "Brush, eraser, undo steps, layers, export" },
  { id: "finalcut", name: "Final Cut Pro", bundles: ["com.apple.FinalCut"], hint: "Blade, marker, trim, play around, export" },
  { id: "logic", name: "Logic Pro", bundles: ["com.apple.logic10"], hint: "Record, play, loop, metronome, mixer" },
  { id: "obs", name: "OBS", bundles: ["com.obsproject.obs-studio"], hint: "Start/stop stream and recording, scenes" },
  { id: "figma", name: "Figma", bundles: ["com.figma.Desktop"], hint: "Frame, rectangle, text, components, zoom to fit" },
  { id: "notion", name: "Notion", bundles: ["notion.id"], hint: "Search, new page, toggle sidebar, dark mode" },
  { id: "mail", name: "Mail", bundles: ["com.apple.mail"], hint: "New message, reply, archive, flag" },
  { id: "messages", name: "Messages", bundles: ["com.apple.MobileSMS"], hint: "New message, next conversation, tapback" },
  { id: "calendar", name: "Calendar", bundles: ["com.apple.iCal"], hint: "New event, today, day/week/month view" },
];
