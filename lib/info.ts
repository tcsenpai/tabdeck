// Info bar readers: cheap system metrics (CPU, RAM, battery, ...) shown as small chips on the pad.
// Every source is a stock macOS tool that needs no permissions, called by absolute path (launchd runs
// us with a minimal PATH, and a Homebrew `df` would print other columns). Reads are cached per kind
// and shared while in flight, so several tablets polling do not multiply processes.
// A source that fails, times out or prints something unexpected yields "—": the bar never throws.

export const INFO_KINDS = ["cpu", "mem", "battery", "disk", "volume", "uptime", "load", "clock"] as const;
export type InfoKind = (typeof INFO_KINDS)[number];

export function isInfoKind(v: unknown): v is InfoKind {
  return typeof v === "string" && (INFO_KINDS as readonly string[]).includes(v);
}

export interface InfoValue {
  kind: InfoKind;
  label: string; // ≤ 8 chars, English uppercase
  text: string; // ≤ 12 chars
  level: number | null; // 0..1 for a mini gauge
  warn: boolean;
}

// `signal` aborts when the read times out; implementations that cannot be interrupted may ignore it.
export type InfoRun = (argv: string[], signal: AbortSignal) => Promise<string>;

export interface InfoOptions {
  run?: InfoRun;
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface Info {
  read(kinds: InfoKind[]): Promise<InfoValue[]>;
}

const TTL_MS = 2000;
const TIMEOUT_MS = 2500;
const NONE = "—";

const SYSCTL = "/usr/sbin/sysctl";
const LABELS: Record<InfoKind, string> = {
  cpu: "CPU", mem: "RAM", battery: "BATT", disk: "DISK", volume: "VOL", uptime: "UP", load: "LOAD", clock: "TIME",
};

// Stdout of a child that exits 0; killed through `signal` on timeout.
export async function runCommand(argv: string[], signal: AbortSignal): Promise<string> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`${argv[0]} exited with ${code}`);
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => `${Math.round(n)}%`;

function num(s: string | undefined, what: string): number {
  const n = Number(s);
  if (s === undefined || s === "" || !Number.isFinite(n)) throw new Error(`cannot parse ${what}`);
  return n;
}

// ---- parsers (pure; exported for tests) ----------------------------------------------------------

// `iostat -n0 -C -w 1 -c 2`: the first data row is the average since boot, the second covers the
// one-second interval. We want the last row that starts with the three CPU columns: us sy id.
// Returns busy percent (user + system).
export function parseIostatCpu(out: string): number {
  let busy: number | null = null;
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/.exec(line);
    if (m) busy = Number(m[1]) + Number(m[2]);
  }
  if (busy === null) throw new Error("no cpu row in iostat output");
  return busy;
}

// Memory in use as Activity Monitor counts it: App Memory + Wired + Compressed, where
// App Memory = anonymous pages − purgeable pages. Returns bytes.
export function parseVmStatUsed(out: string): number {
  const size = num(/page size of (\d+) bytes/.exec(out)?.[1], "vm_stat page size");
  const pages = (name: string) => num(new RegExp(`^${name}:\\s+(\\d+)\\.`, "m").exec(out)?.[1], `vm_stat ${name}`);
  const used = pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor");
  return Math.max(0, used) * size;
}

export interface BatteryReading {
  percent: number | null; // null on a Mac without a battery
  charging: boolean;
  draining: boolean; // running on the battery
}

export function parseBattery(out: string): BatteryReading {
  const source = /Now drawing from '([^']*)'/.exec(out)?.[1];
  if (source === undefined) throw new Error("no power source in pmset output");
  const line = out.split("\n").find((l) => l.includes("InternalBattery")) ?? "";
  const m = /(\d+)%;\s*([^;]*)/.exec(line);
  if (!m) return { percent: null, charging: false, draining: false };
  const state = m[2]!.trim();
  return {
    percent: Number(m[1]),
    charging: state === "charging" || state === "finishing charge",
    draining: source === "Battery Power" || state === "discharging",
  };
}

// `df -k /` (BSD df). On APFS the "Used" column of "/" covers only the sealed system volume, while
// size and available are container-wide, so the used share is (size − available) / size.
export function parseDiskUsed(out: string): number {
  const row = out.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const size = num(row[1], "df size");
  const avail = num(row[3], "df available");
  if (size <= 0) throw new Error("df reported an empty disk");
  return clamp01((size - avail) / size) * 100;
}

// `sysctl -n vm.loadavg` → "{ 1.05 1.20 1.31 }"; returns the 1-minute average.
export function parseLoadAvg(out: string): number {
  return num(/\{\s*([\d.]+)/.exec(out)?.[1], "vm.loadavg");
}

// `sysctl -n kern.boottime` → "{ sec = 1793457997, usec = 405856 } Sat Oct 31 …"; epoch seconds.
export function parseBootSec(out: string): number {
  return num(/sec\s*=\s*(\d+)/.exec(out)?.[1], "kern.boottime");
}

// `osascript -e 'output volume of (get volume settings)'` prints 0..100, or "missing value" for
// outputs without a volume control (some HDMI/USB devices).
export function parseVolume(out: string): number {
  const v = num(/^\s*(\d+(?:\.\d+)?)\s*$/.exec(out)?.[1], "output volume");
  return clamp01(v / 100) * 100;
}

export function formatUptime(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

// ---- reader --------------------------------------------------------------------------------------

export function createInfo(opts: InfoOptions = {}): Info {
  const run = opts.run ?? runCommand;
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlMs ?? TTL_MS;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;

  // One command, bounded by the timeout. The race also covers an injected `run` that ignores the signal.
  async function sh(argv: string[]): Promise<string> {
    const ctl = new AbortController();
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    ctl.signal.addEventListener("abort", () => reject(new Error(`${argv[0]} timed out`)), { once: true });
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      return await Promise.race([run(argv, ctl.signal), aborted]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Facts that never change while we run: fetched once, retried only after a failure.
  const once = <T>(fetch: () => Promise<T>) => {
    let p: Promise<T> | null = null;
    return () => {
      p ??= fetch().catch((e: unknown) => { p = null; throw e; });
      return p;
    };
  };
  const positive = (s: string, what: string) => {
    const n = num(s.trim(), what);
    if (n <= 0) throw new Error(`${what} is not positive`);
    return n;
  };
  const memSize = once(async () => positive(await sh([SYSCTL, "-n", "hw.memsize"]), "hw.memsize"));
  const cpuCount = once(async () => positive(await sh([SYSCTL, "-n", "hw.ncpu"]), "hw.ncpu"));

  const value = (kind: InfoKind, text: string, level: number | null, warn = false): InfoValue =>
    ({ kind, label: LABELS[kind], text, level: level === null ? null : clamp01(level), warn });

  const readers: Record<InfoKind, () => Promise<InfoValue>> = {
    async cpu() {
      const busy = parseIostatCpu(await sh(["/usr/sbin/iostat", "-n0", "-C", "-w", "1", "-c", "2"]));
      return value("cpu", pct(busy), busy / 100, Math.round(busy) > 85);
    },
    async mem() {
      const [out, total] = await Promise.all([sh(["/usr/bin/vm_stat"]), memSize()]);
      const used = (parseVmStatUsed(out) / total) * 100;
      return value("mem", pct(used), used / 100, Math.round(used) > 90);
    },
    async battery() {
      const b = parseBattery(await sh(["/usr/bin/pmset", "-g", "batt"]));
      if (b.percent === null) return value("battery", "AC", null);
      const text = b.charging ? `${b.percent}% CHG` : `${b.percent}%`;
      return value("battery", text, b.percent / 100, b.draining && b.percent <= 15);
    },
    async disk() {
      const used = parseDiskUsed(await sh(["/bin/df", "-k", "/"]));
      return value("disk", pct(used), used / 100, Math.round(used) > 92);
    },
    async volume() {
      const v = parseVolume(await sh(["/usr/bin/osascript", "-e", "output volume of (get volume settings)"]));
      return value("volume", pct(v), v / 100);
    },
    async uptime() {
      const out = await sh([SYSCTL, "-n", "kern.boottime"]);
      const ms = now().getTime() - parseBootSec(out) * 1000;
      if (ms < 0) throw new Error("boot time is in the future");
      return value("uptime", formatUptime(ms), null);
    },
    async load() {
      const [out, cores] = await Promise.all([sh([SYSCTL, "-n", "vm.loadavg"]), cpuCount()]);
      const l = parseLoadAvg(out);
      return value("load", l.toFixed(2), l / cores);
    },
    async clock() {
      const d = now();
      const two = (n: number) => String(n).padStart(2, "0");
      return value("clock", `${two(d.getHours())}:${two(d.getMinutes())}`, null);
    },
  };

  const cache = new Map<InfoKind, { at: number; v: InfoValue }>();
  const inflight = new Map<InfoKind, Promise<InfoValue>>();

  function load(kind: InfoKind): Promise<InfoValue> {
    // The clock reads no process, so it is never stale.
    if (kind === "clock") return readers.clock();
    const hit = cache.get(kind);
    if (hit && now().getTime() - hit.at < ttl) return Promise.resolve(hit.v);
    const flying = inflight.get(kind);
    if (flying) return flying;
    const p = readers[kind]()
      .catch(() => value(kind, NONE, null))
      .then((v) => {
        cache.set(kind, { at: now().getTime(), v });
        return v;
      })
      .finally(() => inflight.delete(kind));
    inflight.set(kind, p);
    return p;
  }

  return {
    read(kinds) {
      return Promise.all(kinds.filter(isInfoKind).map(load));
    },
  };
}
