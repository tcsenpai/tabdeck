import { describe, expect, test } from "bun:test";
import { ConfigError } from "../lib/config.ts";
import {
  createRadioBrowser,
  isRbUuid,
  resolveStream,
  safeUrl,
  searchStations,
  stationByUuid,
  USER_AGENT,
  type FetchLike,
  type RbDeps,
  type RbStation,
} from "../lib/radiobrowser.ts";

// No test touches the network: every client gets an injected fetch. Timing tests use generous
// deadlines and wait for the promise itself, never for a guessed sleep.

// Real records from https://de1.api.radio-browser.info (2026-11-04), trimmed to the fields that matter:
// two from /json/stations/search, three from /json/stations/byuuid/<uuid> (MP3 behind a .pls, plain
// AAC, an HLS playlist).
const REAL = [
  { changeuuid: "36b89f53-0d32-4932-a0cc-717f7a4c16f9", stationuuid: "9067dc39-4bf4-4364-bd6b-8020cff3e15d", name: "Nightride FM - Chillsynth", url: "https://stream.nightride.fm/chillsynth.mp3", url_resolved: "https://stream.nightride.fm/chillsynth.mp3", homepage: "https://nightride.fm/", favicon: "https://nightride.fm/thumbnail.png", tags: "chillsynth,chillwave,instrumental", country: "Germany", countrycode: "DE", votes: 1685, codec: "MP3", bitrate: 320, hls: 0, lastcheckok: 1, clickcount: 33 },
  { changeuuid: "69f52a47-87bd-4ff6-b1dc-2ac2ba8b3a08", stationuuid: "edccbfd1-9f20-4f96-adee-b00c6b65dd3c", name: "Nightride FM - Darksynth", url: "https://stream.nightride.fm/darksynth.mp3", url_resolved: "https://stream.nightride.fm/darksynth.mp3", homepage: "https://nightride.fm/", favicon: "https://nightride.fm/thumbnail.png", tags: "cyberpunk,darksynth,horror", country: "Germany", countrycode: "DE", votes: 1007, codec: "MP3", bitrate: 320, hls: 0, lastcheckok: 1, clickcount: 30 },
  { changeuuid: "467558b2-8943-4511-a5d8-ddf75fb1c87a", stationuuid: "960cf833-0601-11e8-ae97-52543be04c81", name: "SomaFM Groove Salad (128k MP3)", url: "https://somafm.com/groovesalad.pls", url_resolved: "https://ice2.somafm.com/groovesalad-128-mp3", homepage: "https://somafm.com/groovesalad/", favicon: "https://somafm.com/img3/groovesalad-400.jpg", tags: "ambient,chillout,downtempo,groove,lounge,sleep", country: "The United States Of America", countrycode: "US", votes: 47767, codec: "MP3", bitrate: 128, hls: 0, lastcheckok: 1, clickcount: 169 },
  { changeuuid: "df7cbbe2-289f-451f-9281-e99f2e990cb7", stationuuid: "dfcef843-6bf9-40f6-b3fe-2b224df86e48", name: "Europe 1", url: "https://stream.europe1.fr/europe1.aac", url_resolved: "https://stream.europe1.fr/europe1.aac", homepage: "https://www.europe1.fr/", favicon: "https://www.europe1.fr/build/e1/images/favicon-120x120.png", tags: "aac,news,talk", country: "France", countrycode: "FR", votes: 21874, codec: "AAC", bitrate: 128, hls: 0, lastcheckok: 1, clickcount: 849 },
  { changeuuid: "c50b498d-16b3-46ca-89d2-b5011519550a", stationuuid: "3606ef8c-cd58-4440-8c47-dbf1e0cacdac", name: "BBC Radio 2 (128k)", url: "http://as-hls-ww-live.akamaized.net/pool_74208725/live/ww/bbc_radio_two/bbc_radio_two.isml/bbc_radio_two-audio%3d128000.norewind.m3u8", url_resolved: "http://as-hls-ww-live.akamaized.net/pool_74208725/live/ww/bbc_radio_two/bbc_radio_two.isml/bbc_radio_two-audio%3d128000.norewind.m3u8", homepage: "https://www.bbc.co.uk/radio2", favicon: "https://cdn-radiotime-logos.tunein.com/s24940q.png", tags: "adult contemporary", country: "The United Kingdom Of Great Britain And Northern Ireland", countrycode: "GB", votes: 3726, codec: "UNKNOWN", bitrate: 0, hls: 1, lastcheckok: 1, clickcount: 165 },
];
const [CHILL, DARK, SOMA, EUROPE1, BBC2] = REAL as [Rec, Rec, Rec, Rec, Rec];
type Rec = (typeof REAL)[number];
// Real /json/url/<uuid> answer (it also counts a click).
const CLICK_SOMA = { ok: true, message: "retrieved station url", stationuuid: SOMA.stationuuid, name: SOMA.name, url: "https://ice2.somafm.com/groovesalad-128-mp3" };

const U1 = "9067dc39-4bf4-4364-bd6b-8020cff3e15d";
const MIRRORS = ["de1.api.radio-browser.info", "de2.api.radio-browser.info", "all.api.radio-browser.info"];

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  url: URL;
  init: RequestInit | undefined;
}
// A fake fetch that records every call and answers through `handler`.
function fake(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call = { url: new URL(input), init };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, fetchImpl };
}
// Never answers; rejects with the abort reason when the signal fires (what real fetch does).
const hang: FetchLike = (_input, init) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  const signal = init?.signal;
  if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  return promise;
};
const make = (fetchImpl: FetchLike, deps: RbDeps = {}) => createRadioBrowser({ fetchImpl, minIntervalMs: 0, ...deps });
async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}

describe("isRbUuid", () => {
  test("accepts the canonical lowercase form only", () => {
    for (const u of [U1, SOMA.stationuuid, "00000000-0000-4000-8000-000000000000"]) expect(isRbUuid(u)).toBe(true);
  });
  test("rejects everything that could change a request path or is just not a uuid", () => {
    const hostile: unknown[] = [
      "", " ", U1.toUpperCase(), `${U1}\n`, `\n${U1}`, ` ${U1}`, `${U1} `, `${U1}/..`, `../${U1}`, `${U1}?x=1`, `${U1}#x`, `${U1}%2f..`,
      "..%2F..%2Fjson%2Fcountries", `${U1},${U1}`, `{${U1}}`, `urn:uuid:${U1}`, U1.replaceAll("-", ""), U1.slice(0, -1), `${U1}0`,
      U1.replace("9", "٩"), // Arabic-Indic digit
      U1.replace("b", "ｂ"), // fullwidth letter
      U1.replace("-", "\u0000"), "not-a-uuid", "9067dc39-4bf4-4364-bd6b-8020cff3e15g",
      null, undefined, 5, true, {}, [], [U1], { toString: () => U1 }, Symbol("x"),
    ];
    for (const v of hostile) expect(isRbUuid(v)).toBe(false);
  });
});

describe("safeUrl (stream and icon urls from a third-party database)", () => {
  const ok = [
    "https://stream.nightride.fm/chillsynth.mp3",
    "http://as-hls-ww-live.akamaized.net/pool_74208725/live/ww/bbc_radio_two/bbc_radio_two.isml/bbc_radio_two-audio%3d128000.norewind.m3u8",
    "https://antenaone.crossradio.com.br/stream/1;", // real: trailing semicolon (shoutcast)
    "https://carol.epichosts.co.uk:8570/;",
    "http://37.247.98.8/stream/22/;", // real: a public IPv4 literal
    "http://46.20.7.116/",
    "http://29344.live.streamtheworld.com:3690/VIRGIN_RADIO_SC",
    "https://st01.sslstream.dlf.de/dlf/01/high/aac/stream.aac?aggregator=web",
    "http://100.63.255.255/x", // just below carrier-grade NAT
    "http://172.32.0.1/x", // just above 172.16/12
    "http://172.15.255.255/x",
    "http://192.169.0.1/x",
    "https://xn--exmple-cua.com/x",
    "https://example.com./x", // absolute name
    `https://x.example/a.m3u8?${"A".repeat(600)}`, // real signed HLS urls are this long
  ];
  test("plain public http(s) urls pass, normalised", () => {
    for (const u of ok) expect(safeUrl(u, 1024)).toBe(new URL(u).href);
    expect(safeUrl("https://exämple.com/x", 1024)).toBe("https://xn--exmple-cua.com/x");
  });

  const rejected: Record<string, string[]> = {
    "other schemes": [
      "file:///etc/passwd", "data:audio/mp3;base64,AAAA", "javascript:alert(1)", "ftp://example.com/a.mp3", "rtmp://example.com/live", "mms://example.com/live",
      "blob:https://example.com/x", "about:blank", "gopher://example.com/", "ws://example.com/", "HTTP://[::1]/", "//example.com/a", "example.com/a", "/etc/passwd", "stream.mp3",
    ],
    credentials: ["https://user:pass@example.com/x", "http://user@example.com/x", "http://:pw@example.com/x", "https://example.com@127.0.0.1/", "https://127.0.0.1@example.com/"],
    "localhost and intranet names": [
      "http://localhost/x", "http://LOCALHOST:8080/x", "http://localhost./x", "http://a.localhost/x", "http://printer/x", "http://nas.local/x", "http://router.lan/x",
      "http://host.internal/x", "http://x.home.arpa/x", "http://x.intranet/x", "http://x.corp/x", "http://x.localdomain/x", "http://metadata/x",
    ],
    "loopback, private, link-local, reserved IPv4": [
      "http://127.0.0.1/", "http://127.1.2.3:3000/", "http://0.0.0.0/", "http://10.0.0.1/", "http://10.255.255.255/", "http://172.16.0.1/", "http://172.31.255.255/",
      "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://100.127.255.255/", "http://224.0.0.1/", "http://239.255.255.250/",
      "http://240.0.0.1/", "http://255.255.255.255/", "http://192.0.2.1/", "http://198.18.0.1/", "http://198.51.100.7/", "http://203.0.113.9/", "http://192.0.0.8/",
    ],
    "IPv4 written in tricky ways (the URL parser turns them into a dotted quad)": [
      "http://2130706433/", "http://0x7f000001/", "http://0x7f.0.0.1/", "http://0x7f.1/", "http://017700000001/", "http://0177.0.0.1/", "http://127.1/", "http://127.0.1/",
      "http://0/", "http://0.0/", "http://3232235777/", "http://0xc0a80101/", "http://2852039166/", "http://%31%32%37.0.0.1/", "http://127。0。0。1/", "http://①②⑦.0.0.1/",
      "http://167772161/", "http://0xA.0.0.1/", "http://012.0.0.1/",
    ],
    "IPv6 literals": [
      "http://[::1]/", "http://[::]/", "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:10.0.0.1]/", "http://[fe80::1]/", "http://[fd00::1]/",
      "http://[fc00::1]/", "http://[2001:db8::1]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[2606:4700:4700::1111]/", "https://[::1]:8443/x",
    ],
    "malformed or smuggling": [
      "", " ", "http://", "http:///x", "http://exa mple.com/", "http://example.com/a b", "http://example.com/\n", "http://example.com/\u0000", "http://example.com/\t",
      "http://example.com\\@127.0.0.1/", "http://example.com/<script>", 'http://example.com/"x', "http://1.2.3.4.5/", "http://exa%00mple.com/", " http://example.com/", "http://example.com/ ",
    ],
  };
  for (const [what, urls] of Object.entries(rejected)) {
    test(`rejects ${what}`, () => {
      for (const u of urls) expect(safeUrl(u, 1024)).toBeNull();
    });
  }
  test("rejects non-strings and urls over the cap", () => {
    for (const v of [null, undefined, 5, {}, [], ["https://example.com/"], { toString: () => "https://example.com/" }]) expect(safeUrl(v, 1024)).toBeNull();
    expect(safeUrl(`https://example.com/${"a".repeat(1100)}`, 1024)).toBeNull();
    expect(safeUrl("https://example.com/12345678", 20)).toBeNull();
    expect(safeUrl("https://example.com/", 20)).toBe("https://example.com/");
  });
});

describe("parsing real responses", () => {
  test("search maps the fields and asks the directory the documented way", async () => {
    const f = fake(() => reply([CHILL, DARK]));
    const out = await make(f.fetchImpl).searchStations("nightride", { limit: 3 });
    expect(out).toEqual<RbStation[]>([
      { uuid: CHILL.stationuuid, name: "Nightride FM - Chillsynth", country: "Germany", codec: "MP3", bitrate: 320, tags: "chillsynth,chillwave,instrumental", favicon: "https://nightride.fm/thumbnail.png" },
      { uuid: DARK.stationuuid, name: "Nightride FM - Darksynth", country: "Germany", codec: "MP3", bitrate: 320, tags: "cyberpunk,darksynth,horror", favicon: "https://nightride.fm/thumbnail.png" },
    ]);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0] as Call;
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(MIRRORS[0]);
    expect(url.pathname).toBe("/json/stations/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "nightride", limit: "3", hidebroken: "true", order: "clickcount", reverse: "true" });
    expect(init?.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("USER_AGENT is the polite one from the brief", () => {
    expect(USER_AGENT).toBe("TabDeck/0.1 (+https://github.com/tcsenpai/tabdeck)");
  });

  test("stationByUuid: the uuid goes into the path; an unknown station (empty list) gives null", async () => {
    const f = fake((_c, n) => reply(n === 1 ? [SOMA] : []));
    const rb = make(f.fetchImpl);
    const s = await rb.stationByUuid(SOMA.stationuuid);
    expect(s).toEqual({ uuid: SOMA.stationuuid, name: "SomaFM Groove Salad (128k MP3)", country: "The United States Of America", codec: "MP3", bitrate: 128, tags: SOMA.tags, favicon: SOMA.favicon });
    expect((f.calls[0] as Call).url.pathname).toBe(`/json/stations/byuuid/${SOMA.stationuuid}`);
    expect((f.calls[0] as Call).url.search).toBe("");
    expect(await rb.stationByUuid("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("stationByUuid ignores a record with another uuid", async () => {
    const f = fake(() => reply([CHILL]));
    expect(await make(f.fetchImpl).stationByUuid(SOMA.stationuuid)).toBeNull();
  });

  test("AAC and HLS stations parse; HLS has bitrate 0 and a .m3u8 stream", async () => {
    const f = fake(() => reply([EUROPE1, BBC2]));
    const [a, b] = await make(f.fetchImpl).searchStations("news");
    expect(a).toMatchObject({ name: "Europe 1", codec: "AAC", bitrate: 128 });
    expect(b).toMatchObject({ name: "BBC Radio 2 (128k)", codec: "UNKNOWN", bitrate: 0, country: "The United Kingdom Of Great Britain And Northern Ireland" });
  });

  test("resolveStream: the real /json/url answer gives the direct stream (not the .pls in `url`)", async () => {
    const f = fake(() => reply(CLICK_SOMA));
    expect(await make(f.fetchImpl).resolveStream(SOMA.stationuuid)).toBe("https://ice2.somafm.com/groovesalad-128-mp3");
    expect((f.calls[0] as Call).url.pathname).toBe(`/json/url/${SOMA.stationuuid}`);
  });

  test("resolveStream keeps an HLS playlist url as it is", async () => {
    const f = fake(() => reply({ ok: true, message: "retrieved station url", stationuuid: BBC2.stationuuid, name: BBC2.name, url: BBC2.url_resolved }));
    expect(await make(f.fetchImpl).resolveStream(BBC2.stationuuid)).toBe(BBC2.url_resolved);
  });

  test("the exported functions work with an injected fetch", async () => {
    const f = fake((c) => reply(c.url.pathname.startsWith("/json/url/") ? CLICK_SOMA : [SOMA]));
    expect(await searchStations("groove salad exported", { fetchImpl: f.fetchImpl })).toHaveLength(1);
    // the search filled the details cache, so this needs no second request
    expect((await stationByUuid(SOMA.stationuuid, { fetchImpl: f.fetchImpl }))?.name).toBe(SOMA.name);
    expect(f.calls).toHaveLength(1);
  });
});

describe("sanitising", () => {
  const good = { stationuuid: U1, name: "Fine", url_resolved: "https://stream.example.com/a", country: "X", codec: "MP3", bitrate: 128, tags: "a", favicon: "" };
  test("strings are cleaned and capped, bad records are dropped", async () => {
    const f = fake(() =>
      reply([
        { ...good, name: "  <b>Evil</b>\u0000\u0007 radio\n\t\u202e name ", country: 5, codec: "M<P>3", bitrate: "320", tags: "a".repeat(500), favicon: "javascript:alert(1)" },
        { ...good, stationuuid: "ABC" },
        { ...good, stationuuid: U1.toUpperCase() },
        { ...good, url_resolved: "file:///etc/passwd" },
        { ...good, url_resolved: "http://127.0.0.1:8080/x" },
        { ...good, url_resolved: undefined },
        { ...good, name: "<>" },
        { ...good, name: 42 },
        null, 5, "x", [], [good],
        { ...good, stationuuid: SOMA.stationuuid, name: "🎵".repeat(200), bitrate: -5, favicon: `https://example.com/${"i".repeat(400)}` },
        { ...good, stationuuid: DARK.stationuuid, bitrate: 1e12 },
        { ...good, stationuuid: BBC2.stationuuid, bitrate: Number.NaN, favicon: "http://user:pw@example.com/i.png" },
      ]),
    );
    const out = await make(f.fetchImpl).searchStations("evil");
    expect(out.map((s) => s.uuid)).toEqual([U1, SOMA.stationuuid, DARK.stationuuid, BBC2.stationuuid]);
    expect(out[0]).toEqual({ uuid: U1, name: "bEvil/b radio name", country: "", codec: "MP3", bitrate: 0, tags: "a".repeat(100), favicon: "" });
    const emoji = out[1] as RbStation;
    expect(Array.from(emoji.name)).toHaveLength(100);
    expect(emoji.name.isWellFormed()).toBe(true);
    expect(emoji.bitrate).toBe(0);
    expect(emoji.favicon).toBe("");
    expect(out[2]?.bitrate).toBe(9999);
    expect(out[3]).toMatchObject({ bitrate: 0 });
    for (const s of out) for (const v of [s.name, s.country, s.codec, s.tags, s.favicon]) expect(v).not.toMatch(/[\p{Cc}<>]/u);
  });

  test("a bitrate recorded in bit/s (real: Soma FM HLS, 320000) is shown in kbit/s", async () => {
    const f = fake(() => reply([{ ...good, stationuuid: "608bc971-3ec5-4c05-8143-de96c3bdb030", name: "Soma FM Groove Salad 320K AAC HLS", codec: "MP4", bitrate: 320000, url_resolved: "https://hls.somafm.com/hls/groovesalad/320k/program.m3u8" }, { ...good, bitrate: 9999.4 }]));
    const out = await make(f.fetchImpl).searchStations("bps");
    expect(out.map((s) => s.bitrate)).toEqual([320, 9999]);
  });
});

describe("input validation", () => {
  test("queries are trimmed and bounded; filters are optional", async () => {
    const f = fake(() => reply([]));
    const rb = make(f.fetchImpl);
    await rb.searchStations("  jazz  ");
    expect((f.calls[0] as Call).url.searchParams.get("name")).toBe("jazz");
    await rb.searchStations("x".repeat(60));
    await expect(rb.searchStations("x".repeat(61))).rejects.toBeInstanceOf(ConfigError);
    await expect(rb.searchStations(`  ${"x".repeat(60)}  `)).resolves.toEqual([]); // the limit applies to the trimmed text
    for (const bad of ["", "   ", "a\nb", "a\u0000b", "a\tb", 5, null, undefined, {}, ["jazz"]]) {
      await expect(rb.searchStations(bad as string)).rejects.toBeInstanceOf(ConfigError);
    }
    expect(f.calls).toHaveLength(2); // nothing invalid reached the network
  });

  test("a name-less search needs a tag or a country; both are validated", async () => {
    const f = fake(() => reply([]));
    const rb = make(f.fetchImpl);
    await rb.searchStations("", { tag: "jazz" });
    expect(Object.fromEntries((f.calls[0] as Call).url.searchParams)).toMatchObject({ tag: "jazz" });
    expect((f.calls[0] as Call).url.searchParams.has("name")).toBe(false);
    await rb.searchStations("", { country: "de" });
    expect((f.calls[1] as Call).url.searchParams.get("countrycode")).toBe("DE");
    expect((f.calls[1] as Call).url.searchParams.has("country")).toBe(false);
    await rb.searchStations("radio", { country: "New Zealand", tag: "rock & roll" });
    const p = (f.calls[2] as Call).url.searchParams;
    expect([p.get("country"), p.get("tag"), p.has("countrycode")]).toEqual(["New Zealand", "rock & roll", false]);
    expect((f.calls[2] as Call).url.search).toContain("tag=rock+%26+roll"); // encoded, cannot add parameters
    await expect(rb.searchStations("", { tag: "" })).rejects.toBeInstanceOf(ConfigError);
    await expect(rb.searchStations("a", { tag: "t".repeat(41) })).rejects.toBeInstanceOf(ConfigError);
    await expect(rb.searchStations("a", { country: "c\nd" })).rejects.toBeInstanceOf(ConfigError);
    await expect(rb.searchStations("a", { tag: 5 as unknown as string })).rejects.toBeInstanceOf(ConfigError);
    expect(f.calls).toHaveLength(3);
  });

  test("limit is clamped to 1..30 and defaults to 20", async () => {
    const f = fake(() => reply([]));
    const rb = make(f.fetchImpl);
    const limits: Array<number | undefined> = [undefined, 0, -4, 1, 5.9, 30, 31, 1000, Infinity, -Infinity];
    for (const [i, limit] of limits.entries()) await rb.searchStations(`limit ${i}`, { limit });
    expect(f.calls.map((c) => c.url.searchParams.get("limit"))).toEqual(["20", "1", "1", "1", "5", "30", "30", "30", "30", "1"]);
    await expect(rb.searchStations("nan", { limit: Number.NaN })).rejects.toBeInstanceOf(ConfigError);
    await expect(rb.searchStations("str", { limit: "5" as unknown as number })).rejects.toBeInstanceOf(ConfigError);
  });

  test("a bad uuid never reaches the network", async () => {
    const f = fake(() => reply([]));
    const rb = make(f.fetchImpl);
    for (const bad of [U1.toUpperCase(), `${U1}/../x`, "", null, 5]) {
      await expect(rb.stationByUuid(bad as string)).rejects.toBeInstanceOf(ConfigError);
      await expect(rb.resolveStream(bad as string)).rejects.toBeInstanceOf(ConfigError);
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("resolved stream validation", () => {
  const answer = (url: unknown, extra: Record<string, unknown> = {}) => reply({ ok: true, message: "retrieved station url", stationuuid: U1, name: "x", url, ...extra });
  const resolve = (url: unknown) => make(fake(() => answer(url)).fetchImpl).resolveStream(U1);

  test("anything but a public http(s) url is refused, with a plain error (not a bad-input one)", async () => {
    const bad = [
      "file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)", "ftp://example.com/a", "http://127.0.0.1:8080/admin", "http://localhost/x", "http://[::1]/",
      "http://2130706433/", "http://0x7f.1/", "http://192.168.0.1/", "http://169.254.169.254/", "https://user:pw@example.com/", "http://nas/x", "", "x", 5, null, {}, `https://example.com/${"a".repeat(1100)}`,
    ];
    for (const url of bad) {
      const err = await resolve(url).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ConfigError);
      // a wrong shape (url not a string) is reported as an unreachable directory, a refused url as not playable
      expect((err as Error).message).toBe(typeof url === "string" ? "Station stream is not playable" : "Radio directory is unreachable");
    }
  });

  test("the answer must be about the station that was asked for", async () => {
    const f = fake(() => answer("https://example.com/s", { stationuuid: DARK.stationuuid }));
    await expect(make(f.fetchImpl).resolveStream(U1)).rejects.toThrow("Radio directory is unreachable");
    expect(f.calls).toHaveLength(MIRRORS.length); // each mirror was tried
  });

  test('ok:"true" (as written in the docs) is accepted; ok:false and 404 mean an unknown station', async () => {
    expect(await make(fake(() => answer("https://example.com/s", { ok: "true" })).fetchImpl).resolveStream(U1)).toBe("https://example.com/s");
    const f1 = fake(() => reply({ ok: false, message: "url could not be retrieved" }));
    await expect(make(f1.fetchImpl).resolveStream(U1)).rejects.toBeInstanceOf(ConfigError);
    const f2 = fake(() => new Response("", { status: 404 }));
    await expect(make(f2.fetchImpl).resolveStream(U1)).rejects.toBeInstanceOf(ConfigError);
    expect(f1.calls.length + f2.calls.length).toBe(2); // final answers: no walk over the other mirrors
  });

  test("every resolve is a request (it counts a click); it is never cached", async () => {
    const f = fake(() => reply(CLICK_SOMA));
    const rb = make(f.fetchImpl);
    await rb.resolveStream(SOMA.stationuuid);
    await rb.resolveStream(SOMA.stationuuid);
    expect(f.calls).toHaveLength(2);
  });
});

describe("caches", () => {
  test("search results are cached for 5 minutes, keyed on the normalised request", async () => {
    let t = 1_000_000;
    const f = fake(() => reply([CHILL]));
    const rb = make(f.fetchImpl, { now: () => t });
    await rb.searchStations("Nightride");
    await rb.searchStations("  nightride ");
    expect(f.calls).toHaveLength(1);
    await rb.searchStations("nightride", { limit: 5 }); // another limit is another request
    await rb.searchStations("nightride", { tag: "synth" });
    await rb.searchStations("nightride", { country: "DE" });
    expect(f.calls).toHaveLength(4);
    t += 5 * 60_000 - 1;
    await rb.searchStations("nightride");
    expect(f.calls).toHaveLength(4);
    t += 1;
    await rb.searchStations("nightride");
    expect(f.calls).toHaveLength(5);
  });

  test("a caller cannot damage the cache by changing a result", async () => {
    const f = fake(() => reply([CHILL]));
    const rb = make(f.fetchImpl);
    const first = await rb.searchStations("abc");
    (first[0] as RbStation).name = "changed";
    first.pop();
    expect((await rb.searchStations("abc"))[0]?.name).toBe("Nightride FM - Chillsynth");
    expect((await rb.stationByUuid(CHILL.stationuuid))?.name).toBe("Nightride FM - Chillsynth");
  });

  test("station details are cached for 1 hour; unknown stations are not cached", async () => {
    let t = 0;
    const f = fake(() => reply([SOMA]));
    const rb = make(f.fetchImpl, { now: () => t });
    await rb.stationByUuid(SOMA.stationuuid);
    t += 59 * 60_000;
    await rb.stationByUuid(SOMA.stationuuid);
    expect(f.calls).toHaveLength(1);
    t += 60_000;
    await rb.stationByUuid(SOMA.stationuuid);
    expect(f.calls).toHaveLength(2);
    const g = fake(() => reply([]));
    const rb2 = make(g.fetchImpl);
    await rb2.stationByUuid(U1);
    await rb2.stationByUuid(U1);
    expect(g.calls).toHaveLength(2);
  });

  test("a search fills the detail cache", async () => {
    const f = fake(() => reply([CHILL, DARK]));
    const rb = make(f.fetchImpl);
    await rb.searchStations("nightride");
    expect((await rb.stationByUuid(DARK.stationuuid))?.name).toBe("Nightride FM - Darksynth");
    expect(f.calls).toHaveLength(1);
  });

  test("failures are not cached", async () => {
    const f = fake((_c, n) => (n <= MIRRORS.length ? new Response("", { status: 500 }) : reply([CHILL])));
    const rb = make(f.fetchImpl);
    await expect(rb.searchStations("flaky")).rejects.toThrow("Radio directory is unreachable");
    expect(await rb.searchStations("flaky")).toHaveLength(1);
  });

  test("each cache holds at most 200 entries, dropping the oldest", async () => {
    const f = fake(() => reply([CHILL]));
    const rb = make(f.fetchImpl);
    for (let i = 0; i < 201; i++) await rb.searchStations(`q${i}`);
    expect(f.calls).toHaveLength(201);
    await rb.searchStations("q200"); // newest is still there
    await rb.searchStations("q1");
    expect(f.calls).toHaveLength(201);
    await rb.searchStations("q0"); // oldest was evicted
    expect(f.calls).toHaveLength(202);

    const many = Array.from({ length: 30 }, (_, i) => ({ ...CHILL, stationuuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    const g = fake(() => reply(many));
    const rb2 = make(g.fetchImpl);
    for (let i = 0; i < 8; i++) await rb2.searchStations(`s${i}`, { limit: 30 }); // 240 records: the first ones fall out
    expect(g.calls).toHaveLength(8);
    await rb2.stationByUuid("00000000-0000-4000-8000-000000000029"); // still cached
    expect(g.calls).toHaveLength(8);
  });
});

describe("mirrors, timeout, size cap", () => {
  const byHost = (map: Record<string, () => Response | Promise<Response>>) =>
    fake((c) => {
      const h = map[c.url.host];
      if (!h) throw new Error("unexpected host");
      return h();
    });

  test("a failing mirror is skipped: network error, HTTP error, bad JSON, wrong shape", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("", { status: 503 }),
      () => new Response("", { status: 429 }),
      () => new Response("<html>nope</html>", { status: 200 }),
      () => reply({ error: "x" }),
      () => reply("a string"),
      () => reply(null),
    ];
    for (const [i, fail] of failures.entries()) {
      const f = byHost({ [MIRRORS[0] as string]: fail, [MIRRORS[1] as string]: () => reply([CHILL]) });
      const out = await make(f.fetchImpl).searchStations(`m${i}`);
      expect(out).toHaveLength(1);
      expect(f.calls.map((c) => c.url.host)).toEqual([MIRRORS[0], MIRRORS[1]]);
    }
  });

  test("when every mirror fails the error is the plain 'unreachable' one, after trying each once", async () => {
    const f = fake(() => new Response("", { status: 500 }));
    const err = await make(f.fetchImpl).searchStations("down").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe("Radio directory is unreachable");
    expect(f.calls.map((c) => c.url.host)).toEqual(MIRRORS);
  });

  test("the mirror that worked last is tried first next time", async () => {
    const f = byHost({
      [MIRRORS[0] as string]: () => new Response("", { status: 502 }),
      [MIRRORS[1] as string]: () => reply([CHILL]),
      [MIRRORS[2] as string]: () => reply([CHILL]),
    });
    const rb = make(f.fetchImpl);
    await rb.searchStations("first");
    await rb.searchStations("second");
    expect(f.calls.map((c) => c.url.host)).toEqual([MIRRORS[0], MIRRORS[1], MIRRORS[1]]);
  });

  test("a mirror that never answers is abandoned after half the budget and the next one is asked", async () => {
    // Real timers on purpose: the behaviour under test is an AbortSignal.timeout firing.
    const f = fake((c) => (c.url.host === MIRRORS[0] ? hang(c.url.href, c.init) : reply([CHILL])));
    const calls = f.calls;
    const out = await make(f.fetchImpl, { timeoutMs: 1200 }).searchStations("slow");
    expect(out).toHaveLength(1);
    expect(calls.map((c) => c.url.host)).toEqual([MIRRORS[0], MIRRORS[1]]);
  });

  test("nothing answering at all ends in 'unreachable' once the timeout has passed", async () => {
    const f = fake((c) => hang(c.url.href, { signal: c.init?.signal as AbortSignal }));
    const t0 = Date.now();
    await expect(make(f.fetchImpl, { timeoutMs: 300 }).searchStations("hang")).rejects.toThrow("Radio directory is unreachable");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(f.calls.length).toBeLessThanOrEqual(MIRRORS.length);
  });

  test("the caller's signal aborts the call at once and is not retried on another mirror", async () => {
    const ctl = new AbortController();
    const f = fake((c) => hang(c.url.href, { signal: c.init?.signal as AbortSignal }));
    const p = make(f.fetchImpl).searchStations("abort", { signal: ctl.signal });
    const settled = p.then(() => "ok", (e: unknown) => e);
    await until(() => f.calls.length === 1, "the request to start");
    ctl.abort(new Error("client left"));
    expect(((await settled) as Error).message).toBe("client left");
    expect(f.calls).toHaveLength(1);
    // already aborted before the call: nothing is sent
    const early = AbortSignal.abort(new Error("gone"));
    await expect(make(f.fetchImpl).searchStations("early", { signal: early })).rejects.toThrow("gone");
    expect(f.calls).toHaveLength(1);
  });

  test("a body over 1 MB is refused (declared length)", async () => {
    const f = byHost({
      [MIRRORS[0] as string]: () => new Response("[]", { status: 200, headers: { "content-length": String(1024 * 1024 + 1) } }),
      [MIRRORS[1] as string]: () => reply([CHILL]),
    });
    expect(await make(f.fetchImpl).searchStations("big")).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  });

  test("a body over 1 MB is refused while streaming, and the download is cancelled", async () => {
    let cancelled = false;
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20); // spaces: harmless JSON whitespace
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    const f = byHost({ [MIRRORS[0] as string]: endless, [MIRRORS[1] as string]: () => reply([CHILL]) });
    expect(await make(f.fetchImpl).searchStations("endless")).toHaveLength(1);
    await until(() => cancelled, "the stream to be cancelled");
    expect(sent).toBeLessThan(4 * 1024 * 1024);
  });

  test("a body just under the cap is read", async () => {
    const pad = " ".repeat(1024 * 1024 - 100);
    const f = fake(() => new Response(`[]${pad}`, { status: 200 }));
    expect(await make(f.fetchImpl).searchStations("fits")).toEqual([]);
  });

  test("requests are paced: at least minIntervalMs apart", async () => {
    const times: number[] = [];
    const f = fake(() => {
      times.push(Date.now());
      return reply([]);
    });
    const rb = createRadioBrowser({ fetchImpl: f.fetchImpl, minIntervalMs: 120 });
    await Promise.all([rb.searchStations("p1"), rb.searchStations("p2"), rb.searchStations("p3")]);
    expect(times).toHaveLength(3);
    expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(100);
    expect((times[2] as number) - (times[1] as number)).toBeGreaterThanOrEqual(100);
  });

  test("a queue longer than the call's deadline is refused instead of waiting", async () => {
    const f = fake(() => reply([]));
    const rb = createRadioBrowser({ fetchImpl: f.fetchImpl, minIntervalMs: 60_000, timeoutMs: 1000 });
    await rb.searchStations("first");
    await expect(rb.searchStations("second")).rejects.toThrow("Radio directory is unreachable");
    expect(f.calls).toHaveLength(1);
  });

  test("request urls are built from the fixed hosts and the validated input only", async () => {
    const f = fake(() => reply([]));
    const rb = make(f.fetchImpl);
    await rb.searchStations("a&b=c#d?e/../f", { country: "x&limit=999", tag: "y&hidebroken=false" });
    await rb.stationByUuid(U1);
    await rb.resolveStream(U1).catch(() => undefined);
    for (const c of f.calls) {
      expect(MIRRORS).toContain(c.url.host);
      expect(c.url.username + c.url.password + c.url.hash).toBe("");
      expect(c.url.pathname).toMatch(/^\/json\/(stations\/search|stations\/byuuid\/[0-9a-f-]{36}|url\/[0-9a-f-]{36})$/);
    }
    const p = (f.calls[0] as Call).url.searchParams;
    expect([...p.keys()].sort()).toEqual(["country", "hidebroken", "limit", "name", "order", "reverse", "tag"]);
    expect([p.get("name"), p.get("country"), p.get("tag"), p.get("limit"), p.get("hidebroken")]).toEqual(["a&b=c#d?e/../f", "x&limit=999", "y&hidebroken=false", "20", "true"]);
  });
});
