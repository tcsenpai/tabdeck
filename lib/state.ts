// Live state for the pad: button LEDs and fader values, read with shell commands.
// Short cache and shared in-flight requests: several tablets or rapid polls do not multiply processes.
import type { PadConfig } from "./config.ts";
import { probe } from "./run.ts";

export interface PadState {
  leds: Record<string, boolean>;
  faders: Record<string, number>;
}

const TTL_MS = 1500;

async function compute(cfg: PadConfig): Promise<PadState> {
  const state: PadState = { leds: {}, faders: {} };
  const jobs: Promise<void>[] = [];
  for (const page of cfg.pages) {
    for (const b of page.buttons) {
      if (b.kind === "button" && b.led.trim()) {
        jobs.push(probe(b.led).then((r) => {
          // Timeout = unknown state: we do not invent one.
          if (!r.timedOut) state.leds[b.id] = r.code === 0;
        }));
      } else if (b.kind === "fader" && b.fader.get.trim()) {
        jobs.push(probe(b.fader.get).then((r) => {
          const n = Number.parseFloat(/-?\d+(\.\d+)?/.exec(r.out)?.[0] ?? "");
          if (r.code === 0 && Number.isFinite(n)) state.faders[b.id] = Math.max(0, Math.min(100, Math.round(n)));
        }));
      }
    }
  }
  await Promise.all(jobs);
  return state;
}

export function createState(getCfg: () => PadConfig, getRev: () => string) {
  let cache: { rev: string; at: number; value: Promise<PadState> } | null = null;
  return {
    get(): Promise<PadState> {
      const rev = getRev();
      if (cache && cache.rev === rev && Date.now() - cache.at < TTL_MS) return cache.value;
      cache = { rev, at: Date.now(), value: compute(getCfg()) };
      return cache.value;
    },
    // After an action the state has changed: the next read must be fresh.
    invalidate() {
      cache = null;
    },
  };
}
