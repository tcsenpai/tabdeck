// A short fingerprint of the files the pad runs (everything in public/): the pad polls it and reloads itself when
// it changes, so an open tablet never keeps running an old script after an update. Names, sizes and mtimes are
// hashed, not contents, so a check costs one directory listing; the result is cached briefly.
import { readdirSync, statSync } from "node:fs";

export function createBuildId(dir: string, ttlMs = 1500): () => string {
  let id = "";
  let at = -Infinity;
  return () => {
    const now = Date.now();
    if (id && now - at < ttlMs) return id;
    const h = new Bun.CryptoHasher("sha1");
    for (const name of readdirSync(dir).sort()) {
      try {
        const s = statSync(`${dir}/${name}`);
        if (s.isFile()) h.update(`${name}:${s.size}:${Math.floor(s.mtimeMs)}\n`);
      } catch {} // a file removed while listing: the next call sees the new state
    }
    id = h.digest("hex").slice(0, 7);
    at = now;
    return id;
  };
}
