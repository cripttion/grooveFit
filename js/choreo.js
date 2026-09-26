// Choreography = a timeline of target poses (continuous "ghost") plus a list of
// key moves (the pictograms you get judged on). It comes from either the
// built-in demo routine or from analyzing a dance video with MediaPipe.

import { JOINTS, toBody, bodyToPose } from './pose.js';
import { comparePoses } from './scoring.js';

export class Choreography {
  constructor({ name, source, dt, start = 0, frames, legs, moves, bpm = null, raw = null, aspect = 16 / 9, videoId = null }) {
    // raw: per-frame landmark positions in normalized video coords (for drawing tracking on the video)
    Object.assign(this, { name, source, dt, start, frames, bpm, raw, aspect, videoId });
    this.legs = legs ?? new Uint8Array(frames.length).fill(1);
    this.moves = moves; // [{ t, name, pose }]
  }
  get end() { return this.start + this.frames.length * this.dt; }

  poseAt(t) {
    const f = (t - this.start) / this.dt;
    const i = Math.floor(f);
    const a = this.frames[i], b = this.frames[i + 1];
    if (!a) return b ?? null;
    if (!b) return a;
    const k = f - i, out = new Float32Array(a.length);
    for (let j = 0; j < a.length; j++) out[j] = a[j] + (b[j] - a[j]) * k;
    return out;
  }
  rawAt(t) {
    if (!this.raw) return null;
    const i = Math.round((t - this.start) / this.dt);
    return this.raw[i] ?? null;
  }
  legsAt(t) {
    const i = Math.round((t - this.start) / this.dt);
    return !!this.legs[Math.max(0, Math.min(this.legs.length - 1, i))];
  }
  /** The move you should currently be doing (latest move whose time has come). */
  currentMove(t) {
    let cur = null;
    for (const m of this.moves) { if (m.t <= t + 0.25) cur = m; else break; }
    return cur;
  }
}

/* ───────────────────────── Demo routine ───────────────────────── */

// Angles in degrees: 0 = screen-right, 90 = up, 180 = screen-left, -90 = down.
// ua/fa = upper arm/forearm, th/sh = thigh/shin, lean = torso tilt (+ = toward screen-left).
const STAND_LEGS = { lth: -96, lsh: -92, rth: -84, rsh: -88 };
const WIDE_LEGS = { lth: -112, lsh: -104, rth: -68, rsh: -76 };
const SPECS = {
  stand: { name: 'Ready', lua: -100, lfa: -95, rua: -80, rfa: -85, ...STAND_LEGS },
  victory: { name: 'Victory V', lua: 118, lfa: 116, rua: 62, rfa: 64, ...STAND_LEGS },
  airplane: { name: 'Airplane', lua: 178, lfa: 180, rua: 2, rfa: 0, ...WIDE_LEGS },
  star: { name: 'Star Jump', lua: 140, lfa: 140, rua: 40, rfa: 40, lth: -118, lsh: -118, rth: -62, rsh: -62 },
  discoL: { name: 'Disco Point', lua: 135, lfa: 135, rua: -55, rfa: -160, lth: -100, lsh: -95, rth: -76, rsh: -90 },
  flex: { name: 'Muscle Flex', lua: 178, lfa: 92, rua: 2, rfa: 88, ...WIDE_LEGS },
  roof: { name: 'Raise The Roof', lua: 155, lfa: 80, rua: 25, rfa: 100, ...STAND_LEGS },
  punchL: { name: 'Punch Out', lua: 178, lfa: 180, rua: -70, rfa: 115, ...WIDE_LEGS },
  clapKneeR: { name: 'Clap & Knee', lua: 110, lfa: 45, rua: 70, rfa: 135, lth: -94, lsh: -92, rth: -65, rthLen: 0.4, rsh: -95 },
  lungeL: { name: 'Lunge Reach', lua: 150, lfa: 152, rua: -60, rfa: -62, lean: 10, lth: -138, lsh: -98, rth: -62, rsh: -64 },
  reachL: { name: 'Side Reach', lua: 160, lfa: 156, rua: 112, rfa: 150, lean: 16, ...STAND_LEGS },
  hips: { name: 'Hands On Hips', lua: -130, lfa: -20, rua: -50, rfa: -160, ...WIDE_LEGS },
  wave: { name: 'Wave It', lua: -100, lfa: -95, rua: 30, rfa: 80, lth: -100, lsh: -94, rth: -80, rsh: -86 },
};

function mirrorSpec(s, name) {
  const m = (a) => (a === undefined ? undefined : 180 - a);
  return {
    name, lean: -(s.lean ?? 0),
    lua: m(s.rua), lfa: m(s.rfa), rua: m(s.lua), rfa: m(s.lfa),
    lth: m(s.rth), lsh: m(s.rsh), rth: m(s.lth), rsh: m(s.lsh),
    lthLen: s.rthLen, rthLen: s.lthLen,
  };
}
SPECS.discoR = mirrorSpec(SPECS.discoL, 'Disco Point');
SPECS.punchR = mirrorSpec(SPECS.punchL, 'Punch Out');
SPECS.clapKneeL = mirrorSpec(SPECS.clapKneeR, 'Clap & Knee');
SPECS.lungeR = mirrorSpec(SPECS.lungeL, 'Lunge Reach');
SPECS.reachR = mirrorSpec(SPECS.reachL, 'Side Reach');
SPECS.waveL = mirrorSpec(SPECS.wave, 'Wave It');

const D = Math.PI / 180;
export function poseFromSpec(s) {
  const lean = (s.lean ?? 0) * D;
  const up = [-Math.sin(lean), Math.cos(lean)];
  const right = [up[1], -up[0]];
  const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
  const limb = (from, deg, len) => [from[0] + Math.cos(deg * D) * len, from[1] + Math.sin(deg * D) * len];
  const sh = up;
  const lSh = add(sh, right, -0.36), rSh = add(sh, right, 0.36);
  const head = add(sh, up, 0.42);
  const lHip = [-0.2, 0], rHip = [0.2, 0];
  const lEl = limb(lSh, s.lua, 0.58), lWr = limb(lEl, s.lfa, 0.5);
  const rEl = limb(rSh, s.rua, 0.58), rWr = limb(rEl, s.rfa, 0.5);
  const lKn = limb(lHip, s.lth, s.lthLen ?? 0.85), lAn = limb(lKn, s.lsh, 0.8);
  const rKn = limb(rHip, s.rth, s.rthLen ?? 0.85), rAn = limb(rKn, s.rsh, 0.8);
  const pts = { head, lSh, rSh, lEl, rEl, lWr, rWr, lHip, rHip, lKn, rKn, lAn, rAn };
  const out = new Float32Array(JOINTS.length * 2);
  JOINTS.forEach((n, i) => { out[i * 2] = pts[n][0]; out[i * 2 + 1] = pts[n][1]; });
  return out;
}

export const TEMPLATES = Object.entries(SPECS).map(([key, s]) => ({ key, name: s.name, pose: poseFromSpec(s) }));

const ROUTINE = [
  'victory', 'hips', 'discoL', 'discoR', 'airplane', 'flex', 'star', 'victory',
  'punchL', 'punchR', 'roof', 'clapKneeR', 'clapKneeL', 'lungeL', 'lungeR', 'star',
  'reachL', 'reachR', 'wave', 'waveL', 'discoL', 'flex', 'roof', 'airplane',
  'punchR', 'punchL', 'clapKneeL', 'clapKneeR', 'star', 'lungeR', 'lungeL', 'victory',
];

export function buildDemoRoutine({ bpm = 128, duration = 180, beatsPerMove = 4, intro = null } = {}) {
  const beat = 60 / bpm, moveLen = beat * beatsPerMove, dt = 1 / 30;
  intro ??= moveLen; // first move lands on a downbeat
  const moves = [];
  for (let t = intro, i = 0; t < duration - 0.5; t += moveLen, i++) {
    const key = ROUTINE[i % ROUTINE.length];
    moves.push({ t, name: SPECS[key].name, pose: poseFromSpec(SPECS[key]) });
  }
  const standPose = poseFromSpec(SPECS.stand);
  const frames = [];
  const trans = Math.min(0.55, moveLen * 0.35); // seconds spent blending into the next move
  for (let t = 0; t < duration; t += dt) {
    let idx = -1;
    for (let i = 0; i < moves.length && moves[i].t <= t; i++) idx = i;
    const cur = idx < 0 ? standPose : moves[idx].pose;
    const next = moves[idx + 1];
    let pose = cur;
    if (next && t > next.t - trans) {
      const k = smooth((t - (next.t - trans)) / trans);
      pose = lerpPose(cur, next.pose, k);
    }
    frames.push(pose);
  }
  return new Choreography({ name: 'Quick Groove', source: 'demo', dt, frames, moves, bpm });
}

/* ───────────────────────── Learn from a video ───────────────────────── */

// Landmarks kept (x, y, visibility) for the tracking overlay on the reference video.
export const RAW_IDX = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export async function analyzeVideo(url, landmarker, { fps = 8, from = 0, to = Infinity, name = 'Video', onProgress, onFrame, signal } = {}) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await waitFor(v, 'loadedmetadata', 15000);
  const end = Math.min(v.duration, to || Infinity);
  const start = Math.min(from, Math.max(0, end - 1));
  const dt = 1 / fps;
  const n = Math.max(1, Math.floor((end - start) / dt));
  const aspect = v.videoWidth / v.videoHeight;
  const frames = new Array(n).fill(null);
  const raw = new Array(n).fill(null);
  const legs = new Uint8Array(n);
  const tsBase = performance.now();

  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const t = start + i * dt;
    v.currentTime = t;
    await waitFor(v, 'seeked', 4000).catch(() => {});
    const lms = landmarker.detect(v, tsBase + t * 1000);
    const body = toBody(lms, aspect, false);
    if (body && body.upperVisible) {
      frames[i] = bodyToPose(body);
      legs[i] = body.legsVisible ? 1 : 0;
      raw[i] = Float32Array.from(RAW_IDX.flatMap((k) => [lms[k].x, lms[k].y, lms[k].visibility ?? 1]));
    }
    onFrame?.(v, lms, i);
    onProgress?.((i + 1) / n, t);
  }
  v.removeAttribute('src'); v.load();

  fillGaps(frames, 6);
  smoothFrames(frames);
  const moves = pickMoves(frames, dt, start);
  return new Choreography({ name, source: 'video', dt, start, frames, legs, moves, raw, aspect });
}

function fillGaps(frames, maxGap) {
  let last = -1;
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i]) continue;
    const gap = i - last - 1;
    if (last >= 0 && gap > 0 && gap <= maxGap) {
      for (let g = 1; g <= gap; g++) frames[last + g] = lerpPose(frames[last], frames[i], g / (gap + 1));
    }
    last = i;
  }
}

function smoothFrames(frames) {
  const src = frames.slice();
  for (let i = 1; i < frames.length - 1; i++) {
    const a = src[i - 1], b = src[i], c = src[i + 1];
    if (!a || !b || !c) continue;
    const out = new Float32Array(b.length);
    for (let j = 0; j < b.length; j++) out[j] = a[j] * 0.25 + b[j] * 0.5 + c[j] * 0.25;
    frames[i] = out;
  }
}

/**
 * One key move per window: the most expressive pose (furthest from just standing)
 * that the dancer actually holds for a moment (low motion).
 */
export function pickMoves(frames, dt, start, every = 2.0) {
  const per = Math.round(every / dt), moves = [];
  const stand = TEMPLATES.find((t) => t.key === 'stand').pose;
  const motion = frames.map((f, i) => {
    const p = frames[i - 1], nx = frames[i + 1];
    if (!f || !p || !nx) return Infinity;
    let m = 0;
    for (let j = 0; j < f.length; j++) m += Math.abs(nx[j] - p[j]);
    return m;
  });
  for (let w = 0; w + per <= frames.length; w += per) {
    let best = -1, bestScore = -Infinity;
    for (let i = w; i < w + per; i++) {
      if (!frames[i] || motion[i] === Infinity) continue;
      const expressive = 1 - comparePoses(frames[i], stand, { useLegs: true }).total;
      const score = expressive - 0.06 * motion[i];
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) continue;
    moves.push({ t: start + best * dt, pose: frames[best], name: nameFor(frames[best]) });
  }
  return moves;
}

export function repickMoves(c) { c.moves = pickMoves(c.frames, c.dt, c.start); return c; }

/** Name a pose from what the body is doing (falls back to the closest built-in move). */
function nameFor(pose) {
  const P = (n) => [pose[JOINTS.indexOf(n) * 2], pose[JOINTS.indexOf(n) * 2 + 1]];
  const head = P('head'), lW = P('lWr'), rW = P('rWr'), lK = P('lKn'), rK = P('rKn'), lA = P('lAn'), rA = P('rAn');
  const lS = P('lSh'), rS = P('rSh');
  const lean = (lS[0] + rS[0]) / 2;
  if (lK[1] > -0.5 || rK[1] > -0.5) return 'Knee Lift';
  if (lW[1] > head[1] && rW[1] > head[1]) return Math.abs(lean) > 0.22 ? 'Side Stretch' : 'Hands Up';
  if (Math.abs(lean) > 0.25) return 'Side Bend';
  if (lW[1] > head[1] || rW[1] > head[1]) return 'Reach Up';
  if (Math.abs(lA[0] - rA[0]) > 1.25 && (lK[1] > -0.7 || rK[1] > -0.7)) return 'Lunge';
  if (lW[0] < -1.05 && rW[0] > 1.05) return 'Wide Arms';
  if (lW[0] < -1.05 || rW[0] > 1.05) return 'Side Punch';
  if (Math.abs(lA[0] - rA[0]) > 1.2) return 'Wide Step';
  if (Math.abs(lW[0]) < 0.45 && Math.abs(rW[0]) < 0.45 && lW[1] > 0.5 && rW[1] > 0.5) return 'Guard Up';
  return templateName(pose);
}

function templateName(pose) {
  let best = null;
  for (const tpl of TEMPLATES) {
    const s = comparePoses(pose, tpl.pose).total;
    if (!best || s > best.s) best = { s, name: tpl.name };
  }
  return best && best.s > 0.72 ? best.name : 'Groove';
}

/* ───────────────────────── Save / load ───────────────────────── */

export function choreoToJSON(c) {
  const q = (f) => (f ? Array.from(f, (x) => Math.round(x * 1000) / 1000) : null);
  return {
    format: 'groovefit-choreo', version: 1,
    name: c.name, source: c.source, dt: c.dt, start: c.start, bpm: c.bpm, aspect: c.aspect, videoId: c.videoId,
    frames: c.frames.map(q), legs: Array.from(c.legs), raw: c.raw ? c.raw.map(q) : null,
    moves: c.moves.map((m) => ({ t: Math.round(m.t * 1000) / 1000, name: m.name, pose: q(m.pose) })),
  };
}

export function choreoFromJSON(o) {
  if (o?.format !== 'groovefit-choreo') throw new Error('Not a Groove Fit choreography file');
  const f = (a) => (a ? Float32Array.from(a) : null);
  return new Choreography({
    name: o.name, source: o.source, dt: o.dt, start: o.start, bpm: o.bpm, aspect: o.aspect ?? 16 / 9, videoId: o.videoId ?? null,
    frames: o.frames.map(f), legs: Uint8Array.from(o.legs), raw: o.raw ? o.raw.map(f) : null,
    moves: o.moves.map((m) => ({ t: m.t, name: m.name, pose: f(m.pose) })),
  });
}

/* ───────────────────────── helpers ───────────────────────── */

export function lerpPose(a, b, k) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
}
function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }

function waitFor(el, ev, timeout) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${ev}`)); }, timeout);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('Could not read this video file')); };
    const cleanup = () => { clearTimeout(tid); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}
