import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { ConfigError } from "../lib/config.ts";
import { createRadio, radioCommand, type Radio, type RadioOptions } from "../lib/radio.ts";
import { favId, favUuid, isStation, stationUrl } from "../lib/stations.ts";

// These tests run real child processes (a fake player that sleeps), so they wait for a *condition*
// (polling `until`) instead of a guessed duration. Fake timers cannot observe an OS process.
const SLEEPER = ["/bin/sh", "-c", "exec sleep 30", "sh"]; // the stream URL arrives as an ignored extra argument
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (dir: string) => Number(readFileSync(`${dir}/radio.pid`, "utf8").split("\n")[0]); // line 1: pid, line 2: stream URL
async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}
const radios: Radio[] = [];
afterEach(() => { for (const r of radios.splice(0)) r.stop(); });
const make = (dir: string, opts: RadioOptions = {}) => {
  const r = createRadio(dir, { player: SLEEPER, readyMs: 30, ...opts });
  radios.push(r);
  return r;
};
const tmp = () => mkdtempSync("/tmp/radio-");

describe("radio commands", () => {
  test("only whitelisted stations and known outputs pass", () => {
    expect(radioCommand({ station: "darksynth", output: "tablet", toggle: true })).toEqual({ station: "darksynth", output: "tablet", toggle: true });
    for (const bad of [{ station: "x" }, { station: "../etc/passwd" }, { station: "nightride; rm -rf ~" }, { station: 5 }, { output: "speaker" }, { toggle: false }, [], null, "nightride"]) {
      expect(() => radioCommand(bad)).toThrow(ConfigError);
    }
    expect(radioCommand({})).toEqual({});
  });
});

describe("Mac player", () => {
  test("toggle starts and stops a real process; status goes loading, then playing", async () => {
    const dir = tmp();
    const r = make(dir);
    r.toggle();
    expect(r.get().status).toBe("loading");
    const pid = pidOf(dir);
    expect(alive(pid)).toBe(true);
    await until(() => r.get().status === "playing", "playing");
    r.toggle();
    expect(r.get().status).toBe("idle");
    await until(() => !alive(pid), "player to exit");
  });
  test("changing station restarts the player; the choice survives a restart of the server", async () => {
    const dir = tmp();
    const r = make(dir);
    r.toggle();
    const first = pidOf(dir);
    r.setStation("chillsynth");
    await until(() => !alive(first), "old player to exit");
    expect(alive(pidOf(dir))).toBe(true);
    expect(r.get().station).toBe("chillsynth");
    r.stop();
    expect(make(dir).get()).toMatchObject({ station: "chillsynth", output: "mac", status: "idle" });
  });
  test("switching the output to the tablet stops the Mac player and ignores toggles", async () => {
    const dir = tmp();
    const r = make(dir);
    r.toggle();
    const pid = pidOf(dir);
    r.setOutput("tablet");
    await until(() => !alive(pid), "player to exit");
    r.toggle(); // the tablet plays by itself; the server must not start anything
    expect(r.get().status).toBe("idle");
    expect(() => pidOf(dir)).toThrow();
  });
  test("a player that keeps dying ends in an error instead of looping forever", async () => {
    const r = make(tmp(), { player: ["/usr/bin/false"], retryMs: 2 });
    r.toggle();
    await until(() => r.get().status === "error", "error state");
    expect(r.get().error).toMatch(/keeps exiting/);
  });
  test("no player installed gives an actionable error", () => {
    const r = make(tmp(), { player: null });
    r.toggle();
    expect(r.get().status).toBe("error");
    expect(r.get().error).toMatch(/mpv/);
  });
  test("a player left behind by a killed server is stopped at the next start", async () => {
    const dir = tmp();
    const orphan = Bun.spawn(["/bin/sh", "-c", "exec sleep 30", "nightride.fm"], { detached: true });
    await Bun.write(`${dir}/radio.pid`, String(orphan.pid));
    expect(alive(orphan.pid)).toBe(true);
    make(dir);
    await until(() => !alive(orphan.pid), "orphan to be stopped");
  });
});

describe("station tiles", () => {
  test("the whitelist includes Virgin Radio and rejects anything else", async () => {

    expect(isStation("virgin")).toBe(true);
    expect(stationUrl("virgin")).toBe("https://icecast.unitedradio.it/Virgin.aac");
    expect(stationUrl("darksynth")).toBe("https://stream.nightride.fm/darksynth.mp3");
    for (const bad of ["Virgin", "virgin ", "http://evil", "", 0, null, undefined]) expect(isStation(bad)).toBe(false);
    expect(radioCommand({ tune: "virgin" })).toEqual({ tune: "virgin" });
    expect(() => radioCommand({ tune: "evil" })).toThrow(ConfigError);
  });
  test("tune plays a station, stops it on the second tap, and switches between stations", async () => {
    const dir = tmp();
    const r = make(dir);
    r.tune("virgin");
    expect(r.get()).toMatchObject({ station: "virgin", status: "loading" });
    const first = pidOf(dir);
    r.tune("virgin"); // same station again: stop
    expect(r.get().status).toBe("idle");
    await until(() => !alive(first), "player to exit");
    r.tune("virgin");
    const second = pidOf(dir);
    r.tune("darksynth"); // other station while playing: switch, keep playing
    await until(() => !alive(second), "old player to exit");
    expect(r.get()).toMatchObject({ station: "darksynth", status: "loading" });
    expect(alive(pidOf(dir))).toBe(true);
  });
  test("with the tablet as output, tune only remembers the station", () => {
    const dir = tmp();
    const r = make(dir);
    r.setOutput("tablet");
    r.tune("virgin");
    expect(r.get()).toMatchObject({ station: "virgin", output: "tablet", status: "idle" });
    expect(() => pidOf(dir)).toThrow();
  });
});

describe("radio-browser favourites", () => {
  const UUID = "960cf833-0601-11e8-ae97-52543be04c81";
  const FAV = favId(UUID);
  const urlOf = (dir: string) => readFileSync(`${dir}/radio.pid`, "utf8").split("\n")[1];

  test("favourite ids are well formed or rejected; the server decides which are saved", () => {
    expect(favUuid(FAV)).toBe(UUID);
    for (const bad of ["rb:", "rb:../../etc", `rb:${UUID.toUpperCase()}`, `rb:${UUID} `, UUID, "rb:virgin", 7, null]) expect(favUuid(bad)).toBeNull();
    expect(radioCommand({ tune: FAV })).toEqual({ tune: FAV });
    expect(() => radioCommand({ tune: "rb:nope" })).toThrow(ConfigError);
    // a stricter predicate (the saved favourites) turns a well-formed id into an unknown station
    expect(() => radioCommand({ station: FAV }, isStation)).toThrow(ConfigError);
  });
  test("a favourite is resolved when played and the URL it gets is what the player opens", async () => {
    const dir = tmp();
    const asked: string[] = [];
    const r = make(dir, { resolve: async (u) => (asked.push(u), "https://radio.example/stream.mp3") });
    r.tune(FAV);
    expect(r.get()).toMatchObject({ station: FAV, status: "loading" });
    await until(() => { try { return urlOf(dir) === "https://radio.example/stream.mp3"; } catch { return false; } }, "player to start");
    expect(asked).toEqual([UUID]);
    r.tune(FAV); // second tap stops
    expect(r.get().status).toBe("idle");
  });
  test("a directory failure becomes a visible error, and a stop while resolving never starts a player", async () => {
    const failing = make(tmp(), { resolve: () => Promise.reject(new Error("Radio directory is unreachable")) });
    failing.tune(FAV);
    await until(() => failing.get().status === "error", "error status");
    expect(failing.get().error).toBe("Radio directory is unreachable");

    const dir = tmp();
    let release: (u: string) => void = () => {};
    const slow = make(dir, { resolve: () => new Promise<string>((ok) => { release = ok; }) });
    slow.tune(FAV);
    slow.stop();
    release("https://radio.example/late.mp3");
    for (let i = 0; i < 10; i++) await Promise.resolve(); // let the late answer's callbacks run
    expect(() => readFileSync(`${dir}/radio.pid`, "utf8")).toThrow();
  });
  test("an orphaned favourite player is recognised by its stream URL and stopped", async () => {
    const dir = tmp();
    const url = "https://radio.example/orphan.mp3";
    const orphan = Bun.spawn(["/bin/sh", "-c", "exec sleep 30", url], { detached: true });
    await Bun.write(`${dir}/radio.pid`, `${orphan.pid}\n${url}`);
    make(dir);
    await until(() => !alive(orphan.pid), "orphan to be stopped");
  });
});
