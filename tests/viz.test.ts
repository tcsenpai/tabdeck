import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createViz, sseResponse, type Viz, type VizOptions, type VizStatus } from "../lib/viz.ts";

// Real child processes (fake helpers written in sh, plus the real helper in --test-tone mode), so
// these tests wait for a *condition* (polling `until`) instead of a guessed duration. The few fixed
// Bun.sleep calls are negative checks ("nothing may happen") on real processes, which fake timers cannot observe.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (dir: string) => Number(readFileSync(`${dir}/viz.pid`, "utf8"));
async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}
const tmp = () => mkdtempSync("/tmp/viz-");
const sh = (script: string) => ["/bin/sh", "-c", script, "sysaudio-fake"];
// Prints a frame and `ready`, then stays alive like the real helper.
const STEADY = sh("echo ready >&2; echo '[0.1,0.2]'; exec sleep 30");

const vizzes: Viz[] = [];
afterEach(() => { for (const v of vizzes.splice(0)) v.stop(); });
const make = (opts: Partial<VizOptions> & { dir: string }) => {
  const v = createViz({ idleMs: 50, retryMs: 20, ...opts });
  vizzes.push(v);
  return v;
};

describe("lifecycle", () => {
  test("the helper starts with the first subscriber and stops idleMs after the last one leaves", async () => {
    const dir = tmp();
    const viz = make({ dir, helper: STEADY });
    expect(viz.status()).toEqual({ state: "idle" });
    expect(existsSync(`${dir}/viz.pid`)).toBe(false);

    const off1 = viz.subscribe(() => {}, () => {});
    expect(viz.status().state).toBe("starting");
    await until(() => viz.status().state === "running", "helper to report ready");
    const pid = pidOf(dir);
    expect(alive(pid)).toBe(true);

    const off2 = viz.subscribe(() => {}, () => {});
    off1();
    await Bun.sleep(120); // longer than idleMs: a remaining subscriber keeps the helper alive
    expect(alive(pid)).toBe(true);

    off2();
    await until(() => !alive(pid), "helper to stop after the idle time");
    expect(viz.status()).toEqual({ state: "idle" });
    expect(existsSync(`${dir}/viz.pid`)).toBe(false);
  });

  test("a subscriber returning within idleMs keeps the same helper", async () => {
    const dir = tmp();
    const viz = make({ dir, helper: STEADY, idleMs: 300 });
    const off = viz.subscribe(() => {}, () => {});
    await until(() => viz.status().state === "running", "ready");
    const pid = pidOf(dir);
    off();
    const again = viz.subscribe(() => {}, () => {});
    await Bun.sleep(400);
    expect(alive(pid)).toBe(true);
    expect(pidOf(dir)).toBe(pid);
    again();
  });

  test("unsubscribing twice is harmless", async () => {
    const viz = make({ dir: tmp(), helper: STEADY });
    const a = viz.subscribe(() => {}, () => {});
    const b = viz.subscribe(() => {}, () => {});
    a();
    a();
    await Bun.sleep(120);
    expect(viz.status().state).not.toBe("idle"); // b is still subscribed
    b();
  });
});

describe("frames", () => {
  test("at most fps frames per second are delivered, and the newest one always wins", async () => {
    const dir = tmp();
    // 60 frames in a burst, the last one being [0,60], then silence.
    const burst = sh("echo ready >&2; i=1; while [ $i -le 60 ]; do echo \"[0,$i]\"; i=$((i+1)); done; exec sleep 30");
    const viz = make({ dir, helper: burst, fps: 5 });
    const frames: number[][] = [];
    const t0 = Date.now();
    viz.subscribe((f) => frames.push(f), () => {});
    await until(() => frames.at(-1)?.[1] === 60, "the newest frame to arrive");
    const elapsed = Date.now() - t0;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.length).toBeLessThanOrEqual(Math.floor(elapsed / 200) + 1);
    expect(frames.length).toBeLessThan(10);
  });

  test("malformed lines are ignored", async () => {
    const dir = tmp();
    const noisy = sh(
      "echo ready >&2; echo 'garbage'; echo '[1,'; echo '{\"a\":1}'; echo '[\"x\"]'; echo '[]'; echo '[null]'; echo ''; echo '[0.5,0.25]'; exec sleep 30",
    );
    const viz = make({ dir, helper: noisy });
    const frames: number[][] = [];
    viz.subscribe((f) => frames.push(f), () => {});
    await until(() => frames.length >= 1, "a frame");
    expect(frames).toEqual([[0.5, 0.25]]);
  });
});

describe("status from stderr", () => {
  test("ready, silent, audio and error lines map to states", async () => {
    const dir = tmp();
    const talky = sh("echo ready >&2; echo silent >&2; echo audio >&2; echo 'error: boom' >&2; exec sleep 30");
    const viz = make({ dir, helper: talky });
    const seen: VizStatus[] = [];
    viz.subscribe(() => {}, (s) => seen.push(s));
    await until(() => viz.status().state === "error", "error status");
    expect(seen).toEqual([{ state: "running" }, { state: "silent" }, { state: "running" }, { state: "error", error: "boom" }]);
    expect(viz.status()).toEqual({ state: "error", error: "boom" });
  });
});

describe("restarts", () => {
  test("a helper that dies is restarted and recovers", async () => {
    const dir = tmp();
    const flaky = sh(`echo x >> ${dir}/runs; [ $(wc -l < ${dir}/runs) -ge 2 ] || exit 1; echo ready >&2; exec sleep 30`);
    const viz = make({ dir, helper: flaky });
    viz.subscribe(() => {}, () => {});
    await until(() => viz.status().state === "running", "helper to come back");
    expect(readFileSync(`${dir}/runs`, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("five quick failures in a row end in an error and no more restarts", async () => {
    const dir = tmp();
    const dying = sh(`echo x >> ${dir}/runs; exit 1`);
    const viz = make({ dir, helper: dying });
    viz.subscribe(() => {}, () => {});
    await until(() => viz.status().state === "error", "error status");
    expect(viz.status().error).toContain("keeps exiting");
    const runs = () => readFileSync(`${dir}/runs`, "utf8").trim().split("\n").length;
    expect(runs()).toBe(5);
    await Bun.sleep(150); // several retry periods: still no new run
    expect(runs()).toBe(5);
  });

  test("the helper's own error line is kept when it gives up", async () => {
    const dir = tmp();
    const viz = make({ dir, helper: sh("echo 'error: no tap' >&2; exit 2") });
    viz.subscribe(() => {}, () => {});
    await until(() => viz.status().state === "error" && viz.status().error === "no tap", "helper error");
    await Bun.sleep(150);
    expect(viz.status()).toEqual({ state: "error", error: "no tap" });
  });
});

describe("compiling", () => {
  test("a compile failure is an error status with the compiler message and an install hint", async () => {
    const dir = tmp();
    writeFileSync(`${dir}/broken.swift`, "this is not swift {{{\n");
    const viz = make({ dir, source: `${dir}/broken.swift` });
    viz.subscribe(() => {}, () => {});
    await until(() => viz.status().state === "error", "build error", 60_000);
    const msg = viz.status().error ?? "";
    expect(msg).toContain("xcode-select --install");
    expect(msg.length).toBeLessThan(500);
    expect(existsSync(`${dir}/sysaudio`)).toBe(false);
    expect(existsSync(`${dir}/viz.pid`)).toBe(false);
  }, 70_000);

  test("a missing source file is reported the same way", async () => {
    const dir = tmp();
    const viz = make({ dir, source: `${dir}/nope.swift` });
    viz.subscribe(() => {}, () => {});
    await until(() => viz.status().state === "error", "build error");
    expect(viz.status().error).toContain("xcode-select --install");
  });
});

describe("orphans", () => {
  test("a helper left behind by a killed server is stopped at the next start", async () => {
    const dir = tmp();
    // "sleep 30; true" keeps sh from exec'ing, so the command line still contains the marker.
    const orphan = Bun.spawn(["/bin/sh", "-c", "sleep 30; true", "sysaudio-orphan"], { detached: true });
    await Bun.write(`${dir}/viz.pid`, String(orphan.pid));
    expect(alive(orphan.pid)).toBe(true);
    make({ dir, helper: STEADY });
    await until(() => !alive(orphan.pid), "orphan to be stopped");
    expect(existsSync(`${dir}/viz.pid`)).toBe(false);
  });

  test("a stale pid that now belongs to something else is left alone", async () => {
    const dir = tmp();
    const other = Bun.spawn(["sleep", "30"], { detached: true });
    await Bun.write(`${dir}/viz.pid`, String(other.pid));
    make({ dir, helper: STEADY });
    await Bun.sleep(100);
    expect(alive(other.pid)).toBe(true);
    process.kill(other.pid, "SIGKILL");
  });
});

describe("sseResponse", () => {
  test("streams status and frames, and unsubscribes when the request is aborted", async () => {
    const dir = tmp();
    const viz = make({ dir, helper: STEADY });
    const ac = new AbortController();
    const res = sseResponse(viz, ac.signal);
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
    await pump; // the stream ends
    await until(() => !alive(pid), "helper to stop once the only viewer is gone");
  });

  test("an already aborted request never subscribes", async () => {
    const dir = tmp();
    const viz = make({ dir, helper: STEADY });
    const ac = new AbortController();
    ac.abort();
    const res = sseResponse(viz, ac.signal);
    const { done } = await res.body!.getReader().read();
    expect(done).toBe(true);
    expect(viz.status().state).toBe("idle");
  });
});

// The real helper, in --test-tone mode only: real capture would pop a macOS permission dialog.
const HAS_SWIFTC = existsSync("/usr/bin/swiftc");
describe("real helper (--test-tone)", () => {
  test.skipIf(!HAS_SWIFTC)("compiles, and its spectrum lines come through the module", async () => {
    const dir = tmp();
    const build = Bun.spawn(["/usr/bin/swiftc", "-O", `${import.meta.dir}/../tools/sysaudio.swift`, "-o", `${dir}/sysaudio`], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);

    const viz = make({ dir, helper: [`${dir}/sysaudio`, "--test-tone", "--bands", "16", "--fps", "20"], fps: 20 });
    const frames: number[][] = [];
    viz.subscribe((f) => frames.push(f), () => {});
    await until(() => frames.length >= 5, "five frames", 5000);
    expect(viz.status().state).toBe("running");
    for (const f of frames) {
      expect(f).toHaveLength(16);
      expect(f.every((x) => x >= 0 && x <= 1)).toBe(true);
    }
    const pid = pidOf(dir);
    viz.stop();
    await until(() => !alive(pid), "helper to exit on SIGTERM");
  }, 120_000);
});
