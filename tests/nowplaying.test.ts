import { describe, expect, test } from "bun:test";
import { createNowPlaying, parseStreamTitle, readIcy, type FetchLike } from "../lib/nowplaying.ts";

const block = (text: string) => {
  const body = Buffer.from(text, "utf8");
  const len = Math.ceil(body.length / 16);
  return Buffer.concat([Buffer.from([len]), body, Buffer.alloc(len * 16 - body.length)]);
};
// A fake stream: `every` audio bytes, a metadata block, more audio.
const stream = (every: number, meta: string): FetchLike => async () =>
  new Response(Buffer.concat([Buffer.alloc(every, 1), block(meta), Buffer.alloc(every, 2)]), { headers: { "icy-metaint": String(every) } });

describe("parseStreamTitle", () => {
  test("Virgin's tilde format", () => {
    expect(parseStreamTitle("StreamTitle='EDITORS~SERIOUSLY~SURFACE, ECHO & SOUND~2026~~233~2026-11-05T09:12:47~x~Virgin Radio';")).toEqual({ artist: "EDITORS", title: "SERIOUSLY" });
  });
  test("Artist - Title, bare title, apostrophes, and nothing", () => {
    expect(parseStreamTitle("StreamTitle='Daft Punk - One More Time';")).toEqual({ artist: "Daft Punk", title: "One More Time" });
    expect(parseStreamTitle("StreamTitle='Just a title';")).toEqual({ artist: "", title: "Just a title" });
    expect(parseStreamTitle("StreamTitle='Guns N' Roses - It's So Easy';StreamUrl='';")).toEqual({ artist: "Guns N' Roses", title: "It's So Easy" });
    expect(parseStreamTitle("StreamTitle='';")).toBeNull();
    expect(parseStreamTitle("garbage")).toBeNull();
  });
  test("strips markup and control characters and caps the length", () => {
    const r = parseStreamTitle(`StreamTitle='<b>A</b>\u0001~${"x".repeat(300)}';`)!;
    expect(r.artist).toBe("b A /b");
    expect(r.artist).not.toMatch(/[<>\u0001]/);
    expect(r.title.length).toBe(100);
  });
});

describe("readIcy", () => {
  test("reads the title past the audio bytes", async () => {
    expect(await readIcy("http://x/", stream(2048, "StreamTitle='A~B~C';"))).toEqual({ artist: "A", title: "B" });
  });
  test("null without icy-metaint, on errors and on an empty block", async () => {
    expect(await readIcy("http://x/", async () => new Response("audio"))).toBeNull();
    expect(await readIcy("http://x/", async () => { throw new Error("down"); })).toBeNull();
    expect(await readIcy("http://x/", async () => new Response("x", { status: 500, headers: { "icy-metaint": "4" } }))).toBeNull();
    expect(await readIcy("http://x/", stream(64, "StreamTitle='';"))).toBeNull();
  });
});

describe("createNowPlaying", () => {
  test("caches per URL for the ttl and shares one request", async () => {
    let calls = 0;
    let t = 0;
    const f: FetchLike = async (u, i) => (calls++, stream(64, "StreamTitle='A~B';")(u, i));
    const np = createNowPlaying({ fetchImpl: f, ttlMs: 1000, now: () => t });
    const [a, b] = await Promise.all([np.get("u1"), np.get("u1")]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await np.get("u1");
    expect(calls).toBe(1);
    t = 1500;
    await np.get("u1");
    expect(calls).toBe(2);
    await np.get("u2");
    expect(calls).toBe(3);
  });
});
