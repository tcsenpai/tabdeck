import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createInfo, formatUptime, INFO_KINDS, isInfoKind, parseBattery, parseBootSec, parseDiskUsed, parseIostatCpu,
  parseLoadAvg, parseVmStatUsed, parseVolume, type InfoKind, type InfoRun, type InfoValue,
} from "../lib/info.ts";

// Samples captured from this Mac (macOS 26, 10 cores, 32 GiB), trimmed to the lines the parsers read.
// The battery samples with a discharging/charging battery are written after the documented pmset
// format: this machine is a desktop, so only the AC/no-battery form is a real capture.
const IOSTAT = `      cpu    load average
 us sy id   1m   5m   15m
 20 14 66  103.43 165.54 165.73
 68 31  0  104.78 160.48 163.92
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5073.
Pages active:                                 457974.
Pages inactive:                               456627.
Pages speculative:                               785.
Pages throttled:                                   0.
Pages wired down:                             303147.
Pages purgeable:                                   4.
"Translation faults":                    11478788880.
File-backed pages:                            263671.
Anonymous pages:                              651715.
Pages stored in compressor:                  1601188.
Pages occupied by compressor:                 817123.
`;
const MEMSIZE = "34359738368\n";
const PMSET_DESKTOP = "Now drawing from 'AC Power'\n";
const PMSET_AC_FULL = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=37617763)\t100%; charged; 0:00 remaining present: true\n";
const pmset = (source: string, pct: number, state: string) =>
  `Now drawing from '${source}'\n -InternalBattery-0 (id=4653155)\t${pct}%; ${state}; 1:10 remaining present: true\n`;
const DF = `Filesystem     1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s3s1   971350180  13434956  79414712    15%  486809 794147120    0%   /
`;
const LOADAVG = "{ 104.78 160.48 163.92 }\n";
const BOOTTIME = "{ sec = 1793457997, usec = 405856 } Sat Oct 31 15:46:37 2026\n";
const NCPU = "10\n";
const BOOT_MS = 1793457997 * 1000;

type Reply = string | Error | (() => Promise<string>);
// Fake `run`: replies by command line (argv joined), records every call.
function fake(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const run: InfoRun = async (argv) => {
    const key = argv.join(" ");
    calls.push(key);
    const r = Object.entries(replies).find(([k]) => key.includes(k))?.[1];
    if (r === undefined) throw new Error(`unexpected command ${key}`);
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    return r;
  };
  return { run, calls };
}
const R = {
  iostat: "iostat", vm: "vm_stat", memsize: "hw.memsize", pmset: "pmset", df: "df -k", osa: "osascript",
  boot: "kern.boottime", load: "vm.loadavg", ncpu: "hw.ncpu",
};
const WORKING = {
  [R.iostat]: IOSTAT, [R.vm]: VM_STAT, [R.memsize]: MEMSIZE, [R.pmset]: PMSET_AC_FULL, [R.df]: DF,
  [R.osa]: "6\n", [R.boot]: BOOTTIME, [R.load]: LOADAVG, [R.ncpu]: NCPU,
};
const NOW = new Date(BOOT_MS + ((3 * 24 + 20) * 60 + 18) * 60_000);

async function one(kind: InfoKind, replies: Record<string, Reply>): Promise<InfoValue> {
  const [v] = await createInfo({ run: fake(replies).run, now: () => NOW }).read([kind]);
  return v!;
}
const deferred = () => Promise.withResolvers<string>();
async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}

describe("kinds", () => {
  test("isInfoKind accepts exactly the known ids", () => {
    for (const k of INFO_KINDS) expect(isInfoKind(k)).toBe(true);
    for (const bad of ["CPU", "", "gpu", 5, null, undefined, {}, ["cpu"]]) expect(isInfoKind(bad)).toBe(false);
  });
});

describe("parsers on real samples", () => {
  test("iostat: busy = user + system of the LAST row (the one-second interval)", () => {
    expect(parseIostatCpu(IOSTAT)).toBe(99);
    expect(parseIostatCpu(" us sy id\n  3  2 95\n")).toBe(5);
    expect(() => parseIostatCpu("")).toThrow();
    expect(() => parseIostatCpu("      cpu\n us sy id\n")).toThrow();
  });

  test("vm_stat: (anonymous − purgeable + wired + compressor) pages × page size", () => {
    expect(parseVmStatUsed(VM_STAT)).toBe((651715 - 4 + 303147 + 817123) * 16384);
    const small = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages wired down:                                200.
Pages purgeable:                                 100.
Anonymous pages:                                1000.
Pages occupied by compressor:                    300.
`;
    expect(parseVmStatUsed(small)).toBe(1400 * 4096);
    expect(() => parseVmStatUsed(VM_STAT.replace("Anonymous pages", "Anon"))).toThrow();
    expect(() => parseVmStatUsed("")).toThrow();
  });

  test("pmset: desktop without battery, full on AC, charging, discharging", () => {
    expect(parseBattery(PMSET_DESKTOP)).toEqual({ percent: null, charging: false, draining: false });
    expect(parseBattery(PMSET_AC_FULL)).toEqual({ percent: 100, charging: false, draining: false });
    expect(parseBattery(pmset("AC Power", 40, "charging"))).toEqual({ percent: 40, charging: true, draining: false });
    expect(parseBattery(pmset("AC Power", 99, "finishing charge")).charging).toBe(true);
    expect(parseBattery(pmset("Battery Power", 87, "discharging"))).toEqual({ percent: 87, charging: false, draining: true });
    expect(() => parseBattery("")).toThrow();
  });

  test("df: used share = (size − available) / size, not the APFS 'Used' column", () => {
    expect(parseDiskUsed(DF)).toBeCloseTo(((971350180 - 79414712) / 971350180) * 100, 6);
    expect(parseDiskUsed(DF)).toBeGreaterThan(90); // the Used column alone would say 1.4%
    expect(() => parseDiskUsed("Filesystem 1024-blocks\n")).toThrow();
    expect(() => parseDiskUsed("")).toThrow();
  });

  test("sysctl loadavg, boottime and osascript volume", () => {
    expect(parseLoadAvg(LOADAVG)).toBe(104.78);
    expect(() => parseLoadAvg("")).toThrow();
    expect(parseBootSec(BOOTTIME)).toBe(1793457997);
    expect(() => parseBootSec("nope")).toThrow();
    expect(parseVolume("6\n")).toBe(6);
    expect(parseVolume("100")).toBe(100);
    expect(() => parseVolume("missing value\n")).toThrow();
  });

  test("uptime format", () => {
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(59 * 60_000)).toBe("59m");
    expect(formatUptime(61 * 60_000)).toBe("1h 1m");
    expect(formatUptime((24 * 60 + 60) * 60_000)).toBe("1d 1h");
    expect(formatUptime(((3 * 24 + 20) * 60 + 18) * 60_000)).toBe("3d 20h");
  });
});

describe("values", () => {
  test("every kind from the real samples", async () => {
    const out = await createInfo({ run: fake(WORKING).run, now: () => NOW }).read([...INFO_KINDS]);
    const by = Object.fromEntries(out.map((v) => [v.kind, v])) as Record<InfoKind, InfoValue>;
    const memPct = ((651715 - 4 + 303147 + 817123) * 16384) / 34359738368;
    expect(by.cpu).toEqual({ kind: "cpu", label: "CPU", text: "99%", level: 0.99, warn: true });
    expect(by.mem.text).toBe(`${Math.round(memPct * 100)}%`); // 84%
    expect(by.mem.level).toBeCloseTo(memPct, 9);
    expect(by.mem.warn).toBe(false);
    expect(by.battery).toEqual({ kind: "battery", label: "BATT", text: "100%", level: 1, warn: false });
    expect(by.disk.text).toBe("92%");
    expect(by.disk.warn).toBe(false); // 91.8% rounds to 92, the threshold is "> 92"
    expect(by.volume).toEqual({ kind: "volume", label: "VOL", text: "6%", level: 0.06, warn: false });
    expect(by.uptime).toEqual({ kind: "uptime", label: "UP", text: "3d 20h", level: null, warn: false });
    expect(by.load).toEqual({ kind: "load", label: "LOAD", text: "104.78", level: 1, warn: false }); // 10.5 per core, clamped
    expect(by.clock.kind).toBe("clock");
    expect(by.clock.level).toBeNull();
  });

  test("load level is the 1-minute average per core", async () => {
    const v = await one("load", { ...WORKING, [R.load]: "{ 2.50 1.00 1.00 }", [R.ncpu]: "10\n" });
    expect(v.text).toBe("2.50");
    expect(v.level).toBeCloseTo(0.25, 9);
  });

  test("clock is local HH:MM from now(), never cached", async () => {
    let t = new Date(2026, 10, 4, 9, 5, 30);
    const info = createInfo({ run: fake({}).run, now: () => t });
    expect((await info.read(["clock"]))[0]!.text).toBe("09:05");
    t = new Date(2026, 10, 4, 23, 59, 59);
    expect((await info.read(["clock"]))[0]!.text).toBe("23:59");
  });

  test("desktop without battery: AC, no level, no warning, no error", async () => {
    expect(await one("battery", { ...WORKING, [R.pmset]: PMSET_DESKTOP })).toEqual(
      { kind: "battery", label: "BATT", text: "AC", level: null, warn: false },
    );
  });

  test("battery text: charging is marked", async () => {
    const v = await one("battery", { ...WORKING, [R.pmset]: pmset("AC Power", 40, "charging") });
    expect(v).toEqual({ kind: "battery", label: "BATT", text: "40% CHG", level: 0.4, warn: false });
  });

  test("labels and texts fit a small chip", async () => {
    const replies = { ...WORKING, [R.pmset]: pmset("AC Power", 100, "finishing charge"), [R.load]: "{ 1234.56 1 1 }" };
    for (const v of await createInfo({ run: fake(replies).run, now: () => NOW }).read([...INFO_KINDS])) {
      expect(v.label).toBe(v.label.toUpperCase());
      expect(v.label.length).toBeLessThanOrEqual(8);
      expect(v.text.length).toBeLessThanOrEqual(12);
    }
    for (const v of await createInfo({ run: fake({}).run, now: () => NOW }).read([...INFO_KINDS])) {
      expect(v.text.length).toBeLessThanOrEqual(12);
    }
  });
});

describe("warn thresholds", () => {
  const iostat = (busy: number) => ` us sy id\n ${busy} 0 ${100 - busy}\n`;
  const vm = (usedPct: number) => {
    const pages = Math.round((usedPct / 100) * 1_000_000); // 1M pages of 16384 bytes = memsize below
    return `(page size of 16384 bytes)\nPages wired down: ${pages}.\nPages purgeable: 0.\nAnonymous pages: 0.\nPages occupied by compressor: 0.\n`;
  };
  const df = (usedPct: number) => `Filesystem 1024-blocks Used Available Capacity\n/dev/x 1000 0 ${1000 - usedPct * 10} 0% /\n`;
  const MEM = String(1_000_000 * 16384);

  const cases: [InfoKind, string, Record<string, Reply>, boolean][] = [
    ["cpu", "85%", { [R.iostat]: iostat(85) }, false],
    ["cpu", "86%", { [R.iostat]: iostat(86) }, true],
    ["mem", "90%", { [R.vm]: vm(90), [R.memsize]: MEM }, false],
    ["mem", "91%", { [R.vm]: vm(91), [R.memsize]: MEM }, true],
    ["disk", "92%", { [R.df]: df(92) }, false],
    ["disk", "93%", { [R.df]: df(93) }, true],
    ["battery", "15% on battery", { [R.pmset]: pmset("Battery Power", 15, "discharging") }, true],
    ["battery", "16% on battery", { [R.pmset]: pmset("Battery Power", 16, "discharging") }, false],
    ["battery", "5% charging", { [R.pmset]: pmset("AC Power", 5, "charging") }, false],
    ["battery", "5% on AC, not charging", { [R.pmset]: pmset("AC Power", 5, "AC attached") }, false],
  ];
  for (const [kind, name, replies, warn] of cases) {
    test(`${kind} ${name} → warn ${warn}`, async () => {
      expect((await one(kind, { ...WORKING, ...replies })).warn).toBe(warn);
    });
  }
});

describe("failures", () => {
  const dash = (kind: InfoKind) => ({ kind, text: "—", level: null, warn: false });

  test("a failing source yields '—' and never throws", async () => {
    for (const kind of INFO_KINDS) {
      if (kind === "clock") continue; // no source to fail
      const v = await one(kind, {}); // every command throws "unexpected command"
      expect(v).toMatchObject(dash(kind));
    }
  });

  test("garbage output yields '—'", async () => {
    const garbage = Object.fromEntries(Object.keys(WORKING).map((k) => [k, "???"]));
    for (const kind of INFO_KINDS) {
      if (kind === "clock") continue;
      expect(await one(kind, garbage)).toMatchObject(dash(kind));
    }
    expect(await one("volume", { ...WORKING, [R.osa]: "missing value\n" })).toMatchObject(dash("volume"));
  });

  test("boot time in the future yields '—'", async () => {
    const early = new Date(BOOT_MS - 5000);
    const [v] = await createInfo({ run: fake(WORKING).run, now: () => early }).read(["uptime"]);
    expect(v).toMatchObject(dash("uptime"));
  });

  test("one failing kind does not affect the others", async () => {
    const out = await createInfo({ run: fake({ ...WORKING, [R.df]: new Error("boom") }).run, now: () => NOW }).read(["disk", "volume", "uptime"]);
    expect(out.map((v) => v.text)).toEqual(["—", "6%", "3d 20h"]);
  });

  test("a hung command is cut off by the timeout and gets the abort signal", async () => {
    let aborted = false;
    const run: InfoRun = (_argv, signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>(() => {}); // never answers, even ignoring the signal
    };
    const t0 = Date.now();
    const [v] = await createInfo({ run, now: () => NOW, timeoutMs: 30 }).read(["volume"]);
    expect(v).toMatchObject(dash("volume"));
    expect(Date.now() - t0).toBeLessThan(2000);
    await until(() => aborted, "abort signal");
  });

  test("memsize failure is retried on the next read, success is remembered", async () => {
    let fail = true;
    const memsize = async () => { if (fail) throw new Error("boom"); return MEMSIZE; };
    const f = fake({ ...WORKING, [R.memsize]: memsize });
    let t = NOW;
    const info = createInfo({ run: f.run, now: () => t, ttlMs: 10 });
    expect((await info.read(["mem"]))[0]!.text).toBe("—");
    fail = false;
    t = new Date(t.getTime() + 1000);
    expect((await info.read(["mem"]))[0]!.text).toBe("84%");
    t = new Date(t.getTime() + 1000);
    await info.read(["mem"]);
    expect(f.calls.filter((c) => c.includes("hw.memsize"))).toHaveLength(2); // failed once, then remembered
  });
});

describe("read()", () => {
  test("unknown kinds are skipped silently, order is kept", async () => {
    const info = createInfo({ run: fake(WORKING).run, now: () => NOW });
    const out = await info.read(["volume", "bogus", "", "uptime"] as unknown as InfoKind[]);
    expect(out.map((v) => v.kind)).toEqual(["volume", "uptime"]);
    expect(await info.read([])).toEqual([]);
  });

  test("kinds are read in parallel", async () => {
    const gates = { osa: deferred(), df: deferred(), boot: deferred() };
    const f = fake({ ...WORKING, [R.osa]: () => gates.osa.promise, [R.df]: () => gates.df.promise, [R.boot]: () => gates.boot.promise });
    const pending = createInfo({ run: f.run, now: () => NOW }).read(["volume", "disk", "uptime"]);
    await until(() => f.calls.length === 3, "all three commands started while none has finished");
    gates.osa.resolve("6\n");
    gates.df.resolve(DF);
    gates.boot.resolve(BOOTTIME);
    expect((await pending).map((v) => v.text)).toEqual(["6%", "92%", "3d 20h"]);
  });

  test("single-flight: concurrent reads of a kind share one process", async () => {
    const gate = deferred();
    const f = fake({ ...WORKING, [R.osa]: () => gate.promise });
    const info = createInfo({ run: f.run, now: () => NOW });
    const a = info.read(["volume"]);
    const b = info.read(["volume", "volume"]);
    await until(() => f.calls.length === 1, "first spawn");
    gate.resolve("30\n");
    const all = [...(await a), ...(await b)];
    expect(all.map((v) => v.text)).toEqual(["30%", "30%", "30%"]);
    expect(f.calls).toHaveLength(1);
  });

  test("cache: served within ttl, refreshed after it, failures cached too", async () => {
    let t = NOW;
    let volume = "10\n";
    const f = fake({ ...WORKING, [R.osa]: async () => volume });
    const info = createInfo({ run: f.run, now: () => t, ttlMs: 2000 });
    expect((await info.read(["volume"]))[0]!.text).toBe("10%");
    volume = "20\n";
    t = new Date(t.getTime() + 1999);
    expect((await info.read(["volume"]))[0]!.text).toBe("10%");
    t = new Date(t.getTime() + 1);
    expect((await info.read(["volume"]))[0]!.text).toBe("20%");
    expect(f.calls.filter((c) => c.includes("osascript"))).toHaveLength(2);

    const bad = fake({});
    const info2 = createInfo({ run: bad.run, now: () => t, ttlMs: 2000 });
    await info2.read(["volume"]);
    await info2.read(["volume"]);
    expect(bad.calls).toHaveLength(1);
  });

  test("cache is per kind, and the default ttl is 2 s", async () => {
    let t = NOW;
    const f = fake(WORKING);
    const info = createInfo({ run: f.run, now: () => t });
    await info.read(["volume"]);
    await info.read(["volume", "disk"]);
    expect(f.calls).toHaveLength(2); // volume once, disk once
    t = new Date(t.getTime() + 2000);
    await info.read(["volume"]);
    expect(f.calls).toHaveLength(3);
  });
});

// Live sources: well-formed output only (values depend on the machine). Skipped when the tool is
// missing; a source that fails here still yields "—", which is well-formed too.
describe("live sources", () => {
  const wellFormed = (v: InfoValue, kind: InfoKind) => {
    expect(v.kind).toBe(kind);
    expect(v.label.length).toBeGreaterThan(0);
    expect(v.label.length).toBeLessThanOrEqual(8);
    expect(v.text.length).toBeGreaterThan(0);
    expect(v.text.length).toBeLessThanOrEqual(12);
    if (v.level !== null) {
      expect(v.level).toBeGreaterThanOrEqual(0);
      expect(v.level).toBeLessThanOrEqual(1);
    }
    expect(typeof v.warn).toBe("boolean");
  };
  const live: [InfoKind, string, RegExp][] = [
    ["cpu", "/usr/sbin/iostat", /^\d+%$/],
    ["mem", "/usr/bin/vm_stat", /^\d+%$/],
    ["battery", "/usr/bin/pmset", /^(AC|\d+%( CHG)?)$/],
    ["disk", "/bin/df", /^\d+%$/],
    ["volume", "/usr/bin/osascript", /^\d+%$/],
    ["uptime", "/usr/sbin/sysctl", /^(\d+d \d+h|\d+h \d+m|\d+m)$/],
    ["load", "/usr/sbin/sysctl", /^\d+\.\d\d$/],
  ];
  for (const [kind, tool, shape] of live) {
    test.skipIf(!existsSync(tool))(`${kind} via ${tool}`, async () => {
      const [v] = await createInfo().read([kind]);
      wellFormed(v!, kind);
      expect(v!.text === "—" || shape.test(v!.text)).toBe(true);
    }, 15_000);
  }
});
