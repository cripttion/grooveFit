// 2D layers: stage background, the target ghost silhouette, pictogram lane, particle FX.

import { J } from './pose.js';

// Stage camera: canonical body units (hip-centered, 1 = torso length) → pixels.
export const VIEW = { height: 4.9, centerY: -0.12, floorY: -1.78 };

/** Canonical (x,y) → stage pixel coordinates for a w×h canvas. */
export function makeProjector(w, h) {
  const s = h / VIEW.height;
  const fn = (x, y) => [w / 2 + x * s, h / 2 - (y - VIEW.centerY) * s];
  fn.unit = s;
  return fn;
}

const C = {
  green: '#3dff8b', yellow: '#ffd23d', red: '#ff4d5e', pink: '#ff3d9a', cyan: '#2ee6ff', white: '#f5f0ff', violet: '#8b5cff',
};
export const JUDGE_COLOR = { perfect: C.green, good: C.cyan, ok: C.yellow, miss: C.red };

// Widths in torso units.
const W = { ua: 0.44, fa: 0.38, th: 0.56, sn: 0.46, neck: 0.26, head: 0.42, hand: 0.19 };

function limbColor(score, idle) {
  if (score == null) return idle;
  if (score >= 0.72) return C.green;
  if (score >= 0.45) return C.yellow;
  return C.pink;
}

/**
 * Draw a filled figure for `pose` with pose → pixel mapping `map`.
 * colorFor(limb) chooses the color of each limb group.
 */
export function drawFigure(ctx, pose, map, unit, colorFor, { grow = 0, showLegs = true, torsoPad = 0, scale = 1 } = {}) {
  const P = (n) => map(pose[J[n] * 2], pose[J[n] * 2 + 1]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.lineCap = ctx.lineJoin = 'round';
  const seg = (a, b, w, limb) => {
    ctx.strokeStyle = colorFor(limb);
    ctx.lineWidth = w * scale * unit + grow;
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
  };
  const dot = (p, r, limb) => {
    ctx.fillStyle = colorFor(limb);
    ctx.beginPath(); ctx.arc(p[0], p[1], r * scale * unit + grow / 2, 0, Math.PI * 2); ctx.fill();
  };
  const lSh = P('lSh'), rSh = P('rSh'), lHip = P('lHip'), rHip = P('rHip'), head = P('head');
  if (showLegs) {
    seg(lHip, P('lKn'), W.th, 'lLeg'); seg(P('lKn'), P('lAn'), W.sn, 'lLeg');
    seg(rHip, P('rKn'), W.th, 'rLeg'); seg(P('rKn'), P('rAn'), W.sn, 'rLeg');
  }
  // torso
  ctx.fillStyle = ctx.strokeStyle = colorFor('torso');
  ctx.lineWidth = (0.3 + torsoPad) * unit + grow;
  ctx.beginPath(); ctx.moveTo(...lSh); ctx.lineTo(...rSh); ctx.lineTo(...rHip); ctx.lineTo(...lHip); ctx.closePath();
  ctx.fill(); ctx.stroke();
  seg(mid(lSh, rSh), head, W.neck, 'torso');
  dot(head, W.head, 'torso');
  // arms on top
  seg(lSh, P('lEl'), W.ua, 'lArm'); seg(P('lEl'), P('lWr'), W.fa, 'lArm');
  seg(rSh, P('rEl'), W.ua, 'rArm'); seg(P('rEl'), P('rWr'), W.fa, 'rArm');
  dot(P('lWr'), W.hand, 'lArm'); dot(P('rWr'), W.hand, 'rArm');
}

export class StageRenderer {
  constructor(bgCanvas, fxCanvas) {
    this.bg = bgCanvas; this.fx = fxCanvas;
    this.bctx = bgCanvas.getContext('2d');
    this.fctx = fxCanvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.octx = this.off.getContext('2d');
    this.particles = [];
    this.w = this.h = 1;
  }

  resize(w, h, dpr) {
    for (const c of [this.bg, this.fx, this.off]) { c.width = w * dpr; c.height = h * dpr; }
    this.dpr = dpr; this.w = w; this.h = h;
  }

  /**
   * @param o.target   pose vector for the ghost (or null)
   * @param o.limbs    per-limb similarity (or null when user isn't tracked)
   * @param o.match    overall match 0..1
   * @param o.beat     beat phase 0..1 (for pulsing lights)
   */
  drawBackground(map, o) {
    const ctx = this.bctx, { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = o.time;
    const pulse = Math.pow(1 - (o.beat ?? 0), 3);

    // spotlights
    const spots = [
      { x: w * 0.15, hue: o.fever ? (t * 120) % 360 : 320 },
      { x: w * 0.85, hue: o.fever ? (t * 120 + 180) % 360 : 190 },
    ];
    spots.forEach((s, i) => {
      const sway = Math.sin(t * 0.8 + i * 2) * w * 0.12;
      const g = ctx.createLinearGradient(s.x, 0, w / 2 + sway, h);
      g.addColorStop(0, `hsla(${s.hue},100%,65%,${0.22 + pulse * 0.12})`);
      g.addColorStop(1, `hsla(${s.hue},100%,65%,0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(s.x - 20, 0); ctx.lineTo(s.x + 20, 0);
      ctx.lineTo(w / 2 + sway + w * 0.16, h); ctx.lineTo(w / 2 + sway - w * 0.16, h);
      ctx.closePath(); ctx.fill();
    });

    // equalizer backdrop
    const bars = 28, bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = 0.25 + 0.75 * Math.abs(Math.sin(t * 2.3 + i * 0.7) * Math.cos(t * 1.1 + i * 0.3)) * (0.5 + pulse * 0.5);
      const bh = v * h * 0.22;
      ctx.fillStyle = `hsla(${o.fever ? (i * 13 + t * 90) % 360 : 270 + i * 2},90%,60%,0.10)`;
      ctx.fillRect(i * bw + 2, h * 0.62 - bh, bw - 4, bh);
    }

    // floor
    const [fx, fy] = map(0, VIEW.floorY);
    const fr = map.unit * 1.3;
    const matchCol = o.match >= 0.72 ? C.green : o.match >= 0.45 ? C.yellow : C.pink;
    const floorG = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr);
    floorG.addColorStop(0, 'rgba(139,92,255,0.45)');
    floorG.addColorStop(1, 'rgba(139,92,255,0)');
    ctx.fillStyle = floorG;
    ctx.beginPath(); ctx.ellipse(fx, fy, fr, fr * 0.22, 0, 0, Math.PI * 2); ctx.fill();
    for (let r = 0; r < 3; r++) {
      const k = ((t * 0.6 + r / 3) % 1);
      ctx.strokeStyle = o.userTracked ? hexA(matchCol, (1 - k) * 0.6) : `rgba(255,255,255,${(1 - k) * 0.25})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(fx, fy, fr * (0.4 + k * 0.8), fr * 0.22 * (0.4 + k * 0.8), 0, 0, Math.PI * 2); ctx.stroke();
    }

    if (o.target) this.drawGhost(map, o.target, o.limbs, o.match, o.showLegs, o.userTracked);
  }

  /** Target pose from the video: a soft, light ghost you step into. */
  drawGhost(map, pose, limbs, match, showLegs, userTracked) {
    const { octx, off, dpr, w, h } = this;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    const matched = userTracked && match >= 0.72;
    drawFigure(octx, pose, map, map.unit, () => (matched ? C.green : C.white), { grow: 8, showLegs, torsoPad: 0.18 });
    drawFigure(octx, pose, map, map.unit, () => (matched ? '#2c7a55' : '#4a3a80'), { showLegs, torsoPad: 0.18 });

    const ctx = this.bctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.shadowColor = matched ? C.green : 'rgba(255,255,255,0.5)';
    ctx.shadowBlur = 24 * dpr;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }

  /**
   * The player's own body: a dark silhouette with a neon outline. Each limb's
   * outline shows its match — green = on target, yellow = close, pink = off.
   */
  drawUser(map, pose, limbs, { showLegs = true, match = 0 } = {}) {
    if (!pose) return;
    const { dpr, w, h } = this;
    this.uoff ??= document.createElement('canvas');
    const off = this.uoff;
    if (off.width !== this.off.width || off.height !== this.off.height) { off.width = this.off.width; off.height = this.off.height; }
    const u = off.getContext('2d');
    u.setTransform(dpr, 0, 0, dpr, 0, 0);
    u.clearRect(0, 0, w, h);
    const matched = match >= 0.72;
    const opts = { showLegs, torsoPad: 0.1, scale: 0.9 };
    // pass 1: colored outline, pass 2: dark fill → a crisp outlined silhouette
    drawFigure(u, pose, map, map.unit, (limb) => limbColor(limbs?.[limb], C.white), { ...opts, grow: 10 });
    drawFigure(u, pose, map, map.unit, () => (matched ? '#123f2d' : '#1a1036'), opts);

    const ctx = this.bctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = matched ? C.green : 'rgba(255,255,255,0.35)';
    ctx.shadowBlur = (matched ? 40 : 18) * dpr;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }

  burst(x, y, color, n = 40) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 150 + Math.random() * 450;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 200, life: 1, size: 3 + Math.random() * 6,
        color: Math.random() < 0.5 ? color : [C.pink, C.cyan, C.yellow, C.white][i % 4], star: Math.random() < 0.4, rot: Math.random() * 6,
      });
    }
  }

  drawFx(dt) {
    const ctx = this.fctx, { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.particles = this.particles.filter((p) => (p.life -= dt * 0.9) > 0);
    for (const p of this.particles) {
      p.vy += 700 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98; p.rot += dt * 8;
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.fillStyle = p.color;
      if (p.star) { drawStar(ctx, p.x, p.y, p.size * 1.4, p.rot); } else { ctx.fillRect(p.x, p.y, p.size, p.size * 0.6); }
    }
    ctx.globalAlpha = 1;
  }
}

/** Upcoming-moves lane (Just Dance style pictograms sliding to a playhead). */
export class Lane {
  constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.w = this.h = 0; this.dpr = 1; }
  resize(w, h, dpr) { this.c.width = w * dpr; this.c.height = h * dpr; this.w = w; this.h = h; this.dpr = dpr; }

  draw(moves, t, { progress = 0, start = 0, bpm = null } = {}) {
    const { ctx, w, h, dpr } = this;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const headX = Math.max(90, w * 0.14), pps = Math.max(80, w / 7);

    // progress bar
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(0, 0, w, 4);
    const pg = ctx.createLinearGradient(0, 0, w, 0); pg.addColorStop(0, C.cyan); pg.addColorStop(1, C.pink);
    ctx.fillStyle = pg; ctx.fillRect(0, 0, w * Math.min(1, progress), 4);

    // beat ticks
    if (bpm) {
      const beat = 60 / bpm;
      const first = Math.ceil((t - headX / pps - start) / beat);
      for (let k = first; ; k++) {
        const bt = start + k * beat, x = headX + (bt - t) * pps;
        if (x > w) break;
        ctx.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
        ctx.fillRect(x - 1, h - 14, 2, k % 4 === 0 ? 10 : 6);
      }
    }

    // playhead
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.setLineDash([4, 5]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(headX, 10); ctx.lineTo(headX, h - 6); ctx.stroke(); ctx.setLineDash([]);

    const cardH = h - 30, cardW = cardH * 0.82;
    for (const m of moves) {
      const x = headX + (m.t - t) * pps;
      if (x < -cardW || x > w + cardW) continue;
      const near = Math.abs(m.t - t) < 0.5 && !m.result;
      const s = near ? 1.08 : 1;
      const cw = cardW * s, ch = cardH * s, cx = x - cw / 2, cy = 12 + (cardH - ch) / 2;
      const col = m.result ? JUDGE_COLOR[m.result] : near ? C.pink : 'rgba(255,255,255,0.25)';
      ctx.globalAlpha = m.result ? 0.55 : 1;
      roundRect(ctx, cx, cy, cw, ch, 12);
      ctx.fillStyle = near ? 'rgba(255,61,154,0.18)' : 'rgba(20,10,40,0.9)'; ctx.fill();
      ctx.lineWidth = near ? 3 : 2; ctx.strokeStyle = col; ctx.stroke();
      if (m.pose) {
        const unit = ch / 5.2;
        const map = (px, py) => [x + px * unit, cy + ch * 0.47 - py * unit];
        drawFigure(ctx, m.pose, map, unit, () => (m.result ? JUDGE_COLOR[m.result] : '#fff'));
      }
      if (m.result) {
        ctx.globalAlpha = 1;
        ctx.font = '800 11px Outfit'; ctx.textAlign = 'center'; ctx.fillStyle = col;
        ctx.fillText(m.result.toUpperCase(), x, cy + ch - 6);
      }
      ctx.globalAlpha = 1;
    }
    // fade edges
    const fade = ctx.createLinearGradient(w - 80, 0, w, 0);
    fade.addColorStop(0, 'rgba(10,6,20,0)'); fade.addColorStop(1, 'rgba(10,6,20,0.9)');
    ctx.fillStyle = fade; ctx.fillRect(w - 80, 0, 80, h);
  }
}

/** Skeleton overlay on the mirrored webcam preview. */
export function drawCamSkeleton(canvas, lms, video, limbs, dpr) {
  const ctx = canvas.getContext('2d');
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!lms || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const P = (i) => [ox + (1 - lms[i].x) * vw * s, oy + lms[i].y * vh * s];
  // after mirroring, anatomical left = screen left
  const bones = [
    [11, 13, 'lArm'], [13, 15, 'lArm'], [12, 14, 'rArm'], [14, 16, 'rArm'],
    [11, 12, 'torso'], [11, 23, 'torso'], [12, 24, 'torso'], [23, 24, 'torso'],
    [23, 25, 'lLeg'], [25, 27, 'lLeg'], [24, 26, 'rLeg'], [26, 28, 'rLeg'],
  ];
  ctx.lineCap = 'round'; ctx.lineWidth = 5;
  for (const [a, b, limb] of bones) {
    if ((lms[a].visibility ?? 1) < 0.4 || (lms[b].visibility ?? 1) < 0.4) continue;
    ctx.strokeStyle = limbColor(limbs?.[limb], C.cyan);
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if ((lms[i].visibility ?? 1) < 0.4) continue;
    const [x, y] = P(i); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawStar(ctx, x, y, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Dancer's tracked skeleton drawn over the reference video (object-fit: contain mapping). */
export function drawRefSkeleton(canvas, raw, aspect, dpr, pulse = 0, bgSource = null) {
  const ctx = canvas.getContext('2d');
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const vw = Math.min(cw, ch * aspect), vh = vw / aspect, ox = (cw - vw) / 2, oy = (ch - vh) / 2;
  if (bgSource) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(bgSource, ox, oy, vw, vh); }
  if (!raw) return;
  // raw layout: RAW_IDX = [nose, lSh, rSh, lEl, rEl, lWr, rWr, lHip, rHip, lKn, rKn, lAn, rAn] (anatomical)
  const P = (k) => [ox + raw[k * 3] * vw, oy + raw[k * 3 + 1] * vh];
  const ok = (k) => raw[k * 3 + 2] > 0.4;
  const bones = [[1, 3], [3, 5], [2, 4], [4, 6], [1, 2], [1, 7], [2, 8], [7, 8], [7, 9], [9, 11], [8, 10], [10, 12]];
  ctx.lineCap = 'round';
  ctx.shadowColor = C.cyan; ctx.shadowBlur = 12 + pulse * 10;
  ctx.strokeStyle = 'rgba(46,230,255,0.9)'; ctx.lineWidth = 4;
  for (const [a, b] of bones) {
    if (!ok(a) || !ok(b)) continue;
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (let k = 0; k < 13; k++) {
    if (!ok(k)) continue;
    const [x, y] = P(k);
    ctx.fillStyle = k === 5 || k === 6 ? C.pink : '#fff';
    ctx.beginPath(); ctx.arc(x, y, k === 0 ? 6 : 4, 0, Math.PI * 2); ctx.fill();
  }
}
