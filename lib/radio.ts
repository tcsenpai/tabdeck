// Radio widget, Mac side: plays a Nightride FM station on the Mac through mpv or ffplay.
// The station list is a whitelist, so a request can never make the server open an arbitrary URL.
// Playing on the tablet instead is done entirely in the browser (public/radio.js); this module only
// remembers the chosen station and output and runs the Mac player.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import { ConfigError } from "./config.ts";

export const STATIONS = [
  "nightride", "chillsynth", "datawave", "spacesynth", "darksynth", "horrorsynth",
  "ebsm", "rekt", "rektory", "rektify", "d-notive",
] as const;
export type Output = "mac" | "tablet";
export type Status = "idle" | "loading" | "playing" | "error";

export interface RadioState {
  station: string;
  output: Output;
  status: Status; // Mac player only; "idle" while the output is the tablet
  error?: string;
}

const streamUrl = (id: string) => `https://stream.nightride.fm/${id}.mp3`;
const SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const MAX_QUICK_FAILS = 5; // exits within QUICK_MS, in a row, before giving up

// RADIO_PLAYER="cmd arg …" overrides detection (the stream URL is appended). Otherwise the first of
// mpv, ffplay found (launchd runs us with a minimal PATH, hence the fixed dirs).
export function findPlayer(): string[] | null {
  const custom = process.env.RADIO_PLAYER?.trim();
  if (custom) return custom.split(/\s+/);
  const dirs = [...SEARCH_DIRS, ...(process.env.PATH ?? "").split(":")];
  for (const dir of dirs) {
    if (existsSync(`${dir}/mpv`)) return [`${dir}/mpv`, "--no-video", "--no-terminal", "--really-quiet"];
  }
  for (const dir of dirs) {
    if (existsSync(`${dir}/ffplay`)) return [`${dir}/ffplay`, "-nodisp", "-loglevel", "quiet"];
  }
  return null;
}

// Validates a request body: any of { station, output, toggle }.
export function radioCommand(raw: unknown): RadioCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("expected an object");
  const o = raw as Record<string, unknown>;
  const cmd: { station?: string; output?: Output; toggle?: true } = {};
  if (o.station !== undefined) {
    if (typeof o.station !== "string" || !(STATIONS as readonly string[]).includes(o.station)) throw new ConfigError("Unknown station");
    cmd.station = o.station;
  }
  if (o.output !== undefined) {
    if (o.output !== "mac" && o.output !== "tablet") throw new ConfigError("output: mac/tablet");
    cmd.output = o.output;
  }
  if (o.toggle !== undefined) {
    if (o.toggle !== true) throw new ConfigError("toggle: true");
    cmd.toggle = true;
  }
  return cmd;
}

export interface RadioCommand {
  station?: string;
  output?: Output;
  toggle?: true;
}

// Public surface of the player, for consumers (server, tests).
export interface Radio {
  get(): RadioState;
  toggle(): void;
  setStation(id: string): void;
  setOutput(o: Output): void;
  stop(): void;
  apply(cmd: RadioCommand): RadioState;
}

export interface RadioOptions {
  player?: string[] | null; // override (tests)
  readyMs?: number; // how long a running player counts as "loading" before "playing"
  retryMs?: number;
  quickMs?: number;
}

export function createRadio(dir: string, opts: RadioOptions = {}): Radio {
  const file = `${dir}/radio.json`;
  const pidFile = `${dir}/radio.pid`;
  const readyMs = opts.readyMs ?? 2000;
  const retryMs = opts.retryMs ?? 2000;
  const quickMs = opts.quickMs ?? 5000;

  let station: string = STATIONS[0];
  let output: Output = "mac";
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    const cmd = radioCommand(saved);
    if (cmd.station) station = cmd.station;
    if (cmd.output) output = cmd.output;
  } catch {} // missing or unreadable: defaults

  // A player left over by a server that was killed hard would keep playing forever: stop it now.
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    const cmdline = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
    if (pid > 1 && cmdline.includes("nightride.fm")) process.kill(-pid, "SIGKILL");
  } catch {}
  try { unlinkSync(pidFile); } catch {}

  let want = false;
  let status: Status = "idle";
  let error: string | undefined;
  let proc: Subprocess | null = null;
  let timer: Timer | undefined;
  let fails = 0;

  function persist() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ station, output }));
    renameSync(tmp, file);
  }

  function killProc() {
    clearTimeout(timer);
    timer = undefined;
    const p = proc;
    proc = null;
    if (p) {
      try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
    }
    try { unlinkSync(pidFile); } catch {}
  }

  function start() {
    const player = opts.player === undefined ? findPlayer() : opts.player;
    if (!player) {
      want = false;
      status = "error";
      error = "No player found. Install mpv or ffmpeg: brew install mpv";
      return;
    }
    error = undefined;
    status = "loading";
    const p = Bun.spawn([...player, streamUrl(station)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    proc = p;
    const t0 = Date.now();
    writeFileSync(pidFile, String(p.pid));
    timer = setTimeout(() => { if (proc === p && status === "loading") status = "playing"; }, readyMs);
    p.exited.then(() => {
      if (proc !== p) return; // stopped or replaced on purpose
      proc = null;
      clearTimeout(timer);
      if (!want) return;
      fails = Date.now() - t0 < quickMs ? fails + 1 : 0;
      if (fails >= MAX_QUICK_FAILS) {
        want = false;
        status = "error";
        error = "The player keeps exiting. Check the network connection.";
        return;
      }
      status = "loading"; // dropped stream: reconnect
      timer = setTimeout(start, retryMs);
    });
  }

  function stop() {
    want = false;
    killProc();
    status = "idle";
    error = undefined;
  }

  const api: Radio = {
    get(): RadioState {
      return { station, output, status: output === "mac" ? status : "idle", ...(error && output === "mac" ? { error } : {}) };
    },
    toggle() {
      if (output !== "mac") return;
      if (want) return stop();
      want = true;
      fails = 0;
      start();
    },
    setStation(id: string) {
      if (id === station) return;
      station = id;
      persist();
      if (want) {
        killProc();
        fails = 0;
        start();
      }
    },
    setOutput(o: Output) {
      if (o === output) return;
      stop(); // switching device: the new one starts on the next tap (browsers need a user gesture anyway)
      output = o;
      persist();
    },
    stop,
    apply(cmd: RadioCommand): RadioState {
      if (cmd.output) api.setOutput(cmd.output);
      if (cmd.station) api.setStation(cmd.station);
      if (cmd.toggle) api.toggle();
      return api.get();
    },
  };
  return api;
}
