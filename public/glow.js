// Ambient glow ("Ambilight"): soft coloured light at the pad's edges that follows the Mac's system audio.
// Bass lights the bottom (magenta), mids the sides (cyan), highs the top (violet). The band levels come from
// the visualizer's stream (viz.js); a requestAnimationFrame loop eases toward them (fast attack, slow release),
// so the light moves smoothly between the ~20 frames/s the server sends. Light is a few static radial gradients:
// only opacity and transform change (no blur filter, which is too heavy for a weak tablet). The loop sleeps
// while everything is dark, so a silent Mac costs nothing.
import { subscribeViz } from "/assets/viz.js";

const SPLIT = [0.125, 0.5]; // bass: first 1/8 of the bands, mids: up to 1/2, highs: the rest
// The helper's levels are already normalised and sit high and flat for most music (0.5–0.85 across the
// spectrum), so the absolute level hardly moves. What the eye wants is the beat: each zone is rescaled
// against its own recent floor and ceiling, which drift toward the signal.
const TRACK = 0.02; // per frame (~20/s): floor and ceiling follow the signal in about 2.5 s
const MIN_RANGE = 0.1; // do not amplify noise when the music is steady
const GATE = 0.08; // below this absolute energy a zone counts as silent
const BASE = 0.2; // share of the brightness that stays while sound plays; the rest follows the beat
const CURVE = 1.5; // above 1: only real peaks reach full brightness
const ATTACK_S = 0.04; // time constants of the easing
const RELEASE_S = 0.22;
const STALE_MS = 700; // no frame for this long (silence, Mac asleep): fade out

let root = null;
let parts = null; // { bass, left, right, treble }
let unsubscribe = null;
let raf = 0;
let last = 0;
let lastFrame = -Infinity;
const target = [0, 0, 0];
const level = [0, 0, 0];
const floor = [1, 1, 1];
const ceil = [0, 0, 0];

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

// Average and peak of a slice, mixed: the average alone hides a lone strong bin, the peak alone flickers.
function energy(values, from, to) {
  let sum = 0;
  let peak = 0;
  for (let i = from; i < to; i++) {
    const v = clamp01(values[i]);
    sum += v;
    if (v > peak) peak = v;
  }
  const n = Math.max(1, to - from);
  return 0.5 * (sum / n) + 0.5 * peak;
}

function onFrame(values) {
  const n = values.length;
  if (!n) return;
  const a = Math.max(1, Math.round(n * SPLIT[0]));
  const b = Math.max(a + 1, Math.round(n * SPLIT[1]));
  const cuts = [[0, a], [a, b], [b, n]];
  for (let i = 0; i < 3; i++) {
    const e = energy(values, cuts[i][0], Math.max(cuts[i][0] + 1, cuts[i][1]));
    ceil[i] = e > ceil[i] ? e : ceil[i] + (e - ceil[i]) * TRACK;
    floor[i] = e < floor[i] ? e : floor[i] + (e - floor[i]) * TRACK;
    const beat = clamp01((e - floor[i]) / Math.max(MIN_RANGE, ceil[i] - floor[i]));
    target[i] = clamp01(e / GATE) * (BASE + (1 - BASE) * Math.pow(beat, CURVE));
  }
  lastFrame = performance.now();
  if (!raf) {
    last = lastFrame;
    raf = requestAnimationFrame(tick);
  }
}

function paint(el, lv, axis) {
  el.style.opacity = (lv * 0.95).toFixed(3);
  el.style.transform = axis === "y" ? `scale3d(1, ${(0.7 + 0.3 * lv).toFixed(3)}, 1)` : `scale3d(${(0.7 + 0.3 * lv).toFixed(3)}, 1, 1)`;
}

function tick(now) {
  raf = 0;
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  const fresh = now - lastFrame < STALE_MS;
  let moving = false;
  for (let i = 0; i < 3; i++) {
    const goal = fresh ? target[i] : 0;
    const tau = goal > level[i] ? ATTACK_S : RELEASE_S;
    level[i] += (goal - level[i]) * (1 - Math.exp(-dt / tau));
    if (!goal && level[i] < 0.004) level[i] = 0;
    else moving = true;
  }
  if (parts) {
    paint(parts.bass, level[0], "y");
    paint(parts.left, level[1], "x");
    paint(parts.right, level[1], "x");
    paint(parts.treble, level[2], "y");
  }
  if (moving) raf = requestAnimationFrame(tick);
}

function build() {
  const mk = (cls) => Object.assign(document.createElement("i"), { className: cls });
  parts = { bass: mk("gl-b"), left: mk("gl-l"), right: mk("gl-r"), treble: mk("gl-t") };
  root = document.createElement("div");
  root.className = "glow";
  root.setAttribute("aria-hidden", "true");
  root.append(parts.bass, parts.left, parts.right, parts.treble);
  document.body.append(root);
}

// Idempotent: the pad calls it on every config load and on the toggle.
export function setGlow(on) {
  if (on === !!unsubscribe) return;
  if (on) {
    build();
    unsubscribe = subscribeViz(onFrame);
    return;
  }
  unsubscribe();
  unsubscribe = null;
  cancelAnimationFrame(raf);
  raf = 0;
  root?.remove();
  root = parts = null;
  target.fill(0);
  level.fill(0);
  floor.fill(1);
  ceil.fill(0);
}
