// "Now playing" for a station that publishes its titles in the stream itself (Shoutcast/Icecast ICY metadata).
// The server opens the stream with `Icy-MetaData: 1`, reads just past the first metadata block (a few KB, nothing is
// played or stored) and closes it. Results are cached, so any number of tablets cost one short request per interval.
// Virgin Radio Italia sends "ARTIST~TITLE~ALBUM~YEAR~~SECONDS~START~END~STATION"; plain "Artist - Title" works too.

export interface NowPlaying {
  artist: string;
  title: string;
}

const MAX_TEXT = 100;
const clean = (v: string): string => v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

export function parseStreamTitle(raw: string): NowPlaying | null {
  const m = /StreamTitle='((?:[^']|'(?!;))*)'/.exec(raw);
  const text = m ? m[1] : "";
  if (!text.trim()) return null;
  let artist = "";
  let title = "";
  if (text.includes("~")) {
    const [a = "", t = ""] = text.split("~");
    artist = a;
    title = t;
  } else if (text.includes(" - ")) {
    const i = text.indexOf(" - ");
    artist = text.slice(0, i);
    title = text.slice(i + 3);
  } else {
    title = text;
  }
  const out = { artist: clean(artist), title: clean(title) };
  return out.artist || out.title ? out : null;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

// Reads the first metadata block of `url`. Never throws: null when the stream has none or is unreachable.
export async function readIcy(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 8000): Promise<NowPlaying | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { "Icy-MetaData": "1", "User-Agent": "TabDeck/0.1" }, signal: ctl.signal });
    const every = Number(res.headers.get("icy-metaint"));
    if (!res.ok || !res.body || !Number.isInteger(every) || every < 1 || every > 65536) return null;
    const need = every + 1 + 255 * 16;
    const chunks: Uint8Array[] = [];
    let have = 0;
    const reader = res.body.getReader();
    while (have < need) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      have += value.length;
      if (have > every) {
        const buf = Buffer.concat(chunks);
        if (buf.length >= every + 1 + buf[every] * 16) {
          const len = buf[every] * 16;
          return parseStreamTitle(buf.subarray(every + 1, every + 1 + len).toString("utf8"));
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctl.abort(); // drop the connection: we only wanted the first block
  }
}

// Cache per URL: a result is reused for `ttlMs`, and one request at a time is in flight per URL.
export function createNowPlaying(opts: { fetchImpl?: FetchLike; ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: NowPlaying | null }>();
  const inflight = new Map<string, Promise<NowPlaying | null>>();
  return {
    async get(url: string): Promise<NowPlaying | null> {
      const hit = cache.get(url);
      if (hit && now() - hit.at < ttl) return hit.value;
      let p = inflight.get(url);
      if (!p) {
        p = readIcy(url, opts.fetchImpl).then((value) => {
          cache.set(url, { at: now(), value });
          inflight.delete(url);
          return value;
        });
        inflight.set(url, p);
      }
      return p;
    },
  };
}
