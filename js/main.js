import { createLandmarker, toBody, bodyToPose, poseToBody, BodySmoother } from './pose.js';
import { buildDemoRoutine, analyzeVideo, choreoToJSON, choreoFromJSON, TEMPLATES, RAW_IDX, lerpPose, repickMoves } from './choreo.js';
import { comparePoses, compareWithLag, judge } from './scoring.js';
import { StageRenderer, Lane, drawCamSkeleton, drawRefSkeleton, JUDGE_COLOR, makeProjector } from './stage.js';
import { Sound } from './audio.js';
import { RefPlayer, parseYouTubeId } from './player.js';
import { buildPlan, buildQueue, planDuration } from './plan.js';

const $ = (id) => document.getElementById(id);
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const cam = $('cam');

const sound = new Sound();
const stage = new StageRenderer($('stage-bg'), $('stage-fx'));
const lane = new Lane($('lane'));
const player = new RefPlayer({ ytHost: $('yt-player'), ytWrap: $('yt-wrap'), video: $('ref-video'), note: $('ref-note') });
player.onError = (code) => {
  const msg = { 2: 'Invalid video id', 5: 'Player error', 100: 'Video not found', 101: 'The owner disabled embedding', 150: 'The owner disabled embedding', 153: 'YouTube needs a referrer (serve over http://localhost)' }[code] ?? code;
  $('ref-note').textContent = `YouTube: ${msg}. The game still works — use the built-in beat.`;
};

const POINTS = { perfect: 300, good: 180, ok: 80, miss: 0 };
const LABEL = { perfect: 'PERFECT!', good: 'GOOD', ok: 'OK', miss: 'MISS' };

const G = {
  phase: 'menu', // menu | loading | calibrate | interlude | playing | paused | results
  mode: 'demo',
  bot: false,
  runId: 0,
  choreo: null,
  attract: buildDemoRoutine({ duration: 125 }),
  calibPose: TEMPLATES.find((t) => t.key === 'victory').pose,
  smoother: new BodySmoother(),
  userBody: null, userPose: null, rawLms: null, lost: 0, lastCamTime: -1,
  camLm: null, anLm: null, stream: null,
  learned: null, autoChoreo: null, fileUrl: null,
  map: makeProjector(1, 1),
};
const clock = {
  kind: 'internal', acc: 0, since: null,
  reset(t0 = 0) { this.acc = t0; this.since = null; },
  start() { if (this.since == null) this.since = performance.now(); },
  pause() { if (this.since != null) { this.acc += (performance.now() - this.since) / 1000; this.since = null; } },
  get t() {
    if (this.kind === 'ref') return player.time;
    return this.acc + (this.since != null ? (performance.now() - this.since) / 1000 : 0);
  },
};

/* ───────────────────────── Layout ───────────────────────── */

new ResizeObserver(([e]) => {
  const { width: w, height: h } = e.contentRect;
  if (!w || !h) return;
  stage.resize(w, h, dpr);
  G.map = makeProjector(w, h);
}).observe($('stage'));
new ResizeObserver(([e]) => lane.resize(e.contentRect.width, e.contentRect.height, dpr)).observe($('lane-wrap'));

/* ───────────────────────── Menu ───────────────────────── */

function settings() {
  return {
    ytUrl: $('yt-url').value.trim(),
    ytStart: +$('yt-start').value || 0,
    music: $('music').value,
    planMode: $('plan-mode').value,
    planSteps: +$('plan-steps').value || 4,
    finalLen: +$('plan-final').value || 0,
    anLen: +$('an-len').value || 0,
    difficulty: $('difficulty').value,
    weight: +$('weight').value || 65,
    anStart: +$('an-start').value || 0,
    anFps: +$('an-fps').value || 8,
    useYt: $('use-yt').checked,
  };
}

document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
  G.mode = b.dataset.mode;
  document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.mode-body').forEach((x) => x.classList.toggle('hidden', x.dataset.for !== G.mode));
  menuError('');
}));

function show(id, on = true) { $(id).classList.toggle('show', on); }
function menuError(msg) { $('menu-error').textContent = msg; }
function loading(text) { $('loading-text').textContent = text; show('loading'); }

// A pre-extracted choreography for a YouTube video can live at choreographies/<videoId>.json
async function checkAutoChoreo() {
  const id = parseYouTubeId($('yt-url').value);
  G.autoChoreo = null;
  $('auto-choreo-hint').textContent = '';
  if (!id) return;
  try {
    const r = await fetch(`choreographies/${id}.json`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const c = choreoFromJSON(await r.json());
    c.videoId = id;
    G.autoChoreo = c;
    $('auto-choreo-hint').innerHTML = `✅ <b>Video-accurate silhouettes found</b> for this video: ${c.moves.length} moves over ${fmt(c.end - c.start)}.`;
    renderPlanPreview();
  } catch {
    $('auto-choreo-hint').textContent = 'Silhouettes follow a built-in routine. For silhouettes taken from this exact video, use "Learn From Video".';
  }
}
$('yt-url').addEventListener('change', () => { checkAutoChoreo(); previewYouTube(); });
checkAutoChoreo();

// Show the reference video in its panel right away (cued, not playing).
function previewYouTube() {
  const id = parseYouTubeId($('yt-url').value);
  if (id && G.phase === 'menu') player.useYouTube(id, +$('yt-start').value || 0).catch(() => {});
}
previewYouTube();

/* ── Plan preview in the menu ── */
function menuChoreo() {
  const id = parseYouTubeId($('yt-url').value);
  if (G.mode === 'video') return G.learned;
  if (G.autoChoreo && G.autoChoreo.videoId === id) return G.autoChoreo;
  return buildDemoRoutine({ duration: +$('plan-final').value || 180 });
}
function renderPlanPreview() {
  const box = $('plan-preview');
  const full = $('plan-mode').value === 'full';
  $('plan-steps').closest('label').classList.toggle('hidden', full);
  const c = menuChoreo();
  if (!c) { box.innerHTML = '<li class="muted">Load a video to see your plan.</li>'; return; }
  const plan = buildPlan(c, { steps: +$('plan-steps').value, finalLen: +$('plan-final').value, mode: $('plan-mode').value });
  const dur = (lv) => lv.reps * lv.parts.reduce((s, p) => s + (p.b - p.a), 0);
  box.innerHTML = plan.levels.map((lv) => `<li class="${lv.kind}"><b>${lv.title}${lv.reps > 1 ? ` <em>×${lv.reps}</em>` : ''}</b>
      <span>${fmt(dur(lv))}</span></li>`).join('')
    + `<li class="total">Total ≈ ${Math.round(planDuration(plan) / 60)} min</li>`;
}
['plan-mode', 'plan-steps', 'plan-final'].forEach((id) => $(id).addEventListener('change', renderPlanPreview));
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', renderPlanPreview));

/* ── Learn from video ── */
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files?.[0];
  if (f) learnFromFile(f);
});
$('file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) learnFromFile(f); e.target.value = ''; });
$('an-cancel').addEventListener('click', () => G.analysisAbort?.abort());

async function learnFromFile(file) {
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name)) return menuError('That is not a video file.');
  menuError('');
  if (G.fileUrl) URL.revokeObjectURL(G.fileUrl);
  G.fileUrl = URL.createObjectURL(file);
  const s = settings();
  const ac = new AbortController();
  G.analysisAbort = ac;
  show('analyzing');
  const bar = document.querySelector('#analyzing .bar');
  bar.style.width = '0%';
  const status = (t) => { $('an-status').textContent = t; };
  try {
    status('Loading the pose AI (full model)…');
    G.anLm ??= createLandmarker('full');
    const lm = await G.anLm;
    const t0 = performance.now();
    const c = await analyzeVideo(G.fileUrl, lm, {
      fps: s.anFps, from: s.anStart, to: s.anLen ? s.anStart + s.anLen : Infinity,
      name: file.name.replace(/\.[^.]+$/, ''), signal: ac.signal,
      onProgress: (p, t) => {
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        const el = (performance.now() - t0) / 1000, eta = p > 0.02 ? el / p - el : 0;
        status(`Tracking the dancer at ${fmt(t)} · ${Math.round(p * 100)}%${eta ? ` · ~${Math.ceil(eta)}s left` : ''}`);
      },
      onFrame: (v, lms) => {
        const raw = lms ? Float32Array.from(RAW_IDX.flatMap((k) => [lms[k].x, lms[k].y, lms[k].visibility ?? 1])) : null;
        drawRefSkeleton($('an-preview'), raw, v.videoWidth / v.videoHeight, dpr, 0, v);
      },
    });
    const tracked = c.frames.filter(Boolean).length / c.frames.length;
    if (tracked < 0.2) throw new Error('Could not find a dancer in most of this video. Try a video with one clearly visible person.');
    G.learned = c;
    saveLearned(c);
    renderSaved();
    renderPlanPreview();
  } catch (e) {
    if (e.name !== 'AbortError') { console.error(e); menuError(e.message); }
  } finally {
    show('analyzing', false);
  }
}

function saveLearned(c) {
  try { localStorage.setItem('gf:learned', JSON.stringify(choreoToJSON(c))); } catch (e) { console.warn('Could not cache choreography', e); }
}
function loadLearned() {
  try { const j = localStorage.getItem('gf:learned'); if (j) G.learned = choreoFromJSON(JSON.parse(j)); } catch { /* ignore */ }
}
function renderSaved() {
  const box = $('saved-choreo');
  const c = G.learned;
  box.classList.toggle('hidden', !c);
  if (!c) return;
  const tracked = Math.round((c.frames.filter(Boolean).length / c.frames.length) * 100);
  box.innerHTML = `<span><b>✓ Learned:</b> ${escapeHtml(c.name)} · ${fmt(c.end - c.start)} · ${c.moves.length} moves · ${tracked}% tracked
    ${G.fileUrl ? '' : '<br><small>(video file not loaded this session — playback uses the YouTube link)</small>'}</span>
    <button class="link-btn" id="btn-export">Export JSON</button>
    <button class="link-btn" id="btn-forget">Forget</button>`;
  $('btn-export').onclick = () => {
    const id = parseYouTubeId($('yt-url').value);
    const blob = new Blob([JSON.stringify(choreoToJSON(c))], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${id && $('use-yt').checked ? id : c.name}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('btn-forget').onclick = () => { G.learned = null; localStorage.removeItem('gf:learned'); renderSaved(); };
}
$('import').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try { G.learned = choreoFromJSON(JSON.parse(await f.text())); saveLearned(G.learned); renderSaved(); menuError(''); } catch (err) { menuError(err.message); }
});
loadLearned();
renderSaved();
renderPlanPreview();

/* ───────────────────────── Game setup ───────────────────────── */

$('btn-start').addEventListener('click', () => startGame({ bot: false }));
$('btn-bot').addEventListener('click', () => startGame({ bot: true }));
$('btn-again').addEventListener('click', () => { show('results', false); startGame({ bot: G.bot }); });
$('btn-menu').addEventListener('click', toMenu);
$('btn-pause').addEventListener('click', () => (G.phase === 'paused' ? resume() : pause()));
$('btn-resume').addEventListener('click', resume);
$('btn-quit').addEventListener('click', toMenu);
$('btn-quit2').addEventListener('click', toMenu);
document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); G.phase === 'paused' ? resume() : pause(); }
  if (e.code === 'Escape' && G.phase !== 'menu') toMenu();
});

// Switching tabs/windows mid-dance pauses the session (the browser would throttle it anyway).
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

async function startCamera() {
  if (G.stream?.active) return;
  G.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false,
  });
  cam.srcObject = G.stream;
  await cam.play();
}

async function startGame({ bot }) {
  sound.ensure(); // unlock audio inside the click
  menuError('');
  const s = settings();
  G.bot = bot;
  G.difficulty = s.difficulty;
  G.weight = s.weight;
  G.music = s.music;
  const runId = ++G.runId;

  let choreo, ref = null;
  const ytId = parseYouTubeId(s.ytUrl);
  if (G.mode === 'demo') {
    if (G.autoChoreo && G.autoChoreo.videoId === ytId) {
      choreo = G.autoChoreo; clock.kind = 'ref'; ref = { kind: 'yt', id: ytId };
    } else {
      choreo = buildDemoRoutine({ duration: s.finalLen || 180 });
      clock.kind = 'internal';
      if (ytId) ref = { kind: 'yt', id: ytId, start: s.ytStart };
    }
  } else {
    if (!G.learned) return menuError('Drop a dance video first (or import a choreography JSON).');
    choreo = G.learned;
    clock.kind = 'ref';
    if (s.useYt || !G.fileUrl) {
      if (!ytId) return menuError('Add a YouTube link in Quick Groove, or drop the video file again.');
      ref = { kind: 'yt', id: ytId };
    } else ref = { kind: 'file', url: G.fileUrl };
  }
  G.choreo = choreo;
  G.plan = buildPlan(choreo, { steps: s.planSteps, finalLen: s.finalLen, mode: s.planMode });
  G.queue = buildQueue(G.plan);
  G.levelStats = G.plan.levels.map(() => ({ reps: [] }));
  G.qi = 0;
  G.tStart = G.queue[0].a;
  G.tEnd = G.queue[0].b;

  show('menu', false);
  try {
    if (!bot) {
      loading('Starting your camera…');
      await startCamera();
      loading('Loading the pose AI…');
      G.camLm ??= createLandmarker('lite');
      G.camLm.catch(() => { G.camLm = null; });
      G.lm = await G.camLm;
    }
    loading('Loading the reference video…');
    if (ref?.kind === 'yt') await player.useYouTube(ref.id, clock.kind === 'ref' ? G.tStart : ref.start ?? 0);
    else if (ref?.kind === 'file') { player.useFile(ref.url); player.seek(G.tStart); }
    else player.none();
    player.setMuted(clock.kind === 'internal' && s.music === 'beat');
  } catch (e) {
    console.error(e);
    show('loading', false);
    show('menu');
    G.phase = 'menu';
    const denied = e.name === 'NotAllowedError' || e.name === 'NotFoundError';
    menuError(denied ? 'Camera not available or permission denied. Allow the camera — or try the auto-dancer demo.' : `Could not start: ${e.message}`);
    return;
  }
  if (runId !== G.runId) return;
  show('loading', false);

  $('ref-note').textContent = choreo.source === 'demo'
    ? 'Quick Groove: built-in moves on the beat. For silhouettes taken from the video itself, use Learn From Video.'
    : '';
  document.querySelector('.ref-panel').classList.toggle('has-track', !!choreo.raw);

  resetStats();
  G.moves = [];
  if (bot) beginClip(0);
  else { G.phase = 'calibrate'; G.hold = 0; }
}

function resetStats() {
  Object.assign(G, {
    score: 0, shownScore: 0, combo: 0, maxCombo: 0, kcal: 0, intensity: 0, groove: 0, fever: false, feverUntil: 0,
    counts: { perfect: 0, good: 0, ok: 0, miss: 0 }, match: 0, prevUser: null, lastMoveName: '',
  });
  $('move-name').textContent = '';
  $('stage').classList.remove('fever', 'matched');
  updateHud(true);
}

/* ── Training plan: each clip = one rep of a level, preceded by a get-ready card ── */

function clipAccuracy(c) {
  const total = c.perfect + c.good + c.ok + c.miss;
  return total ? (c.perfect + c.good * 0.7 + c.ok * 0.35) / total : null;
}
function starsFor(acc) {
  const n = acc == null ? 0 : Math.max(1, Math.min(5, Math.round(acc * 5)));
  return [1, 2, 3, 4, 5].map((i) => `<span class="${i <= n ? '' : 'off'}">★</span>`).join('');
}

async function beginClip(i) {
  const runId = G.runId;
  const clip = G.queue[i];
  const lv = G.plan.levels[clip.level];
  G.qi = i; G.clip = clip;
  G.tStart = clip.a; G.tEnd = clip.b;
  G.moves = G.choreo.moves.filter((m) => m.t >= clip.a + 0.3 && m.t <= clip.b).map((m) => ({ ...m, best: 0, result: null }));
  G.clipCounts = { perfect: 0, good: 0, ok: 0, miss: 0 };
  G.phase = 'interlude';
  G.lastMoveName = ''; $('move-name').textContent = '';
  setStageMsg('');
  sound.stopBeat(); player.pause(); clock.pause();
  if (clock.kind === 'ref') player.seek(clip.a); // seek while the card hides it
  updatePlanTag();

  // get-ready card
  const firstOfLevel = clip.rep === 0 && clip.part === 0;
  const repLine = clip.bonus ? 'Bonus rep — you’ve got this! 💪'
    : lv.shuffle ? `Round ${clip.rep + 1} of ${lv.reps} · Step ${clip.stepNo} (${clip.part + 1}/${clip.parts})`
    : lv.reps > 1 ? `Rep ${clip.rep + 1} of ${lv.reps}` : '';
  const prev = G.lastClip && G.lastClip.level === clip.level && G.lastClip.acc != null
    ? `<div class="last">${lv.shuffle ? 'Last step' : 'Last rep'} ${Math.round(G.lastClip.acc * 100)}% <span class="stars">${starsFor(G.lastClip.acc)}</span></div>` : '';
  const card = $('plan-card');
  card.className = `show ${lv.kind}`;
  const secs = firstOfLevel ? 4 : clip.part > 0 ? 2 : 3;
  for (let n = secs; n > 0; n--) {
    card.innerHTML = `<div class="lvl">LEVEL ${clip.level + 1} / ${G.plan.levels.length}</div>
      <h2>${lv.title}</h2><p class="sub">${lv.subtitle ?? ''}</p>
      ${repLine ? `<div class="rep">${repLine}</div>` : ''}${prev}
      <div class="cd">${n <= 3 ? n : 'Get ready'}</div>`;
    if (n <= 3) sound.count();
    await wait(900);
    if (runId !== G.runId || G.phase !== 'interlude') return;
  }
  card.className = '';
  $('countdown').innerHTML = '<div class="n">GO!</div>';
  sound.go();
  setTimeout(() => { if ($('countdown').textContent === 'GO!') $('countdown').innerHTML = ''; }, 700);

  G.phase = 'playing';
  if (clock.kind === 'internal') {
    clock.reset(clip.a); clock.start();
    if (G.music === 'beat' || !player.kind) sound.startBeat(G.choreo.bpm ?? 128, -clip.a);
  }
  player.play();
  if (document.hidden) pause();
}

function endClip() {
  const now = clock.t;
  for (const m of G.moves) if (!m.result && m.t <= now + 0.1) resolveMove(m, true); // moves never reached don't count
  const clip = G.clip, lv = G.plan.levels[clip.level];
  const acc = clipAccuracy(G.clipCounts);
  if (acc != null) G.levelStats[clip.level].reps.push(acc);
  G.lastClip = { level: clip.level, acc };
  // struggling with a new step? add one bonus rep before moving on
  const next = G.queue[G.qi + 1];
  const best = Math.max(0, ...G.levelStats[clip.level].reps);
  if (lv.kind === 'learn' && (!next || next.level !== clip.level) && best < 0.55 && !lv.bonusAdded) {
    lv.bonusAdded = true;
    G.queue.splice(G.qi + 1, 0, { ...clip, rep: clip.rep + 1, bonus: true });
  }
  if (G.qi + 1 >= G.queue.length) return finish();
  beginClip(G.qi + 1);
}

function updatePlanTag() {
  const clip = G.clip;
  if (!clip || !G.plan) { $('plan-tag').textContent = 'DANCE ALONG'; return; }
  const lv = G.plan.levels[clip.level];
  const rep = lv.reps > 1 ? ` · REP ${clip.rep + 1}/${lv.reps}` : '';
  $('plan-tag').textContent = `LEVEL ${clip.level + 1}/${G.plan.levels.length} · ${lv.title.toUpperCase()}${rep}`;
  $('plan-dots').innerHTML = G.plan.levels.map((l, i) => `<i class="${i < clip.level ? 'done' : i === clip.level ? 'cur' : ''} ${l.kind}"></i>`).join('');
}


function pause() {
  if (G.phase !== 'playing') return;
  G.phase = 'paused';
  clock.pause(); player.pause(); sound.pause();
  show('paused');
}
function resume() {
  if (G.phase !== 'paused') return;
  show('paused', false);
  G.phase = 'playing';
  if (clock.kind === 'internal') clock.start();
  player.play(); sound.resume();
}
function toMenu() {
  G.runId++;
  G.phase = 'menu';
  sound.stopBeat(); sound.resume();
  player.pause(); clock.pause();
  $('countdown').innerHTML = '';
  $('plan-card').className = '';
  G.clip = null; G.lastClip = null; updatePlanTag(); $('plan-dots').innerHTML = '';
  setStageMsg('');
  ['paused', 'results', 'loading'].forEach((id) => show(id, false));
  show('menu');
  updateBest();
}

function finish() {
  G.phase = 'results';
  sound.stopBeat(); player.pause(); clock.pause();
  $('plan-card').className = '';
  const total = Object.values(G.counts).reduce((a, b) => a + b, 0) || 1;
  const acc = (G.counts.perfect + G.counts.good * 0.7 + G.counts.ok * 0.35) / total;
  const grade = acc >= 0.9 ? 'S' : acc >= 0.75 ? 'A' : acc >= 0.6 ? 'B' : acc >= 0.4 ? 'C' : 'D';
  const stars = Math.max(1, Math.min(5, Math.round(acc * 5)));
  $('res-grade').textContent = grade;
  $('res-stars').innerHTML = [1, 2, 3, 4, 5].map((i) => `<span class="${i <= stars ? '' : 'off'}">★</span>`).join('');
  $('res-score').textContent = Math.round(G.score).toLocaleString();
  for (const k of ['perfect', 'good', 'ok', 'miss']) $(`res-${k}`).textContent = G.counts[k];
  $('res-combo').textContent = G.maxCombo;
  $('res-acc').textContent = `${Math.round(acc * 100)}%`;
  $('res-kcal').textContent = G.kcal.toFixed(1);
  $('res-plan').innerHTML = G.plan.levels.length > 1 ? G.plan.levels.map((lv, i) => {
    const reps = G.levelStats[i].reps, best = reps.length ? Math.max(...reps) : null;
    return `<li class="${lv.kind}"><span>${i + 1}. ${lv.title}</span><span class="stars">${starsFor(best)}</span></li>`;
  }).join('') : '';
  const key = `gf:best:${G.choreo.name}`;
  const best = +localStorage.getItem(key) || 0;
  if (G.score > best) { localStorage.setItem(key, Math.round(G.score)); $('res-best').textContent = '🏆 New personal best!'; } else $('res-best').textContent = `Personal best: ${best.toLocaleString()}`;
  if (grade === 'S' || grade === 'A') { stage.burst(stage.w / 2, stage.h * 0.4, '#3dff8b', 120); sound.fever(); }
  show('results');
}

function updateBest() {
  const best = +localStorage.getItem('gf:best:Quick Groove') || 0;
  $('best').textContent = best ? `Quick Groove best: ${best.toLocaleString()}` : '';
}
updateBest();

/* ───────────────────────── Tracking ───────────────────────── */

function trackUser(now) {
  if (!G.lm || cam.readyState < 2 || !cam.videoWidth) return null;
  if (cam.currentTime === G.lastCamTime) return G.userBody;
  G.lastCamTime = cam.currentTime;
  const lms = G.lm.detect(cam, now);
  const b = toBody(lms, cam.videoWidth / cam.videoHeight, true);
  if (b && b.upperVisible && b.armsVisible) {
    G.lost = 0;
    G.rawLms = lms;
    G.userBody = G.smoother.push(b);
  } else if (++G.lost > 12) {
    G.userBody = null; G.rawLms = lms; G.smoother.reset();
  }
  return G.userBody;
}

/** Auto-dancer: follows the choreography slightly late, with wobble and the odd mistake. */
function botBody(t, choreo, sloppy = true) {
  const pose = choreo.poseAt(t - 0.18) ?? choreo.poseAt(t);
  if (!pose) return null;
  const out = new Float32Array(pose);
  for (let i = 0; i < out.length; i++) out[i] += Math.sin(t * 3.1 + i * 1.7) * 0.035;
  if (sloppy && Math.sin(t * 0.41) > 0.9) {
    // lazily drop the right arm for a moment
    const lazy = TEMPLATES[0].pose;
    const k = Math.min(1, (Math.sin(t * 0.41) - 0.9) * 20);
    const mixed = lerpPose(out, lazy, k);
    for (const i of [4, 6, 12]) { out[i] = mixed[i]; out[i + 1] = mixed[i + 1]; }
  }
  const body = poseToBody(out);
  body.p.nose[0] += Math.sin(t * 2) * 0.05;
  return body;
}

/* ───────────────────────── Game logic ───────────────────────── */

function mult() { return 1 + Math.min(4, Math.floor(G.combo / 5)) * 0.5; }

function resolveMove(m, silent = false) {
  const res = judge(m.best, G.difficulty);
  m.result = res;
  G.counts[res]++;
  if (G.clipCounts) G.clipCounts[res]++;
  if (res === 'miss') G.combo = 0;
  else if (res !== 'ok') G.combo++;
  G.maxCombo = Math.max(G.maxCombo, G.combo);
  const pts = Math.round(POINTS[res] * mult() * (G.fever ? 2 : 1));
  G.score += pts;
  if (!G.fever) G.groove = Math.max(0, Math.min(100, G.groove + { perfect: 14, good: 8, ok: 2, miss: -12 }[res]));
  if (silent) return;
  const j = $('judgement');
  j.style.color = JUDGE_COLOR[res];
  j.style.textShadow = `0 0 24px ${JUDGE_COLOR[res]}`;
  j.innerHTML = `${LABEL[res]}${pts ? `<small>+${pts}${G.combo >= 5 ? ` · ${G.combo} combo` : ''}</small>` : ''}`;
  j.classList.remove('pop'); void j.offsetWidth; j.classList.add('pop');
  sound[res]();
  const [x, y] = G.map(0, 0.6);
  if (res === 'perfect') stage.burst(x, y, '#3dff8b', 50);
  else if (res === 'good') stage.burst(x, y, '#2ee6ff', 18);
  if (G.combo > 0 && G.combo % 10 === 0) { stage.burst(x, y - 60, '#ffd23d', 70); }
}

function updateGame(t, dt, cmp) {
  const live = cmp?.total ?? 0;
  if (live > 0.6) G.score += dt * 40 * live * mult() * (G.fever ? 2 : 1);

  const user = G.userPose;
  for (const m of G.moves) {
    if (m.result) continue;
    if (t < m.t - 0.35) break;
    if (t <= m.t + 0.75) {
      if (user) {
        const useLegs = G.userBody.legsVisible && G.choreo.legsAt(m.t);
        m.best = Math.max(m.best, comparePoses(user, m.pose, { useLegs, difficulty: G.difficulty }).total);
      }
    } else resolveMove(m);
  }

  // fever mode
  if (!G.fever && G.groove >= 100) {
    G.fever = true; G.feverUntil = t + 8; sound.fever();
    stage.burst(stage.w / 2, stage.h / 2, '#ff3d9a', 90);
  }
  if (G.fever) {
    G.groove = Math.max(0, ((G.feverUntil - t) / 8) * 100);
    if (t >= G.feverUntil) { G.fever = false; G.groove = 0; }
  }

  // calories: MET scaled by how much you actually move
  const b = G.userBody;
  if (b && G.prevUser) {
    const keys = b.legsVisible ? ['lWr', 'rWr', 'lAn', 'rAn', 'head'] : ['lWr', 'rWr', 'head'];
    let sp = 0;
    for (const k of keys) sp += Math.hypot(b.p[k][0] - G.prevUser[k][0], b.p[k][1] - G.prevUser[k][1]);
    sp = sp / keys.length / Math.max(dt, 1 / 120);
    G.intensity += (sp - G.intensity) * Math.min(1, dt * 1.5);
  }
  G.prevUser = b ? Object.fromEntries(Object.entries(b.p).map(([k, v]) => [k, v.slice()])) : null;
  const met = 3 + Math.min(1, G.intensity / 2.2) * 5.5;
  G.kcal += ((met * 3.5 * G.weight) / 200 / 60) * dt;

  let mv = null;
  for (const m of G.moves) { if (m.t <= t + 0.25) mv = m; else break; }
  const name = mv ? mv.name : '';
  if (name !== G.lastMoveName) { G.lastMoveName = name; $('move-name').textContent = name; }

  if (t >= G.tEnd || (clock.kind === 'ref' && player.ended)) endClip();
}

let hudAt = 0;
function updateHud(force = false) {
  const now = performance.now();
  if (!force && now - hudAt < 90) return;
  hudAt = now;
  G.shownScore += (G.score - G.shownScore) * 0.35;
  if (Math.abs(G.score - G.shownScore) < 1) G.shownScore = G.score;
  $('hud-score').textContent = Math.round(G.shownScore).toLocaleString();
  $('hud-combo').textContent = G.combo;
  $('hud-mult').textContent = `x${mult() * (G.fever ? 2 : 1)}`;
  $('hud-kcal').textContent = G.kcal.toFixed(1);
  const el = G.phase === 'menu' ? 0 : Math.max(0, clock.t - G.tStart);
  const total = Math.max(0, (G.tEnd ?? 0) - (G.tStart ?? 0));
  $('hud-time').textContent = G.phase === 'menu' ? '0:00' : `${fmt(el)} / ${fmt(total)}`;
  document.querySelector('#match-meter .fill').style.height = `${Math.round(G.match * 100)}%`;
  document.querySelector('#match-meter .fill').style.backgroundPosition = `0 ${100 - G.match * 100}%`;
  document.querySelector('#groove-meter .fill').style.height = `${Math.round(G.groove)}%`;
  $('stage').classList.toggle('fever', G.fever);
  document.body.classList.toggle('fever', G.fever);
}

let stageMsgHtml = '';
function setStageMsg(html) {
  if (html === stageMsgHtml) return;
  stageMsgHtml = html;
  $('stage-msg').innerHTML = html;
  $('skip-cal')?.addEventListener('click', () => beginClip(0));
}

function calibrationMsg(user, cmp) {
  const upper = !!user, legs = user?.legsVisible;
  const posed = (cmp?.total ?? 0) >= 0.66;
  const c = (ok, label) => `<span class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${label}</span>`;
  const title = !upper ? 'Step back until your head, shoulders & hands are in the camera'
    : posed ? 'Hold it…' : 'Match the ✌ Victory pose to start!';
  return `<b>${title}</b><div class="checks">${c(upper, 'Upper body')}${c(legs, 'Legs (bonus)')}${c(posed, 'Pose')}</div>
    <button class="link-btn" id="skip-cal">Skip & start</button>`;
}

/* ───────────────────────── Main loop ───────────────────────── */

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const phase = G.phase;
  let body = null, target = null, cmp = null, t = 0, userTracked = false, beat = 0;

  if (phase === 'menu' || phase === 'loading') {
    // attract mode behind the menu: a silhouette dances the demo routine by itself
    const c = G.attract;
    t = ((now / 1000) % (c.end - 4)) + 2;
    target = c.poseAt(t);
    body = botBody(t, c, false);
    cmp = comparePoses(bodyToPose(body), target);
    userTracked = true;
    beat = ((t * (c.bpm / 60)) % 1);
  } else {
    body = G.bot ? null : trackUser(now);
    t = phase === 'interlude' || phase === 'calibrate' ? G.tStart : clock.t;
    if (G.bot) G.userBody = body = phase === 'calibrate' ? null : botBody(t, G.choreo);
    G.userPose = body ? bodyToPose(body) : null;
    userTracked = !!body;

    if (phase === 'calibrate') {
      target = G.calibPose;
      if (G.userPose) cmp = comparePoses(G.userPose, target, { difficulty: 'easy' });
      G.hold = (cmp?.total ?? 0) >= 0.66 ? G.hold + dt : Math.max(0, G.hold - dt * 2);
      setStageMsg(calibrationMsg(body, cmp));
      if (G.hold > 0.8) { sound.good(); beginClip(0); }
    } else {
      // the target follows the dancer frame-by-frame, locked to the video's clock;
      // on the get-ready card it previews the first pose of the coming clip
      target = phase === 'interlude' ? (G.moves[0]?.pose ?? G.choreo.poseAt(t)) : G.choreo.poseAt(t) ?? G.moves[0]?.pose;
      if (G.userPose) cmp = compareWithLag(G.userPose, G.choreo, t, { useLegs: body.legsVisible, difficulty: G.difficulty });
      if (phase === 'playing') updateGame(t, dt, cmp);
    }
    if (G.choreo?.bpm) beat = ((t - G.tStart) * (G.choreo.bpm / 60)) % 1;
    else beat = (t * 2) % 1;
  }

  G.match += ((cmp?.total ?? 0) - G.match) * Math.min(1, dt * 10);
  $('stage').classList.toggle('matched', userTracked && G.match >= 0.72 && phase !== 'menu');

  // render
  stage.drawBackground(G.map, {
    time: now / 1000, beat, fever: G.fever && phase === 'playing', match: G.match,
    target, limbs: cmp?.limbs, userTracked, showLegs: true,
  });
  const userPose = body ? bodyToPose(body) : null;
  stage.drawUser(G.map, smoothUser(userPose, dt), cmp?.limbs, { showLegs: !!body?.legsVisible, match: G.match });
  stage.drawFx(dt);

  const inGame = phase !== 'menu' && phase !== 'loading' && G.choreo;
  const laneMoves = inGame ? G.moves : G.attract.moves;
  const laneT = inGame ? (phase === 'calibrate' || phase === 'interlude' ? G.tStart - 1 : t) : t;
  lane.draw(laneMoves, laneT, {
    progress: inGame ? (t - G.tStart) / Math.max(1, G.tEnd - G.tStart) : (t / G.attract.end),
    start: inGame ? G.tStart : 0,
    bpm: inGame ? G.choreo.bpm : G.attract.bpm,
  });

  // camera preview + tracking overlays
  drawCamSkeleton($('cam-overlay'), G.bot ? null : G.rawLms, cam, cmp?.limbs, dpr);
  const showTrack = inGame && G.choreo.raw && $('show-track').checked;
  drawRefSkeleton($('ref-overlay'), showTrack ? G.choreo.rawAt(t) : null, G.choreo?.aspect ?? 16 / 9, dpr, 1 - beat);

  $('track-dot').classList.toggle('on', userTracked && phase !== 'menu');
  const camMsg = phase === 'menu' || phase === 'loading' ? 'Your camera appears here when you play'
    : G.bot ? 'Auto-dancer demo — no camera' : !G.stream ? '' : !body ? 'Step into the frame' : '';
  if ($('cam-msg').textContent !== camMsg) $('cam-msg').textContent = camMsg;
  if (phase !== 'menu') updateHud();
}

resetStats();
requestAnimationFrame(frame);

/** Extra per-frame easing for the on-stage silhouette so it glides instead of jittering. */
let shownUser = null;
function smoothUser(pose, dt) {
  if (!pose) { shownUser = null; return null; }
  if (!shownUser || shownUser.length !== pose.length) { shownUser = Float32Array.from(pose); return shownUser; }
  const k = Math.min(1, dt * 18);
  for (let i = 0; i < pose.length; i++) shownUser[i] += (pose[i] - shownUser[i]) * k;
  return shownUser;
}

/* ───────────────────────── utils ───────────────────────── */

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmt(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// debug handle
window.GF = { G, clock, player, choreoToJSON, repickMoves, beginClip };
