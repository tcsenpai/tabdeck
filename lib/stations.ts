// The only streams the server will ever play: a fixed whitelist, so no request or config value
// can make it open an arbitrary URL. Shared by config validation and the Mac player.
export interface Station {
  id: string;
  url: string;
}

// Nightride FM (https://nightride.fm): public MP3 streams, one per station.
export const NIGHTRIDE_IDS = [
  "nightride", "chillsynth", "datawave", "spacesynth", "darksynth", "horrorsynth",
  "ebsm", "rekt", "rektory", "rektify", "d-notive",
] as const;

export const STATIONS: Station[] = [
  ...NIGHTRIDE_IDS.map((id) => ({ id, url: `https://stream.nightride.fm/${id}.mp3` })),
  // Virgin Radio Italia: the same public AAC stream its own web player uses.
  { id: "virgin", url: "https://icecast.unitedradio.it/Virgin.aac" },
];

export const STATION_IDS: string[] = STATIONS.map((s) => s.id);
export const isStation = (id: unknown): id is string => typeof id === "string" && STATION_IDS.includes(id);
export const stationUrl = (id: string): string => STATIONS.find((s) => s.id === id)?.url ?? STATIONS[0].url;

// Stations picked from the radio-browser.info directory ("favourites") are identified as `rb:<uuid>`.
// Which ones exist is decided by the saved config (PadConfig.radioFavs); their stream URL is resolved
// on every play (lib/radiobrowser.ts), never stored.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRbUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
export const favId = (uuid: string): string => `rb:${uuid}`;
// The uuid of a favourite id, or null when `id` is not one (format only).
export const favUuid = (id: unknown): string | null => {
  if (typeof id !== "string" || !id.startsWith("rb:")) return null;
  const u = id.slice(3);
  return isRbUuid(u) ? u : null;
};
