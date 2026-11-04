import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { APP_PRESETS, createContext, matchRule, parseProbe, type AppContext, type AutoRule } from "../lib/context.ts";

const SEP = "\u001f";
const ctx = (o: Partial<AppContext> = {}): AppContext => ({ app: "", bundle: "", title: "", url: "", ...o });
const rule = (o: Partial<AutoRule> = {}): AutoRule => ({ app: "", mode: "is", url: "", title: "", page: "p", ...o });

async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}

describe("probe", () => {
  test("parses the delimited output", async () => {
    const p = createContext({ run: async () => `Safari${SEP}com.apple.Safari${SEP}Home${SEP}https://a.example/x\n` });
    expect(await p.get()).toEqual({ app: "Safari", bundle: "com.apple.Safari", title: "Home", url: "https://a.example/x" });
  });

  test("missing fields become empty strings", () => {
    expect(parseProbe(`Finder${SEP}com.apple.finder`)).toEqual({ app: "Finder", bundle: "com.apple.finder", title: "", url: "" });
  });

  test("sanitises control chars, caps length, rejects a bad bundle id", () => {
    const c = parseProbe(`Ap\u0007p${SEP}bad bundle"${SEP}${"x".repeat(1000)}${SEP}a\nb`);
    expect(c.app).toBe("Ap p");
    expect(c.bundle).toBe("");
    expect(c.title.length).toBe(300);
    expect(c.url).toBe("a b");
  });

  test("a failing run yields an empty context instead of throwing", async () => {
    const p = createContext({ run: async () => { throw new Error("boom"); } });
    expect(await p.get()).toEqual(ctx());
  });

  test("caches within the ttl and probes again after it", async () => {
    let calls = 0;
    const p = createContext({ ttlMs: 40, run: async () => `A${++calls}${SEP}x${SEP}${SEP}` });
    expect((await p.get()).app).toBe("A1");
    expect((await p.get()).app).toBe("A1");
    expect(calls).toBe(1);
    let app = "A1";
    const t0 = Date.now();
    while (app === "A1") {
      if (Date.now() - t0 > 5000) throw new Error("timed out waiting for cache expiry");
      app = (await p.get()).app;
    }
    expect(app).toBe("A2");
    expect(calls).toBe(2);
  });

  test("concurrent callers share one probe", async () => {
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const p = createContext({ run: async () => { calls++; await gate.promise; return `A${SEP}b${SEP}${SEP}`; } });
    const all = [p.get(), p.get(), p.get()];
    await until(() => calls > 0, "probe started");
    gate.resolve();
    const res = await Promise.all(all);
    expect(calls).toBe(1);
    expect(res.every((r) => r.app === "A")).toBe(true);
  });

  test("callers cannot mutate the cache", async () => {
    const p = createContext({ run: async () => `A${SEP}b${SEP}${SEP}` });
    (await p.get()).app = "hacked";
    expect((await p.get()).app).toBe("A");
  });

  test("the script is applescript and never activates or launches", async () => {
    let seen = "";
    let lang = "";
    await createContext({ run: async (s, l) => { seen = s; lang = l; return ""; } }).get();
    expect(lang).toBe("applescript");
    expect(seen).not.toMatch(/activate|launch|open location/i);
  });

  const live = existsSync("/usr/bin/osascript");
  (live ? test : test.skip)("live probe returns string fields", async () => {
    const c = await createContext().get();
    for (const k of ["app", "bundle", "title", "url"] as const) expect(typeof c[k]).toBe("string");
  }, 15000);
});

describe("matchRule", () => {
  test("matches by name or bundle, case-insensitively", () => {
    const r = rule({ app: "DISCORD" });
    expect(matchRule([r], ctx({ app: "Discord" }))).toBe(r);
    const b = rule({ app: "com.hnc.discord" });
    expect(matchRule([b], ctx({ app: "x", bundle: "com.hnc.Discord" }))).toBe(b);
    expect(matchRule([r], ctx({ app: "Discord Canary" }))).toBeUndefined();
  });

  test("contains is a substring match on name or bundle", () => {
    const r = rule({ app: "chrome", mode: "contains" });
    expect(matchRule([r], ctx({ app: "Google Chrome" }))).toBe(r);
    expect(matchRule([r], ctx({ app: "x", bundle: "com.google.Chrome" }))).toBe(r);
    expect(matchRule([r], ctx({ app: "Safari" }))).toBeUndefined();
  });

  test("url and title constraints are substrings; empty means none", () => {
    const r = rule({ app: "Safari", url: "YouTube.com", title: "live" });
    expect(matchRule([r], ctx({ app: "Safari", url: "https://www.youtube.com/w", title: "Live now" }))).toBe(r);
    expect(matchRule([r], ctx({ app: "Safari", url: "https://x.com", title: "Live" }))).toBeUndefined();
    expect(matchRule([r], ctx({ app: "Safari", url: "https://youtube.com", title: "Other" }))).toBeUndefined();
    expect(matchRule([rule({ app: "Safari" })], ctx({ app: "Safari" }))).toBeDefined();
  });

  test("empty app never matches, even against an empty context", () => {
    expect(matchRule([rule({ app: "" }), rule({ app: "  ", mode: "contains" })], ctx())).toBeUndefined();
    expect(matchRule([rule({ app: "x" })], ctx())).toBeUndefined();
  });

  test("first match wins", () => {
    const a = rule({ app: "Safari", url: "a.com", page: "1" });
    const b = rule({ app: "Safari", page: "2" });
    const c = rule({ app: "Safari", page: "3" });
    expect(matchRule([a, b, c], ctx({ app: "Safari", url: "http://a.com" }))).toBe(a);
    expect(matchRule([a, b, c], ctx({ app: "Safari", url: "http://z.com" }))).toBe(b);
  });

  test("hostile input never throws", () => {
    const junk = [null, undefined, 5, "s", { app: 3 }, { app: "x", mode: "weird" }, { app: {}, url: [] }] as unknown as AutoRule[];
    expect(matchRule(junk, ctx({ app: "nomatch" }))).toBeUndefined();
    expect(matchRule(junk, ctx({ app: "x" }))?.mode).toBe("weird"); // unknown mode degrades to `is`
    expect(matchRule(null as unknown as AutoRule[], ctx())).toBeUndefined();
    expect(matchRule([rule({ app: "x" })], null as unknown as AppContext)).toBeUndefined();
    expect(matchRule([rule({ app: "x" })], { app: 1, bundle: null, title: {}, url: [] } as unknown as AppContext)).toBeUndefined();
  });
});

describe("APP_PRESETS", () => {
  test("well-formed, unique ids, valid bundle ids", () => {
    expect(APP_PRESETS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(APP_PRESETS.map((p) => p.id)).size).toBe(APP_PRESETS.length);
    for (const p of APP_PRESETS) {
      expect(p.name && p.hint).toBeTruthy();
      expect(p.bundles.length).toBeGreaterThan(0);
      for (const b of p.bundles) expect(b).toMatch(/^[A-Za-z0-9.-]+$/);
    }
  });
});
