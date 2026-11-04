// Client for the radio-browser.info community directory (https://api.radio-browser.info/), server side only.
// Everything it returns comes from a THIRD-PARTY database that anybody can edit, so nothing is trusted:
// strings are sanitised and capped, and a stream or icon URL is only passed on when it is a plain
// public http(s) URL (see safeUrl). Request URLs are built from a fixed mirror list and a validated
// uuid / bounded query only. Docs, rules and real samples: docs/radio-browser-notes.md.
import { ConfigError } from "./config.ts";

export interface RbStation {
  uuid: string;
  name: string;
  country: string;
  codec: string;
  bitrate: number; // kbit/s, 0 when the directory does not know
  tags: string;
  favicon: string; // a safe http(s) URL or ""
}

export const USER_AGENT = "TabDeck/0.1 (+https://github.com/tcsenpai/tabdeck)";

// The directory is a network of mirrors; the docs say to look them up in DNS (all.api…) and pick a
// random one. Today that lookup returns the single host de1 (de2 is an alias of it), so a fixed list
// is equivalent, avoids DNS plus reverse lookups, and keeps hosts out of reach of anything but this
// file. "all" has a valid TLS certificate and follows DNS, so it covers a future change of the network.
const MIRRORS: readonly string[] = [
  "de1.api.radio-browser.info",
  "de2.api.radio-browser.info",
  "all.api.radio-browser.info",
];

const TIMEOUT_MS = 6000; // for one call, over all mirrors; each attempt gets half so that a fallback is possible
const MIN_INTERVAL_MS = 1000; // politeness: at most one request per second
const MAX_BODY = 1024 * 1024;
const CACHE_MAX = 200;
const SEARCH_TTL = 5 * 60_000;
const DETAIL_TTL = 60 * 60_000;
const MAX_QUERY = 60;
const MAX_FILTER = 40;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 30;
const MAX_STREAM_URL = 1024; // real signed HLS urls reach ~660 characters
const MAX_ICON_URL = 300;
const UNREACHABLE = "Radio directory is unreachable";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Canonical lowercase form only: the value ends up in a request path.
export function isRbUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// Whitespace and control characters become a single space; angle brackets, bidi overrides, BOM and
// lone surrogates disappear. Cut by code points so an emoji is never split.
function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v
    .slice(0, max * 2)
    .replace(/[<>\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\p{Cs}]/gu, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return Array.from(s).slice(0, max).join("").trim();
}

// Hosts that name the local network rather than the internet.
const PRIVATE_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home", ".home.arpa", ".intranet", ".corp", ".private"];

// The URL parser has already turned decimal / hex / octal / short IPv4 forms (2130706433, 0x7f.1,
// 127.1 …) into a dotted quad, so this sees the real address.
function privateIPv4(h: string): boolean {
  const [a, b, c] = h.split(".").map(Number) as [number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast + reserved + broadcast
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

// A URL that came out of the third-party database and may be handed to a player or a browser.
// Returns the normalised URL, or null when it is anything but a plain public http(s) address:
// other schemes, credentials, localhost / single-label / intranet-style names, private, loopback or
// link-local IPv4, and every IPv6 literal (no real station needs one, and the mapped, 6to4, NAT64
// and ULA forms make a safe allow-list not worth its risk).
// Limit: this is syntactic. A public name whose DNS record points inside the LAN is not detected.
export function safeUrl(raw: unknown, max: number): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max) return null;
  if (/[\p{Cc}\s"<>\\]/u.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "") return null;
  const host = u.hostname.endsWith(".") ? u.hostname.slice(0, -1) : u.hostname;
  if (host === "" || host.startsWith("[")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateIPv4(host) ? null : u.href;
  if (!host.includes(".")) return null; // "localhost", "printer", "nas": intranet names
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return u.href;
}

function mapStation(raw: unknown): RbStation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isRbUuid(r.stationuuid)) return null;
  const name = clean(r.name, 100);
  if (name === "") return null;
  // A station without a playable stream is of no use on a pad; keep the list honest.
  if (safeUrl(r.url_resolved, MAX_STREAM_URL) === null) return null;
  // Documented as kbit/s, but some HLS records hold bit/s (320000): treat anything from 10000 up as bit/s.
  const rawRate = typeof r.bitrate === "number" && Number.isFinite(r.bitrate) ? Math.max(0, r.bitrate) : 0;
  const bitrate = Math.min(9999, Math.round(rawRate >= 10000 ? rawRate / 1000 : rawRate));
  return {
    uuid: r.stationuuid,
    name,
    country: clean(r.country, 60),
    codec: clean(r.codec, 16),
    bitrate,
    tags: clean(r.tags, 100),
    favicon: safeUrl(r.favicon, MAX_ICON_URL) ?? "",
  };
}

function stationList(json: unknown): RbStation[] {
  if (!Array.isArray(json)) throw new Error("not a list");
  const out: RbStation[] = [];
  for (const item of json) {
    const s = mapStation(item);
    if (s) out.push(s);
  }
  return out;
}

// Reads at most `cap` bytes, so a hostile or broken mirror cannot make us buffer a huge body.
async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel();
    throw new Error("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// A search term from a caller: trimmed, bounded, no control characters.
function term(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") throw new ConfigError(`${what} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new ConfigError(`${what} is too long (max ${max})`);
  if (/\p{Cc}/u.test(s)) throw new ConfigError(`${what} contains control characters`);
  return s;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface BaseOpts {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}
export interface SearchOpts extends BaseOpts {
  limit?: number;
  country?: string; // a 2-letter ISO code ("DE") or a country name
  tag?: string;
}

// Dependencies of one client; the module-level functions use a default instance. Tests build their own.
export interface RbDeps {
  fetchImpl?: FetchLike;
  now?: () => number; // cache clock
  minIntervalMs?: number;
  timeoutMs?: number;
  mirrors?: readonly string[];
}

export interface RadioBrowser {
  searchStations(q: string, opts?: SearchOpts): Promise<RbStation[]>;
  stationByUuid(uuid: string, opts?: BaseOpts): Promise<RbStation | null>;
  resolveStream(uuid: string, opts?: BaseOpts): Promise<string>;
}

interface Cached<T> {
  at: number;
  value: T;
}

// Small TTL cache; the oldest entry goes first when full.
function makeCache<T>(ttl: number, now: () => number) {
  const map = new Map<string, Cached<T>>();
  return {
    get(key: string): T | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttl) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T) {
      map.delete(key); // re-inserting moves it to the newest position
      map.set(key, { at: now(), value });
      if (map.size > CACHE_MAX) map.delete(map.keys().next().value as string);
    },
  };
}

export function createRadioBrowser(deps: RbDeps = {}): RadioBrowser {
  const now = deps.now ?? Date.now;
  const minInterval = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const mirrors = deps.mirrors ?? MIRRORS;
  const searches = makeCache<RbStation[]>(SEARCH_TTL, now);
  const details = makeCache<RbStation>(DETAIL_TTL, now);
  let preferred = 0; // index of the mirror that answered last
  let nextSlot = 0;

  // One request per `minInterval`, first come first served. A queue longer than the call's own
  // deadline is refused rather than left to time out in the line.
  async function pace(signal: AbortSignal) {
    signal.throwIfAborted();
    const slot = Math.max(Date.now(), nextSlot);
    const wait = slot - Date.now();
    if (wait >= timeoutMs) throw new Error(UNREACHABLE);
    nextSlot = slot + minInterval;
    if (wait <= 0) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    await promise;
  }

  // GET /json/<path> on the mirrors, in order, starting with the one that worked last. A mirror that
  // fails (network, timeout, HTTP error, body that does not parse) is skipped. 404 is final and gives
  // undefined; `parse` throws on a body of the wrong shape.
  async function request<T>(path: string, query: URLSearchParams | null, parse: (json: unknown) => T, o: BaseOpts): Promise<T | undefined> {
    const doFetch = o.fetchImpl ?? deps.fetchImpl ?? fetch;
    const overall = AbortSignal.timeout(timeoutMs);
    const caller = o.signal ? [o.signal] : [];
    const whole = AbortSignal.any([overall, ...caller]);
    const perAttempt = Math.max(1, Math.floor(timeoutMs / 2));
    const qs = query ? `?${query.toString()}` : "";
    for (let i = 0; i < mirrors.length; i++) {
      const index = (preferred + i) % mirrors.length;
      o.signal?.throwIfAborted();
      if (overall.aborted) break;
      try {
        await pace(whole);
        const signal = AbortSignal.any([whole, AbortSignal.timeout(perAttempt)]);
        const res = await doFetch(`https://${mirrors[index]}/json/${path}${qs}`, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          redirect: "error", // a mirror never has a reason to send us elsewhere
          signal,
        });
        if (res.status === 404) {
          await res.body?.cancel();
          preferred = index;
          return undefined;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`HTTP ${res.status}`);
        }
        const value = parse(JSON.parse(await readCapped(res, MAX_BODY)));
        preferred = index;
        return value;
      } catch (e) {
        if (o.signal?.aborted) throw e;
      }
    }
    throw new Error(UNREACHABLE);
  }

  return {
    async searchStations(q, opts = {}) {
      const name = term(q, "query", MAX_QUERY);
      const tag = opts.tag === undefined ? "" : term(opts.tag, "tag", MAX_FILTER);
      const country = opts.country === undefined ? "" : term(opts.country, "country", MAX_FILTER);
      if (name === "" && tag === "" && country === "") throw new ConfigError("Type something to search for");
      let limit = DEFAULT_LIMIT;
      if (opts.limit !== undefined) {
        if (typeof opts.limit !== "number" || Number.isNaN(opts.limit)) throw new ConfigError("limit must be a number");
        limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(opts.limit)));
      }
      const key = JSON.stringify([name.toLowerCase(), limit, country.toLowerCase(), tag.toLowerCase()]);
      const hit = searches.get(key);
      if (hit) return hit.map((s) => ({ ...s }));
      const query = new URLSearchParams();
      if (name) query.set("name", name);
      if (country) query.set(/^[A-Za-z]{2}$/.test(country) ? "countrycode" : "country", /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : country);
      if (tag) query.set("tag", tag);
      query.set("limit", String(limit));
      query.set("hidebroken", "true");
      query.set("order", "clickcount");
      query.set("reverse", "true");
      const stations = (await request("stations/search", query, stationList, opts)) ?? [];
      searches.set(key, stations);
      for (const s of stations) details.set(s.uuid, s); // a favourite shown next is already known
      return stations.map((s) => ({ ...s }));
    },

    async stationByUuid(uuid, opts = {}) {
      if (!isRbUuid(uuid)) throw new ConfigError("Invalid station id");
      const hit = details.get(uuid);
      if (hit) return { ...hit };
      const list = await request(`stations/byuuid/${uuid}`, null, stationList, opts);
      const station = list?.find((s) => s.uuid === uuid) ?? null;
      if (station) details.set(uuid, station);
      return station && { ...station };
    },

    // The endpoint also counts a click for the station (the docs ask for this on every play), so the
    // result is deliberately not cached: call it once per play, not per render.
    async resolveStream(uuid, opts = {}) {
      if (!isRbUuid(uuid)) throw new ConfigError("Invalid station id");
      const parse = (json: unknown): string | null => {
        if (typeof json !== "object" || json === null) throw new Error("bad shape");
        const r = json as Record<string, unknown>;
        if (r.ok === false || r.ok === "false") return null;
        if ((r.ok !== true && r.ok !== "true") || r.stationuuid !== uuid || typeof r.url !== "string") throw new Error("bad shape");
        return r.url;
      };
      const url = await request(`url/${uuid}`, null, parse, opts);
      if (url === undefined || url === null) throw new ConfigError("Unknown station");
      const safe = safeUrl(url, MAX_STREAM_URL);
      if (safe === null) throw new Error("Station stream is not playable");
      return safe;
    },
  };
}

const client = createRadioBrowser();
export const searchStations = client.searchStations;
export const stationByUuid = client.stationByUuid;
export const resolveStream = client.resolveStream;
