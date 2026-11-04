// System audio visualizer, Mac side: runs tools/sysaudio.swift (Core Audio tap + FFT), reads its
// spectrum lines and fans them out to browsers. The helper is compiled on first use and runs only
// while somebody is watching, so an unused tile costs nothing.
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";

export type VizState = "idle" | "starting" | "running" | "silent" | "error";

export interface VizStatus {
  state: VizState;
  error?: string;
}

export interface Viz {
  // `onFrame` is called at most `fps` times per second with the newest band levels. The current
  // status is not replayed: read `status()` after subscribing.
  subscribe(onFrame: (bands: number[]) => void, onStatus: (s: VizStatus) => void): () => void;
  status(): VizStatus;
  stop(): void;
}

export interface VizOptions {
  dir: string; // data directory: holds the compiled helper and viz.pid
  bands?: number;
  fps?: number;
  helper?: string[]; // argv used instead of compiling and running tools/sysaudio (tests)
  source?: string;
  idleMs?: number;
  retryMs?: number; // wait before restarting a helper that exited (default 2000)
  quickMs?: number; // an exit sooner than this after the start counts as a quick failure (default 5000)
}

interface Subscriber {
  onFrame: (bands: number[]) => void;
  onStatus: (s: VizStatus) => void;
}

type BuildResult = { ok: true } | { ok: false; error: string };

const SWIFTC = existsSync("/usr/bin/swiftc") ? "/usr/bin/swiftc" : "swiftc"; // launchd runs us with a minimal PATH
const COMPILE_MS = 120_000;
const MAX_QUICK_FAILS = 5; // quick exits in a row before giving up
const PING_MS = 15_000;
const HINT = "Install the Xcode Command Line Tools: xcode-select --install";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

function parseFrame(line: string): number[] | null {
  if (!line.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(line);
    if (!Array.isArray(v) || v.length === 0) return null;
    return v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : null;
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
  // The helper cleans up its tap on SIGTERM; anything that ignores it is killed shortly after.
  setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 1000);
}

export function createViz(opts: VizOptions): Viz {
  const bands = clamp(opts.bands ?? 32, 8, 64);
  const fps = clamp(opts.fps ?? 20, 5, 30);
  const idleMs = opts.idleMs ?? 5000;
  const retryMs = opts.retryMs ?? 2000;
  const quickMs = opts.quickMs ?? 5000;
  const source = opts.source ?? `${import.meta.dir}/../tools/sysaudio.swift`;
  const bin = `${opts.dir}/sysaudio`;
  const pidFile = `${opts.dir}/viz.pid`;
  const frameGap = 1000 / fps;

  // A helper left over by a server that was killed hard would keep the tap (and the CPU) busy.
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    const cmdline = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
    if (pid > 1 && cmdline.includes("sysaudio")) {
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

  // Only the newest frame is kept and handed out at most `fps` times a second: a slow tablet
  // never makes a backlog build up.
  function onFrame(frame: number[]) {
    latest = frame;
    if (flushTimer !== undefined) return;
    const wait = lastSent + frameGap - Date.now();
    if (wait <= 0) flush();
    else flushTimer = setTimeout(flush, wait);
  }

  function onStderr(p: Subprocess, line: string) {
    if (proc !== p || !line) return;
    if (line === "ready" || line === "audio") setStatus({ state: "running" });
    else if (line === "silent") setStatus({ state: "silent" });
    else if (line.startsWith("error:")) setStatus({ state: "error", error: line.slice(6).trim() || "The audio helper failed." });
  }

  function buildFailure(msg: string): BuildResult {
    const text = msg.trim().replace(/\s+/g, " ");
    const short = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    return { ok: false, error: `Could not build the audio helper (${short || "no output"}). ${HINT}` };
  }

  // Compiles tools/sysaudio.swift when the binary is missing or older than the source.
  // Async spawn: the event loop (and the pad) stays responsive during the ~10 s build.
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

  function spawnHelper(argv: string[]) {
    const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true }); // stdin stays open: EOF tells the helper we are gone
    proc = p;
    const t0 = Date.now();
    writeFileSync(pidFile, String(p.pid));
    void readLines(p.stdout, (line) => {
      if (proc !== p) return;
      const frame = parseFrame(line);
      if (frame) onFrame(frame);
    });
    void readLines(p.stderr, (line) => onStderr(p, line));
    void p.exited.then(() => {
      if (proc !== p) return; // stopped on purpose
      proc = null;
      try { unlinkSync(pidFile); } catch {}
      if (subs.size === 0) return; // the idle timer winds everything down
      fails = Date.now() - t0 < quickMs ? fails + 1 : 0;
      if (fails >= MAX_QUICK_FAILS) {
        setStatus({ state: "error", error: status.error ?? "The audio helper keeps exiting." });
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
      const built = await ensureBinary();
      if (gen !== mine) return;
      if (!built.ok) {
        launching = false;
        setStatus({ state: "error", error: built.error });
        return;
      }
      argv = [bin, "--bands", String(bands), "--fps", String(fps)];
    }
    launching = false;
    try {
      spawnHelper(argv);
    } catch (e) {
      setStatus({ state: "error", error: `Could not start the audio helper: ${e instanceof Error ? e.message : String(e)}` });
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

// Server-sent events for one browser: `data:` per frame, `event: status` on every status change,
// a comment line every 15 s to keep proxies and the server's idle timeout from cutting the stream.
export function sseResponse(viz: Viz, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let ping: Timer | undefined;
  let close: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      close = () => {
        if (!open) return;
        open = false;
        unsubscribe?.();
        clearInterval(ping);
        signal.removeEventListener("abort", close);
        try { controller.close(); } catch {}
      };
      const send = (text: string) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(text)); } catch { close(); }
      };
      const sendStatus = (s: VizStatus) => send(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
      if (signal.aborted) return close();
      signal.addEventListener("abort", close);
      unsubscribe = viz.subscribe((bands) => send(`data: ${JSON.stringify(bands)}\n\n`), sendStatus);
      sendStatus(viz.status());
      ping = setInterval(() => send(": ping\n\n"), PING_MS);
    },
    cancel() { close(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
}
