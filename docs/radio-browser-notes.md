# radio-browser.info integration notes

Module: `lib/radiobrowser.ts` (server side only). Tests: `tests/radiobrowser.test.ts`.
Everything below was observed on 2026-11-04 against the live service unless marked `[INFERENCE]`.

## What the service is

An open, community-edited directory of internet radio stations (like Wikipedia for radio), free and
open source, run by one person ("used freely but without guarantee to work", online since 2015).
Docs: <https://api.radio-browser.info/> and <https://docs.radio-browser.info/>. Server software 0.7.45.

## Usage rules (from the docs)

| Topic | What the docs / the servers say |
| --- | --- |
| Cost, licence | Free, also for non-free software; the server software is open source (GitLab) and you may mirror all the data. The data licence is not stated in the docs. |
| Terms / attribution | None required. The docs only ask for a **descriptive `User-Agent`** (`appname/version`) so the maintainer can tell which apps use the service, and to tell him about apps missing from the "Apps" list on www.radio-browser.info. We send `TabDeck/0.1 (+https://github.com/tcsenpai/tabdeck)`. Courtesy, not a duty: mention "stations from radio-browser.info" in the UI/README. |
| Rate limit | **None published.** Guidance is only implicit: be a good citizen. We pace to at most 1 request/s, cache searches 5 min and details 1 h. |
| Clicks | "Send `/json/url` requests for every click the user makes, this helps to mark stations as popular." `GET /json/url/<uuid>` **increments the station's click counter** (counted once per day per IP and station) and returns the playable URL. The module calls it from `resolveStream` and does not cache it: call `resolveStream` once per play, not per render. |
| Choosing a server | Docs: resolve `all.api.radio-browser.info` in DNS (or SRV `_api._tcp.radio-browser.info`), reverse-lookup the names, shuffle, use the first, on failure try the next. Never hard-code one host. |
| Station ids | Use `stationuuid`; the old numeric `id` is not stable across servers. |
| Station health | Every station is checked at least daily (`lastcheckok`). `hidebroken=true` in a search hides failed ones. |
| Notes on fields | `bitrate` is documented as "bps" in one table and as kbit/s in another; in practice kbit/s, except some HLS records which hold bit/s (`320000`). The module shows kbit/s (>= 10000 is divided by 1000). |

### CORS and HTTPS

- HTTPS works on every host, certificates valid (`curl` verify result 0). Plain `http://` also answers.
- Every response (also errors and `OPTIONS` → 204) carries `access-control-allow-origin: *`,
  `access-control-allow-methods: GET,POST`, `access-control-allow-headers: origin, x-requested-with, content-type, User-Agent`.
  So the tablet's browser *could* call the API directly. We do not: the server validates and sanitises
  everything, sends the polite User-Agent (a browser cannot set it), paces/caches centrally and keeps
  the stream URL check in one place.

### Mirrors today

- `dig all.api.radio-browser.info` → `91.98.4.78` only. `SRV _api._tcp` → `de1.api.radio-browser.info` only.
- `https://de1…/json/servers` → one entry (`de1`, IPv4 + IPv6). `de2.api…` resolves to the same IP and answers.
  `at1`, `nl1`, `fi1`, `de3`, `us1` (old mirror names) no longer resolve.
- So the "network" is currently a single host, and the DNS lookup the docs recommend gives the same
  answer as a fixed list. Decision: hard-code `de1`, `de2`, `all` (all three verified with valid TLS),
  start with the one that answered last, fall back in order. No DNS/reverse-DNS code, and the only
  hosts a request can ever go to are those three. If the network grows again, add names to `MIRRORS`
  (a one-line change). `[INFERENCE]` `all.api…` follows DNS, so it also covers a future change.

## Endpoints used (real responses, trimmed)

All GET, JSON, no auth. Query values are URL-encoded by `URLSearchParams`.

### Search — `GET /json/stations/search?name=nightride&limit=3&hidebroken=true&order=clickcount&reverse=true`

`200`, `content-type: application/json`, ~1.1 KB per station (3 stations = 3366 bytes). An empty result is `200 []`
(also for `name=<script>` and for nonsense names). Optional filters we pass: `tag=`, `country=<name>` or
`countrycode=<XX>` (the module picks `countrycode` when the value is two letters).

```json
[{"changeuuid":"36b89f53-0d32-4932-a0cc-717f7a4c16f9","stationuuid":"9067dc39-4bf4-4364-bd6b-8020cff3e15d","serveruuid":null,
  "name":"Nightride FM - Chillsynth","url":"https://stream.nightride.fm/chillsynth.mp3",
  "url_resolved":"https://stream.nightride.fm/chillsynth.mp3","homepage":"https://nightride.fm/",
  "favicon":"https://nightride.fm/thumbnail.png","tags":"chillsynth,chillwave,instrumental",
  "country":"Germany","countrycode":"DE","iso_3166_2":"","state":"","language":"","languagecodes":"",
  "votes":1685,"codec":"MP3","bitrate":320,"hls":0,"lastcheckok":1,"clickcount":33, "...":"(timestamps, geo, ssl_error trimmed)"}]
```

### By uuid — `GET /json/stations/byuuid/<uuid>`

Works with the uuid in the path (the docs also show `?uuids=a,b,c`). Returns a list; an unknown uuid is `200 []`.

```json
[{"stationuuid":"960cf833-0601-11e8-ae97-52543be04c81","name":"SomaFM Groove Salad (128k MP3)",
  "url":"https://somafm.com/groovesalad.pls","url_resolved":"https://ice2.somafm.com/groovesalad-128-mp3",
  "favicon":"https://somafm.com/img3/groovesalad-400.jpg","tags":"ambient,chillout,downtempo,groove,lounge,sleep",
  "country":"The United States Of America","countrycode":"US","codec":"MP3","bitrate":128,"hls":0,"lastcheckok":1}]
```

### Click + resolve — `GET /json/url/<uuid>`

Counts a click and returns the stream (always the *resolved* one, not the playlist in `url`):

```json
{"ok":true,"message":"retrieved station url","stationuuid":"960cf833-0601-11e8-ae97-52543be04c81","name":"SomaFM Groove Salad (128k MP3)","url":"https://ice2.somafm.com/groovesalad-128-mp3"}
```

- Docs print `"ok": "true"` (a string); the live server sends boolean `true`. The module accepts both.
- Unknown (valid) uuid → `404` with an empty body. Malformed uuid → `404`. The module maps 404 and `ok:false` to `ConfigError("Unknown station")`.
- HLS example (`BBC Radio 2 (128k)`): `"url":"http://as-hls-ww-live.akamaized.net/pool_74208725/live/ww/bbc_radio_two/bbc_radio_two.isml/bbc_radio_two-audio%3d128000.norewind.m3u8"`.

## Stream facts, checked on 200 top stations (`order=clickcount`)

- Codecs: MP3 133, AAC 19 + AAC+ 10 (non-HLS), OGG 5, HLS 33 (`hls:1`; codec often `UNKNOWN`/`AAC`).
- `url_resolved` is already a direct stream for **all 200**: no `.pls`/`.m3u`/`.asx` ever remained in it.
  The playlists live only in `url` (e.g. `https://somafm.com/groovesalad.pls`, `http://www.101smoothjazz.com/101-smoothjazz.m3u`).
  Always play `url_resolved` (what `/json/url` returns), never `url`.
- 79 of 200 resolved urls are plain `http://`; 8 are bare public IPv4 literals; urls can reach ~660 characters
  (signed HLS tokens); names reach 346 characters and tags 759 (SEO spam), favicons 196.
- All 200 resolved urls and all 200 favicons pass `safeUrl` (no false rejections).

### Silent playback checks (ffplay, `-nodisp -volume 0`, killed after 4–7 s, no ffplay left running)

| Station | URL played | Result |
| --- | --- | --- |
| SomaFM Groove Salad (MP3) | `https://ice2.somafm.com/groovesalad-128-mp3` (from `/json/url`) | OK: `Audio: mp3, 44100 Hz, stereo, 128 kb/s`, ICY headers read, clock advanced to 5.4 s, nothing on stderr |
| Europe 1 (AAC) | `https://stream.europe1.fr/europe1.aac` | OK: `Audio: aac (LC), 48000 Hz, stereo, 127 kb/s`, clock advanced to 5.6 s |
| BBC Radio 2 (HLS, `.m3u8`) | `http://as-hls-ww-live.akamaized.net/…/bbc_radio_two-audio%3d128000.norewind.m3u8` | OK with `-loglevel error`: no stderr output, plays until killed |
| SomaFM `url` (a `.pls`) | `https://somafm.com/groovesalad.pls` | **Fails**: `Input/output error` |
| 101 Smooth Jazz `url` (a `.m3u`) | `http://www.101smoothjazz.com/101-smoothjazz.m3u` | **Fails**: `Invalid data found when processing input` |

So: ffplay (and presumably mpv, the other player `lib/radio.ts` uses) handles MP3, AAC and HLS natively
but **not** playlist files, which is a second reason to use `url_resolved` only. The MP3 and AAC runs used
`-loglevel info` to show the stream info; the HLS and playlist runs used `-loglevel error`.
During research one click was registered for each of: SomaFM Groove Salad, Europe 1, BBC Radio 2 (and again
SomaFM in a smoke test, which the server counts once per day).

`[INFERENCE]` for the tablet: `<audio src=…>` plays MP3 and AAC everywhere; HLS (`.m3u8`) is native on Safari and
Chrome for Android but not on desktop Chrome/Firefox, so a weak Android tablet may or may not play it. Stations with
`hls:1` are the ones at risk. Also, `http://` streams are blocked as mixed content if the pad is ever served over
HTTPS (today it is plain HTTP on the LAN). Not tested on the real tablet.

## Third-party data: what the module does about it

Station names, tags and URLs are written by anybody. The Mac's player and the tablet's browser are going
to open these URLs, so `lib/radiobrowser.ts` treats them as hostile:

- **Only `http:`/`https:`**; rejects `file:`, `data:`, `javascript:`, `ftp:`, `blob:`, schemes-less and relative values.
- **No credentials** (`user:pw@`), no whitespace/control/`<>"\` characters, **length cap** (1024 for streams, 300 for icons).
- **No local targets**: `localhost`, `*.localhost`/`.local`/`.lan`/`.internal`/`.home.arpa`/`.intranet`/`.corp`…, single-label names
  (`http://nas/`), IPv4 loopback/private/link-local/CGNAT/multicast/reserved/documentation ranges (incl. `169.254.169.254`),
  and **every IPv6 literal** (mapped, 6to4, NAT64 and ULA forms make an allow-list not worth it; no real station uses one).
- **IP tricks**: the URL parser normalises `2130706433`, `0x7f.1`, `017700000001`, `127.1`, `%31%32%37.0.0.1`,
  full-width dots and circled digits to `127.0.0.1` before the check; the normalised `href` is what is returned.
- **Known limit**: the check is syntactic. A public name whose DNS record points at a LAN address (DNS rebinding,
  `127.0.0.1.nip.io`) passes. Resolving names ourselves would still leave the player to resolve again, so it is not
  attempted; keep this in mind before exposing the endpoint beyond the trusted LAN.
- **Output sanitising**: strings only, capped (name 100, country 60, codec 16, tags 100), control characters, bidi overrides,
  BOM and `<>` removed, no split surrogate pairs; icons are dropped (not the station) when unsafe. A station is dropped when
  its uuid is not canonical, its name is empty after cleaning or its resolved stream is not safe.
- **Requests**: only `https://<fixed mirror>/json/{stations/search|stations/byuuid/<uuid>|url/<uuid>}`; the uuid must match
  `^[0-9a-f]{8}-…-[0-9a-f]{12}$` (lowercase, canonical); `redirect: "error"`; 6 s total timeout (3 s per mirror), 1 MB body cap
  (declared and streamed), 1 request/s pacing (a queue longer than the call's deadline is refused), caches ≤ 200 entries.
- **Errors**: bad input → `ConfigError` (`Invalid station id`, `Unknown station`, query/limit/tag problems);
  network, HTTP, JSON or shape failure on every mirror → `Error("Radio directory is unreachable")`;
  a resolved url that fails the rules → `Error("Station stream is not playable")` (plain, not a client error).
  An aborted caller signal rethrows its own reason.

## Recommendation

Worth integrating, server side, as a **search-and-favourite** feature: it gives the pad the whole world's radio with no key,
no account, no dependency and (per the docs) no formal limits; the cost is a public directory run by one person without
guarantees, so the UI must treat "directory unreachable" as normal and favourites must keep playing without it
(see below). Flow: the tablet searches through the pad server → the user adds a station → on play the server calls
`resolveStream(uuid)` (which also counts the click, as asked) → the Mac plays the returned URL with the existing
mpv/ffplay path, or hands the URL to the tablet's `<audio>` (prefer non-HLS there). Gate the tablet-side play on the
station's `hls` flag if the weak tablet turns out not to play `.m3u8` — the module does not expose `hls` today
(`RbStation` is fixed by the brief); add it if needed.

Do **not** store resolved stream URLs: they change (signed HLS tokens expire — the Korean broadcasters' URLs embed a
`Policy=…&Signature=…` query), and resolving again is also the click the docs ask for.

### Minimal data to store per favourite in `pad.json`

`{ "uuid": "<canonical lowercase stationuuid>", "name": "<name at the time of adding>" }`

- `uuid` is the only stable key (the numeric `id` is not). Validate with `isRbUuid` on load.
- `name` lets the pad draw its tile instantly and offline; refresh it with `stationByUuid` when convenient.
- Nothing else is needed: country, codec, bitrate and tags are display extras that `stationByUuid` returns when wanted
  (cached 1 h), the favicon is a third-party image URL best not persisted, and the stream URL must be re-resolved on every play.
