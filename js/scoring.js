// Pose similarity: compares limb DIRECTIONS (not positions), so body size,
// distance from the camera and where you stand in the frame don't matter.

import { J } from './pose.js';

const SEGMENTS = [
  { a: 'lSh', b: 'lEl', w: 1.0, limb: 'lArm' },
  { a: 'lEl', b: 'lWr', w: 0.9, limb: 'lArm' },
  { a: 'rSh', b: 'rEl', w: 1.0, limb: 'rArm' },
  { a: 'rEl', b: 'rWr', w: 0.9, limb: 'rArm' },
  { a: 'lHip', b: 'lKn', w: 0.55, limb: 'lLeg', leg: true },
  { a: 'lKn', b: 'lAn', w: 0.45, limb: 'lLeg', leg: true },
  { a: 'rHip', b: 'rKn', w: 0.55, limb: 'rLeg', leg: true },
  { a: 'rKn', b: 'rAn', w: 0.45, limb: 'rLeg', leg: true },
  { a: 'hipMid', b: 'shMid', w: 0.6, limb: 'torso' },
];
export const LIMBS = ['lArm', 'rArm', 'lLeg', 'rLeg', 'torso'];

// Degrees of slack before a segment starts losing points, and the range over which it drops to 0.
export const DIFFICULTY = {
  easy: { free: 26, range: 70, perfect: 0.76, good: 0.6, ok: 0.42 },
  normal: { free: 18, range: 58, perfect: 0.82, good: 0.66, ok: 0.48 },
  hard: { free: 12, range: 46, perfect: 0.87, good: 0.72, ok: 0.55 },
};

function pt(pose, name) {
  if (name === 'hipMid') return [(pose[J.lHip * 2] + pose[J.rHip * 2]) / 2, (pose[J.lHip * 2 + 1] + pose[J.rHip * 2 + 1]) / 2];
  if (name === 'shMid') return [(pose[J.lSh * 2] + pose[J.rSh * 2]) / 2, (pose[J.lSh * 2 + 1] + pose[J.rSh * 2 + 1]) / 2];
  return [pose[J[name] * 2], pose[J[name] * 2 + 1]];
}

function angleOf(pose, seg) {
  const a = pt(pose, seg.a), b = pt(pose, seg.b);
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/**
 * @returns {{ total:number, limbs:Record<string,number> }} scores in 0..1
 */
export function comparePoses(user, target, { useLegs = false, difficulty = 'normal' } = {}) {
  const d = DIFFICULTY[difficulty];
  const free = (d.free * Math.PI) / 180, range = (d.range * Math.PI) / 180;
  const limbSum = {}, limbW = {};
  let sum = 0, wsum = 0;
  for (const seg of SEGMENTS) {
    if (seg.leg && !useLegs) continue;
    let diff = Math.abs(angleOf(user, seg) - angleOf(target, seg));
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    const s = Math.max(0, Math.min(1, 1 - (diff - free) / range));
    sum += s * seg.w;
    wsum += seg.w;
    limbSum[seg.limb] = (limbSum[seg.limb] ?? 0) + s * seg.w;
    limbW[seg.limb] = (limbW[seg.limb] ?? 0) + seg.w;
  }
  const limbs = {};
  for (const l of LIMBS) limbs[l] = limbW[l] ? limbSum[l] / limbW[l] : null;
  return { total: wsum ? sum / wsum : 0, limbs };
}

/**
 * People follow a video with a reaction delay, so compare against the target
 * over the last ~half second and keep the best match.
 */
export function compareWithLag(user, choreo, t, opts, lags = [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
  let best = null;
  for (const lag of lags) {
    const target = choreo.poseAt(t - lag);
    if (!target) continue;
    const useLegs = opts.useLegs && choreo.legsAt(t - lag);
    const r = comparePoses(user, target, { ...opts, useLegs });
    if (!best || r.total > best.total) best = { ...r, target, lag };
  }
  return best;
}

export function judge(sim, difficulty) {
  const d = DIFFICULTY[difficulty];
  if (sim >= d.perfect) return 'perfect';
  if (sim >= d.good) return 'good';
  if (sim >= d.ok) return 'ok';
  return 'miss';
}
