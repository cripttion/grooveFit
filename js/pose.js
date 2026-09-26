// MediaPipe pose tracking + conversion into a camera-independent "canonical" body.
//
// Canonical space: origin at the hip midpoint, y up, 1 unit = torso length
// (hip-mid → shoulder-mid). Joints are named by the SIDE OF THE SCREEN they
// appear on ("l" = screen-left), not anatomical side. That makes "mirror the
// dancer" matching trivial: the user's selfie view and the dancer's video are
// both converted so the same screen side lines up.

import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm';
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

// Joints used for scoring and silhouettes, in storage order (x,y pairs).
export const JOINTS = ['head', 'lSh', 'rSh', 'lEl', 'rEl', 'lWr', 'rWr', 'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn'];
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i]));

// [anatomical-left index, anatomical-right index] in MediaPipe's 33-landmark model.
const PAIRS = {
  Sh: [11, 12], El: [13, 14], Wr: [15, 16], Hip: [23, 24], Kn: [25, 26], An: [27, 28],
  Ear: [7, 8], Heel: [29, 30], Toe: [31, 32], Pinky: [17, 18], Index: [19, 20],
};

let fileset = null;

export async function createLandmarker(variant = 'lite') {
  fileset ??= await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODELS[variant], delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let lm;
  try {
    lm = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch (e) {
    console.warn('GPU delegate unavailable, using CPU', e);
    lm = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  // detectForVideo needs strictly increasing timestamps per instance.
  let lastTs = 0;
  return {
    detect(source, ts) {
      ts = Math.max(Math.round(ts), lastTs + 1);
      lastTs = ts;
      const res = lm.detectForVideo(source, ts);
      return res.landmarks?.[0] ?? null;
    },
    close: () => lm.close(),
  };
}

/**
 * Convert 33 normalized landmarks into a canonical Body.
 * @param lms      MediaPipe normalized landmarks
 * @param aspect   source width / height
 * @param mirrored true for the selfie camera (flip X so it reads like a mirror)
 */
export function toBody(lms, aspect, mirrored) {
  if (!lms) return null;
  const raw = (i) => {
    const l = lms[i];
    return [(mirrored ? 1 - l.x : l.x) * aspect, -l.y, -l.z * aspect];
  };
  const vis = (i) => lms[i].visibility ?? 1;
  const inFrame = (i) => lms[i].y > -0.02 && lms[i].y < 1.02 && lms[i].x > -0.02 && lms[i].x < 1.02;
  // Mirrored selfie: anatomical left shows on screen-left. Plain video of a
  // person facing the camera: their right shows on screen-left.
  const s = mirrored ? 0 : 1;
  const L = (k) => PAIRS[k][s];
  const R = (k) => PAIRS[k][1 - s];

  const lHip = raw(L('Hip')), rHip = raw(R('Hip'));
  const lSh = raw(L('Sh')), rSh = raw(R('Sh'));
  const hip = mid(lHip, rHip), sh = mid(lSh, rSh);
  const torso = Math.hypot(sh[0] - hip[0], sh[1] - hip[1]);
  if (torso < 1e-3) return null;
  const n = (p) => [(p[0] - hip[0]) / torso, (p[1] - hip[1]) / torso, (p[2] - hip[2]) / torso];

  const ears = mid(raw(PAIRS.Ear[0]), raw(PAIRS.Ear[1]));
  const nose = raw(0);
  const p = {
    head: n(ears),
    nose: n(nose),
    lEar: n(raw(L('Ear'))), rEar: n(raw(R('Ear'))),
    lSh: n(lSh), rSh: n(rSh),
    lEl: n(raw(L('El'))), rEl: n(raw(R('El'))),
    lWr: n(raw(L('Wr'))), rWr: n(raw(R('Wr'))),
    lHand: n(mid(raw(L('Pinky')), raw(L('Index')))), rHand: n(mid(raw(R('Pinky')), raw(R('Index')))),
    lHip: n(lHip), rHip: n(rHip),
    lKn: n(raw(L('Kn'))), rKn: n(raw(R('Kn'))),
    lAn: n(raw(L('An'))), rAn: n(raw(R('An'))),
    lToe: n(raw(L('Toe'))), rToe: n(raw(R('Toe'))),
  };
  const legIdx = [25, 26, 27, 28];
  const armIdx = [13, 14, 15, 16];
  return {
    p,
    torso,
    hipScreen: hip, // un-normalized hip position (source-height units), for motion tracking
    legsVisible: legIdx.every((i) => vis(i) > 0.5 && inFrame(i)),
    armsVisible: armIdx.every((i) => vis(i) > 0.35),
    upperVisible: [0, 11, 12].every((i) => vis(i) > 0.5 && inFrame(i)),
  };
}

/** Flatten a Body into the compact pose vector used for scoring/silhouettes. */
export function bodyToPose(body) {
  const out = new Float32Array(JOINTS.length * 2);
  JOINTS.forEach((name, i) => {
    out[i * 2] = body.p[name][0];
    out[i * 2 + 1] = body.p[name][1];
  });
  return out;
}

/** Build a Body (with z = 0) from a pose vector — used by the auto-dancer. */
export function poseToBody(pose) {
  const p = {};
  JOINTS.forEach((name, i) => { p[name] = [pose[i * 2], pose[i * 2 + 1], 0]; });
  const hand = (el, wr) => [wr[0] + (wr[0] - el[0]) * 0.25, wr[1] + (wr[1] - el[1]) * 0.25, 0];
  p.lHand = hand(p.lEl, p.lWr);
  p.rHand = hand(p.rEl, p.rWr);
  p.nose = [p.head[0], p.head[1] - 0.08, 0.2];
  p.lEar = [p.head[0] - 0.15, p.head[1], 0];
  p.rEar = [p.head[0] + 0.15, p.head[1], 0];
  p.lToe = [p.lAn[0] - 0.05, p.lAn[1] - 0.08, 0.25];
  p.rToe = [p.rAn[0] + 0.05, p.rAn[1] - 0.08, 0.25];
  return { p, legsVisible: true, armsVisible: true, upperVisible: true };
}

/** Speed-adaptive exponential smoothing (a light One-Euro-style filter). */
export class BodySmoother {
  constructor() { this.prev = null; }
  reset() { this.prev = null; }
  push(body) {
    if (!body) return this.prev ? { ...this.prev, stale: true } : null;
    if (!this.prev) { this.prev = clone(body); return this.prev; }
    const out = { ...body, p: {} };
    for (const k in body.p) {
      const a = this.prev.p[k], b = body.p[k];
      const speed = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const alpha = Math.min(0.9, 0.3 + speed * 3);
      out.p[k] = [a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, a[2] + (b[2] - a[2]) * 0.3];
    }
    this.prev = out;
    return out;
  }
}

function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }
function clone(body) {
  const p = {};
  for (const k in body.p) p[k] = body.p[k].slice();
  return { ...body, p };
}
