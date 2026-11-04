import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createMic, MIC_PLIST, micSwiftcArgs, parseMicFrame, type MicOptions } from "../lib/mic.ts";
import { sseResponse, type Viz, type VizStatus } from "../lib/viz.ts";

// Real child processes (fake helpers written in sh, plus the real helper in --test-script mode only:
// real capture would open the microphone and pop a macOS permission dialog, so it is never run here).
// Tests wait for a *condition* (polling `until`) instead of a guessed duration. The few fixed
// Bun.sleep calls are negative checks ("nothing may happen") on real processes, which fake timers cannot observe.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (dir: string) => Number(readFileSync(`${dir}/mic.pid`, "utf8"));
async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}
const tmp = () => mkdtempSync("/tmp/mic-");
// argv[0] carries the orphan marker, like the real binary's name does.
const sh = (script: string) => ["/bin/sh", "-c", script, "tabdeck-mic-fake"];
// Prints a frame and `ready`, then stays alive like the real helper.
const STEADY = sh("echo ready >&2; echo '[0.1,0.2]'; exec sleep 30");

const mics: Viz[] = [];
afterEach(() => { for (const m of mics.splice(0)) m.stop(); });
const make = (opts: MicOptions) => {
  const m = createMic({ idleMs: 50, retryMs: 20, ...opts });
  mics.push(m);
  return m;
};

describe("lifecycle", () => {
  test("the helper starts with the first subscriber and stops idleMs after the last one leaves", async () => {
    const dir = tmp();
    const mic = make({ dir, helper: STEADY });
    expect(mic.status()).toEqual({ state: "idle" });
    expect(existsSync(`${dir}/mic.pid`)).toBe(false);

    const off1 = mic.subscribe(() => {}, () => {});
    expect(mic.status().state).toBe("starting");
    await until(() => mic.status().state === "running", "helper to report ready");
    const pid = pidOf(dir);
    expect(alive(pid)).toBe(true);

    const off2 = mic.subscribe(() => {}, () => {});
    off1();
    await Bun.sleep(120); // longer than idleMs: a remaining subscriber keeps the helper alive
    expect(alive(pid)).toBe(true);

    off2();
    await until(() => !alive(pid), "helper to stop after the idle time");
    expect(mic.status()).toEqual({ state: "idle" });
    expect(existsSync(`${dir}/mic.pid`)).toBe(false);
  });

  test("a subscriber returning within idleMs keeps the same helper", async () => {
    const dir = tmp();
    const mic = make({ dir, helper: STEADY, idleMs: 300 });
    const off = mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "running", "ready");
    const pid = pidOf(dir);
    off();
    const again = mic.subscribe(() => {}, () => {});
    await Bun.sleep(400);
    expect(alive(pid)).toBe(true);
    expect(pidOf(dir)).toBe(pid);
    again();
  });

  test("unsubscribing twice is harmless", async () => {
    const mic = make({ dir: tmp(), helper: STEADY });
    const a = mic.subscribe(() => {}, () => {});
    const b = mic.subscribe(() => {}, () => {});
    a();
    a();
    await Bun.sleep(120);
    expect(mic.status().state).not.toBe("idle"); // b is still subscribed
    b();
  });

  test("stop() ends the helper at once, without waiting for the idle time", async () => {
    const dir = tmp();
    const mic = make({ dir, helper: STEADY, idleMs: 60_000 });
    mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "running", "ready");
    const pid = pidOf(dir);
    mic.stop();
    await until(() => !alive(pid), "helper to stop");
    expect(mic.status()).toEqual({ state: "idle" });
    expect(existsSync(`${dir}/mic.pid`)).toBe(false);
  });
});

describe("frames", () => {
  test("parseMicFrame accepts only a [level, onset] pair of finite numbers and clamps to 0...1", () => {
    expect(parseMicFrame("[0.5,0.25]")).toEqual([0.5, 0.25]);
    expect(parseMicFrame("[0,1]")).toEqual([0, 1]);
    expect(parseMicFrame("[1.5,-2]")).toEqual([1, 0]);
    expect(parseMicFrame("[-0.1,7]")).toEqual([0, 1]);
    for (const bad of ["", "garbage", "[1,", "{\"a\":1}", "\"x\"", "7", "[]", "[0.1]", "[0.1,0.2,0.3]", "[\"x\",1]", "[null,1]", "[0,true]", "[1e999,0]", "[0,-1e999]"]) {
      expect(parseMicFrame(bad)).toBeNull();
    }
  });

  test("malformed lines are ignored", async () => {
    const noisy = sh(
      "echo ready >&2; echo 'garbage'; echo '[1,'; echo '{\"a\":1}'; echo '[\"x\"]'; echo '[]'; echo '[0.1]'; echo '[null,1]'; echo '[1e999,0]'; echo ''; echo '[0.5,0.25]'; exec sleep 30",
    );
    const mic = make({ dir: tmp(), helper: noisy });
    const frames: number[][] = [];
    mic.subscribe((f) => frames.push(f), () => {});
    await until(() => frames.length >= 1, "a frame");
    expect(frames).toEqual([[0.5, 0.25]]);
  });

  test("out-of-range numbers are clamped", async () => {
    const mic = make({ dir: tmp(), helper: sh("echo ready >&2; echo '[1.5,-2]'; exec sleep 30") });
    const frames: number[][] = [];
    mic.subscribe((f) => frames.push(f), () => {});
    await until(() => frames.length >= 1, "a frame");
    expect(frames).toEqual([[1, 0]]);
  });

  test("frames are rate limited, the newest level wins and no click is dropped", async () => {
    // The first frame goes out at once; the other three arrive within one frame gap and merge:
    // newest level (0.4), strongest onset (0.9, which was in a frame that is no longer the newest).
    const burst = sh("echo ready >&2; echo '[0.1,0.2]'; echo '[0.2,0.9]'; echo '[0.3,0]'; echo '[0.4,0.1]'; exec sleep 30");
    const mic = make({ dir: tmp(), helper: burst, fps: 5 });
    const frames: number[][] = [];
    mic.subscribe((f) => frames.push(f), () => {});
    await until(() => frames.at(-1)?.[0] === 0.4, "the newest level to arrive");
    expect(frames[0]).toEqual([0.1, 0.2]);
    expect(frames.at(-1)).toEqual([0.4, 0.9]);
    expect(frames.length).toBeLessThanOrEqual(2);
  });
});

describe("status from stderr", () => {
  test("ready maps to running, silent is not a state here, error carries the reason", async () => {
    const talky = sh("echo silent >&2; echo ready >&2; echo silent >&2; echo 'error: boom' >&2; exec sleep 30");
    const mic = make({ dir: tmp(), helper: talky });
    const seen: VizStatus[] = [];
    mic.subscribe(() => {}, (s) => seen.push(s));
    await until(() => mic.status().state === "error", "error status");
    expect(seen).toEqual([{ state: "running" }, { state: "error", error: "boom" }]);
  });

  test("a quiet room is not an error: ready without any frame is running", async () => {
    const mic = make({ dir: tmp(), helper: sh("echo ready >&2; exec sleep 30") });
    const frames: number[][] = [];
    mic.subscribe((f) => frames.push(f), () => {});
    await until(() => mic.status().state === "running", "ready");
    expect(mic.status()).toEqual({ state: "running" });
    expect(frames).toEqual([]);
  });

  test("a denied permission is an error with a hint, is not retried, and is tried again for a new viewer", async () => {
    const dir = tmp();
    const denied = sh(`echo x >> ${dir}/runs; echo 'error: microphone access denied' >&2; exit 2`);
    const mic = make({ dir, helper: denied });
    mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "error", "error status");
    const msg = mic.status().error ?? "";
    expect(msg).toContain("microphone access denied");
    expect(msg).toContain("Allow Microphone for the process that runs the server (System Settings → Privacy & Security)");
    const runs = () => readFileSync(`${dir}/runs`, "utf8").trim().split("\n").length;
    await Bun.sleep(150); // several retry periods: no restart of a helper that cannot work
    expect(runs()).toBe(1);
    expect(mic.status().state).toBe("error");
    expect(existsSync(`${dir}/mic.pid`)).toBe(false);

    mic.subscribe(() => {}, () => {});
    await until(() => runs() === 2, "a second attempt for the new viewer");
  });
});

describe("restarts", () => {
  test("a helper that dies is restarted and recovers", async () => {
    const dir = tmp();
    const flaky = sh(`echo x >> ${dir}/runs; [ $(wc -l < ${dir}/runs) -ge 2 ] || exit 1; echo ready >&2; exec sleep 30`);
    const mic = make({ dir, helper: flaky });
    mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "running", "helper to come back");
    expect(readFileSync(`${dir}/runs`, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("five quick failures in a row end in an error and no more restarts", async () => {
    const dir = tmp();
    const mic = make({ dir, helper: sh(`echo x >> ${dir}/runs; exit 1`) });
    mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "error", "error status");
    expect(mic.status().error).toContain("keeps exiting");
    const runs = () => readFileSync(`${dir}/runs`, "utf8").trim().split("\n").length;
    expect(runs()).toBe(5);
    await Bun.sleep(150);
    expect(runs()).toBe(5);
  });
});

describe("compiling", () => {
  test("a compile failure is an error status with the compiler message and an install hint", async () => {
    const dir = tmp();
    writeFileSync(`${dir}/broken.swift`, "this is not swift {{{\n");
    const mic = make({ dir, source: `${dir}/broken.swift` });
    mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "error", "build error", 60_000);
    const msg = mic.status().error ?? "";
    expect(msg).toContain("Could not build the microphone helper");
    expect(msg).toContain("xcode-select --install");
    expect(msg.length).toBeLessThan(500);
    expect(existsSync(`${dir}/tabdeck-mic`)).toBe(false);
    expect(existsSync(`${dir}/mic.pid`)).toBe(false);
    expect(readFileSync(`${dir}/tabdeck-mic.plist`, "utf8")).toContain("NSMicrophoneUsageDescription");
  }, 70_000);

  test("a missing source file is reported the same way", async () => {
    const dir = tmp();
    const mic = make({ dir, source: `${dir}/nope.swift` });
    mic.subscribe(() => {}, () => {});
    await until(() => mic.status().state === "error", "build error");
    expect(mic.status().error).toContain("xcode-select --install");
  });
});

describe("orphans", () => {
  test("a helper left behind by a killed server is stopped at the next start", async () => {
    const dir = tmp();
    // "sleep 30; true" keeps sh from exec'ing, so the command line still contains the marker.
    const orphan = Bun.spawn(["/bin/sh", "-c", "sleep 30; true", "tabdeck-mic-orphan"], { detached: true });
    await Bun.write(`${dir}/mic.pid`, String(orphan.pid));
    expect(alive(orphan.pid)).toBe(true);
    make({ dir, helper: STEADY });
    await until(() => !alive(orphan.pid), "orphan to be stopped");
    expect(existsSync(`${dir}/mic.pid`)).toBe(false);
  });

  test("a stale pid that now belongs to something else is left alone", async () => {
    const dir = tmp();
    const other = Bun.spawn(["sleep", "30"], { detached: true });
    await Bun.write(`${dir}/mic.pid`, String(other.pid));
    make({ dir, helper: STEADY });
    await Bun.sleep(100);
    expect(alive(other.pid)).toBe(true);
    process.kill(other.pid, "SIGKILL");
  });
});

describe("sseResponse", () => {
  test("streams the mic like a Viz and unsubscribes when the request is aborted", async () => {
    const dir = tmp();
    const mic = make({ dir, helper: STEADY });
    const ac = new AbortController();
    const res = sseResponse(mic, ac.signal);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })();
    await until(() => text.includes("data: [0.1,0.2]\n\n"), "a data frame");
    expect(text).toContain('event: status\ndata: {"state":"starting"}\n\n');
    await until(() => text.includes('event: status\ndata: {"state":"running"}\n\n'), "running status");

    const pid = pidOf(dir);
    ac.abort();
    await pump;
    await until(() => !alive(pid), "helper to stop once the only viewer is gone");
  });
});

// The real helper, in --test-script mode only: it never touches AVFoundation.
const HAS_SWIFTC = existsSync("/usr/bin/swiftc");
describe("real helper (--test-script)", () => {
  test.skipIf(!HAS_SWIFTC)("compiles with the Info.plist embedded, prints [level, onset] lines and exits on SIGTERM", async () => {
    const dir = tmp();
    const bin = `${dir}/tabdeck-mic`;
    writeFileSync(`${dir}/tabdeck-mic.plist`, MIC_PLIST);
    const build = Bun.spawn(micSwiftcArgs(`${import.meta.dir}/../tools/mic.swift`, bin, `${dir}/tabdeck-mic.plist`), {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(readFileSync(bin).includes("NSMicrophoneUsageDescription")).toBe(true);

    // Raw output: exactly one `[level,onset]` line with 3 decimals per frame, `ready` on stderr.
    const p = Bun.spawn([bin, "--test-script", "--fps", "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines: string[] = [];
    const errLines: string[] = [];
    const pumpLines = async (stream: ReadableStream<Uint8Array>, into: string[]) => {
      let rest = "";
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        rest += decoder.decode(chunk, { stream: true });
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        into.push(...parts);
      }
    };
    void pumpLines(p.stdout, lines);
    void pumpLines(p.stderr, errLines);
    await until(() => lines.length >= 60, "60 frames", 10_000);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    expect(errLines).toEqual(["ready"]);
    for (const line of lines) expect(line).toMatch(/^\[\d\.\d{3},\d\.\d{3}\]$/);
    const frames = lines.map((l) => parseMicFrame(l));
    expect(frames.every((f) => f !== null)).toBe(true);
    expect(frames.slice(0, 20)).toEqual(Array(20).fill([0, 0])); // starts with silence
    const clicks = frames.filter((f) => f !== null && f[1] >= 0.85);
    expect(clicks.length).toBeGreaterThanOrEqual(5); // then a burst of clicks
    expect(frames.every((f) => f !== null && f[0] >= 0 && f[0] <= 1 && f[1] >= 0 && f[1] <= 1)).toBe(true);

    // And through the module, like the server runs it.
    const mic = make({ dir, helper: [bin, "--test-script"], fps: 30 });
    const got: number[][] = [];
    mic.subscribe((f) => got.push(f), () => {});
    await until(() => got.some((f) => f[1] >= 0.85), "a click frame", 10_000);
    expect(mic.status().state).toBe("running");
    const pid = pidOf(dir);
    mic.stop();
    await until(() => !alive(pid), "helper to exit on SIGTERM");
  }, 120_000);
});
