// Microphone corners, Mac side: runs tools/mic.swift (AVAudioEngine tap) and fans its
// `[level, onset]` lines out to browsers. The microphone is analysed ON THE MAC: the helper prints
// two numbers per frame and nothing else, so no audio ever reaches the server's clients, a file or
// the network. The helper is compiled on first use and runs only while somebody is watching.
//
// The object is a `Viz` (lib/viz.ts), so `sseResponse(mic, signal)` streams it unchanged. A quiet
// room is normal here: the `silent` state is never used.
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import type { Viz, VizStatus } from "./viz.ts";

export interface MicOptions {
  dir: string; // data directory: holds the compiled helper, its Info.plist and mic.pid
  fps?: number; // frames per second handed to subscribers (5..30, default 30)
  helper?: string[]; // argv used instead of compiling and running tools/mic (tests)
  source?: string;
  idleMs?: number; // how long the helper keeps running after the last subscriber left (default 4000)
  retryMs?: number; // wait before restarting a helper that exited (default 2000)
  quickMs?: number; // an exit sooner than this after the start counts as a quick failure (default 5000)
}

type BuildResult = { ok: true } | { ok: false; error: string };

interface Subscriber {
  onFrame: (frame: number[]) => void;
  onStatus: (s: VizStatus) => void;
}

const SWIFTC = existsSync("/usr/bin/swiftc") ? "/usr/bin/swiftc" : "swiftc"; // launchd runs us with a minimal PATH
const COMPILE_MS = 120_000;
const MAX_QUICK_FAILS = 5;
const BUILD_HINT = "Install the Xcode Command Line Tools: xcode-select --install";
const PERMISSION_HINT = "Allow Microphone for the process that runs the server (System Settings → Privacy & Security).";
const ORPHAN_MARKER = "tabdeck-mic"; // part of the helper's file name and of the fake helpers' argv[0] in tests

// A command-line binary has no bundle: macOS only lets it ask for the microphone when an Info.plist
// with NSMicrophoneUsageDescription is embedded in the executable.
export const MIC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.tabdeck.mic</string>
  <key>CFBundleName</key>
  <string>TabDeck Mic</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>TabDeck listens to the room only to flash the pad corners. The sound is analysed on this Mac and never stored or sent.</string>
</dict>
</plist>
`;

// swiftc argv that builds the helper with the Info.plist embedded.
export function micSwiftcArgs(source: string, out: string, plist: string): string[] {
  return [
    SWIFTC, "-O", source, "-o", out,
    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
  ];
}

// `[level, onset]` with both numbers finite; out-of-range values are clamped to 0...1.
export function parseMicFrame(line: string): number[] | null {
  if (!line.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(line);
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [level, onset] = v as unknown[];
    if (typeof level !== "number" || typeof onset !== "number") return null;
    if (!Number.isFinite(level) || !Number.isFinite(onset)) return null;
    return [Math.min(1, Math.max(0, level)), Math.min(1, Math.max(0, onset))];
  } catch {
    return null;
  }
}

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
  // The helper stops its audio engine on SIGTERM; anything that ignores it is killed shortly after.
  setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 1000);
}

export function createMic(opts: MicOptions): Viz {
  const fps = Math.min(30, Math.max(5, Math.round(opts.fps ?? 30)));
  const idleMs = opts.idleMs ?? 4000;
  const retryMs = opts.retryMs ?? 2000;
  const quickMs = opts.quickMs ?? 5000;
  const source = opts.source ?? `${import.meta.dir}/../tools/mic.swift`;
  const bin = `${opts.dir}/${ORPHAN_MARKER}`;
  const plistFile = `${bin}.plist`;
  const pidFile = `${opts.dir}/mic.pid`;
  const frameGap = 1000 / fps;

  // A helper left over by a server that was killed hard would keep the microphone (and the CPU) busy.
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    const cmdline = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
    if (pid > 1 && cmdline.includes(ORPHAN_MARKER)) {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch {}
  try { unlinkSync(pidFile); } catch {}

  const subs = new Set<Subscriber>();
  let status: VizStatus = { state: "idle" };
  let proc: Subprocess | null = null;
  let launching = false; // compiling or about to spawn
  let gen = 0; // bumped on stop, so a launch that was waiting on the compiler notices it is obsolete
  let fails = 0;
  let reportedError = false; // the running helper said why it cannot work: restarting it would not help
  let idleTimer: Timer | undefined;
  let retryTimer: Timer | undefined;
  let flushTimer: Timer | undefined;
  let latest: number[] | null = null;
  let lastSent = 0;
  let building: Promise<BuildResult> | null = null;

  function setStatus(next: VizStatus) {
    if (next.state === status.state && next.error === status.error) return;
    status = next;
    for (const s of [...subs]) {
      try { s.onStatus(next); } catch {}
    }
  }

  function flush() {
    flushTimer = undefined;
    const frame = latest;
    latest = null;
    if (!frame) return;
    lastSent = Date.now();
    for (const s of [...subs]) {
      try { s.onFrame(frame); } catch {}
    }
  }

  // Hands out at most `fps` frames a second. An onset is a short spike, so while frames are held
  // back the strongest onset is kept (the level is just the newest one): a click is never dropped.
  function onFrame(frame: number[]) {
    latest = latest ? [frame[0], Math.max(latest[1], frame[1])] : frame;
    if (flushTimer !== undefined) return;
    const wait = lastSent + frameGap - Date.now();
    if (wait <= 0) flush();
    else flushTimer = setTimeout(flush, wait);
  }

  function onStderr(p: Subprocess, line: string) {
    if (proc !== p || !line) return;
    if (line === "ready") {
      setStatus({ state: "running" });
    } else if (line.startsWith("error:")) {
      const reason = line.slice(6).trim() || "The microphone helper failed.";
      reportedError = true;
      setStatus({ state: "error", error: /microphone access/i.test(reason) ? `${reason}. ${PERMISSION_HINT}` : reason });
    }
  }

  function buildFailure(msg: string): BuildResult {
    const text = msg.trim().replace(/\s+/g, " ");
    const short = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return { ok: false, error: `Could not build the microphone helper (${short || "no output"}). ${BUILD_HINT}` };
  }

  // Compiles tools/mic.swift when the binary is missing or older than the source or its plist.
  // Async spawn: the event loop (and the pad) stays responsive during the ~10 s build.
  async function compile(): Promise<BuildResult> {
    try {
      const srcTime = statSync(source).mtimeMs;
      let plistTime = existsSync(plistFile) ? statSync(plistFile).mtimeMs : 0;
      if (!existsSync(plistFile) || readFileSync(plistFile, "utf8") !== MIC_PLIST) {
        writeFileSync(plistFile, MIC_PLIST);
        plistTime = statSync(plistFile).mtimeMs;
      }
      if (existsSync(bin) && statSync(bin).mtimeMs >= Math.max(srcTime, plistTime)) return { ok: true };
      const out = `${bin}.tmp`;
      const p = Bun.spawn(micSwiftcArgs(source, out, plistFile), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
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

  function spawnHelper(argv: string[]) {
    const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true }); // stdin stays open: EOF tells the helper we are gone
    proc = p;
    reportedError = false;
    const t0 = Date.now();
    writeFileSync(pidFile, String(p.pid));
    void readLines(p.stdout, (line) => {
      if (proc !== p) return;
      const frame = parseMicFrame(line);
      if (frame) onFrame(frame);
    });
    void readLines(p.stderr, (line) => onStderr(p, line));
    void p.exited.then(() => {
      if (proc !== p) return; // stopped on purpose
      proc = null;
      try { unlinkSync(pidFile); } catch {}
      if (subs.size === 0) return; // the idle timer winds everything down
      if (reportedError) return; // e.g. permission denied: the error stays until somebody subscribes again
      fails = Date.now() - t0 < quickMs ? fails + 1 : 0;
      if (fails >= MAX_QUICK_FAILS) {
        setStatus({ state: "error", error: status.error ?? "The microphone helper keeps exiting." });
        return;
      }
      if (status.state !== "error") setStatus({ state: "starting" });
      retryTimer = setTimeout(() => { retryTimer = undefined; void launch(); }, retryMs);
    });
  }

  async function launch(): Promise<void> {
    const mine = gen;
    launching = true;
    let argv = opts.helper;
    if (!argv) {
      const built = await (building ??= compile().finally(() => { building = null; }));
      if (gen !== mine) return;
      if (!built.ok) {
        launching = false;
        setStatus({ state: "error", error: built.error });
        return;
      }
      argv = [bin, "--fps", String(fps)];
    }
    launching = false;
    try {
      spawnHelper(argv);
    } catch (e) {
      setStatus({ state: "error", error: `Could not start the microphone helper: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function begin() {
    fails = 0;
    setStatus({ state: "starting" });
    void launch();
  }

  function stopHelper() {
    gen++;
    launching = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearTimeout(flushTimer);
    flushTimer = undefined;
    latest = null;
    fails = 0;
    const p = proc;
    proc = null;
    if (p) terminate(p);
    try { unlinkSync(pidFile); } catch {}
    setStatus({ state: "idle" });
  }

  return {
    subscribe(onFrameCb, onStatus) {
      const sub: Subscriber = { onFrame: onFrameCb, onStatus };
      clearTimeout(idleTimer);
      idleTimer = undefined;
      // A helper that gave up (or failed to build) is tried again when somebody new shows up.
      // This runs before the subscriber is added, so it reads the new status through status().
      if (!proc && !launching && retryTimer === undefined) begin();
      subs.add(sub);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        subs.delete(sub);
        if (subs.size === 0) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { idleTimer = undefined; stopHelper(); }, idleMs);
        }
      };
    },
    status: () => status,
    stop() {
      clearTimeout(idleTimer);
      idleTimer = undefined;
      stopHelper();
    },
  };
}
