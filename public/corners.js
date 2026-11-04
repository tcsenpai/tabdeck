// "Mic corners": only the pad's four corners react to noise, like the lights of a mechanical keyboard.
// Two sources, chosen per tablet:
//  - "tablet": this tablet's own microphone, analysed right here in the browser (nothing is sent anywhere).
//    Browsers only offer the microphone in a secure context (https or localhost), so over plain
//    http://<LAN-IP> it needs Chrome's "unsafely treat insecure origin as secure" flag for the pad's address.
//  - "mac": the Mac's microphone, analysed on the Mac; the server streams two numbers per frame, never audio.
// Either way the frames are [level, onset]. An onset (a key click, a tap, a clap) lights the next corner in
// turn; the level adds a faint steady glow. Light is a static radial gradient per corner; only opacity and
// transform change (no blur filter), and the animation loop sleeps while all corners are dark.
const COLORS = ["var(--accent)", "var(--magenta)", "#8a5cff", "var(--accent)"]; // TL, TR, BR, BL
const ONSET_MIN = 0.15; // ignore faint onsets (room noise)
const DECAY_S = 0.28; // a flash fades out in about this long
const LEVEL_GLOW = 0.18; // steady glow share driven by the level
const STALE_MS = 1500; // no frame for this long: fade out

let root = null;
let corners = [];
let mode = ""; // "" | "tablet" | "mac"
let source = null; // EventSource (mac)
let mic = null; // { stream, ctx, timer } (tablet)
let raf = 0;
let last = 0;
let lastFrame = -Infinity;
let next = 0; // the corner that gets the next flash
let base = 0; // eased level
let levelNow = 0;
// Sensitivity 0–100 (50 = normal) becomes a gain of 0.1 … 1 … 10 applied to what the microphone hears.
let gain = 1;
export function setSensitivity(s) {
  gain = Math.pow(10, (clamp01Num(s, 50) - 50) / 50);
}
function clamp01Num(v, d) {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : d;
}
const flash = [0, 0, 0, 0];
// Anything else that wants the microphone frames (the sound-reactive decoration tiles): fn(level, onset), both 0..1.
const listeners = new Set();
export function subscribeMic(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

function onFrame(values, applyGain = true) {
  if (!Array.isArray(values)) return;
  const g = applyGain ? gain : 1; // the tablet's own analysis has already applied it
  levelNow = clamp01(values[0] * g);
  const onset = clamp01(values[1] * g);
  lastFrame = performance.now();
  for (const fn of listeners) fn(levelNow, onset);
  if (!root) return; // only the listeners are using the microphone
  if (onset >= ONSET_MIN) {
    flash[next] = Math.max(flash[next], 0.35 + 0.65 * onset);
    next = (next + 1) % 4;
  }
  if (!raf) {
    last = lastFrame;
    raf = requestAnimationFrame(tick);
  }
}

// Shows or hides the four corner lights; the microphone itself is switched with setCorners().
export function setCornersVisible(on) {
  if (on === !!root) return;
  if (on) return build();
  cancelAnimationFrame(raf);
  raf = 0;
  root.remove();
  root = null;
  corners = [];
  flash.fill(0);
  base = 0;
}

function tick(now) {
  raf = 0;
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  const fresh = now - lastFrame < STALE_MS;
  const goal = fresh ? levelNow * LEVEL_GLOW : 0;
  base += (goal - base) * (1 - Math.exp(-dt / 0.15));
  let moving = base > 0.004;
  for (let i = 0; i < 4; i++) {
    flash[i] = Math.max(0, flash[i] - dt / DECAY_S);
    const v = Math.min(1, flash[i] + base);
    if (v > 0.004) moving = true;
    const el = corners[i];
    if (el) {
      el.style.opacity = v.toFixed(3);
      el.style.transform = `scale3d(${(0.75 + 0.25 * v).toFixed(3)}, ${(0.75 + 0.25 * v).toFixed(3)}, 1)`;
    }
  }
  if (moving) raf = requestAnimationFrame(tick);
}

function build() {
  root = document.createElement("div");
  root.className = "corners";
  root.setAttribute("aria-hidden", "true");
  corners = COLORS.map((c, i) => {
    const el = document.createElement("i");
    el.className = `cn cn-${i}`;
    el.style.setProperty("--cn", c);
    return el;
  });
  root.append(...corners);
  document.body.append(root);
}

// ── Mac microphone: two numbers per frame from the server ──
function openMac() {
  if (mode !== "mac" || source || document.hidden || typeof EventSource === "undefined") return;
  source = new EventSource("/api/mic"); // reconnects by itself
  source.onmessage = (e) => {
    try {
      onFrame(JSON.parse(e.data));
    } catch {}
  };
}
function closeMac() {
  source?.close();
  source = null;
}

// ── Tablet microphone: analysed locally ──
// Two analysers: the whole band for the level, and a high-passed copy (above ~2 kHz) for onsets, because a
// key click or a tap is a short broadband burst while speech and hum sit lower. An onset is a jump of the
// high band's energy over its slow running average.
const TICK_MS = 33;
const REFRACTORY_MS = 60;
const FLOOR = 0.004; // high-band RMS that still counts as silence

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

async function openTablet() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-mic-api");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2000;
  const full = ctx.createAnalyser();
  const high = ctx.createAnalyser();
  full.fftSize = high.fftSize = 512;
  src.connect(full);
  src.connect(hp);
  hp.connect(high);
  const fb = new Float32Array(full.fftSize);
  const hb = new Float32Array(high.fftSize);
  let avg = 0;
  let quietUntil = 0;
  const timer = setInterval(() => {
    if (document.hidden) return;
    full.getFloatTimeDomainData(fb);
    high.getFloatTimeDomainData(hb);
    const db = 20 * Math.log10(Math.max(1e-5, rms(fb)));
    const level = clamp01((db + 20 * Math.log10(gain) + 60) / 45); // -60..-15 dBFS, shifted by the gain
    const h = rms(hb) * gain; // the gain also lowers the silence floor, so a weak tablet microphone still triggers
    const now = performance.now();
    let onset = 0;
    if (now >= quietUntil && h > FLOOR && h > avg * 1.8 + FLOOR) {
      onset = clamp01((h - avg) / 0.08);
      quietUntil = now + REFRACTORY_MS;
    }
    avg += (h - avg) * 0.05;
    onFrame([level, onset], false);
  }, TICK_MS);
  mic = { stream, ctx, timer };
  if (mode !== "tablet") closeTablet(); // switched off while the permission prompt was open
}
function closeTablet() {
  if (!mic) return;
  clearInterval(mic.timer);
  for (const tr of mic.stream.getTracks()) tr.stop();
  mic.ctx.close().catch(() => {});
  mic = null;
}

// Switches the source: "" (off), "tablet" or "mac". Idempotent. `onError(code)` gets "no-mic-api" (insecure
// origin or no microphone) or "denied"; the corners are then switched off.
export async function setCorners(next_, onError = () => {}) {
  if (next_ === mode) return;
  closeMac();
  closeTablet();
  mode = next_;
  if (!mode) {
    levelNow = 0;
    // Let the sound-reactive tiles settle: a few empty frames, so peaks and speeds decay to rest.
    let n = 0;
    const settle = setInterval(() => {
      for (const fn of listeners) fn(0, 0);
      if (++n >= 15 || mode) clearInterval(settle);
    }, 50);
    return;
  }
  if (mode === "mac") return openMac();
  try {
    await openTablet();
  } catch (e) {
    const asked = mode; // the user may have switched meanwhile
    if (asked === "tablet") {
      await setCorners("");
      onError(e instanceof Error && e.message === "no-mic-api" ? "no-mic-api" : "denied");
    }
  }
}

// The Mac stream is only open while the tab is visible: the Mac stops listening shortly after.
document.addEventListener("visibilitychange", () => (document.hidden ? closeMac() : openMac()));
