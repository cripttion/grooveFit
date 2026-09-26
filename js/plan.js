// Training plan: learn the routine step by step, then mix steps, then dance the whole video.
//
//   Level 1  Learn Step 1        ×3
//   Level 2  Learn Step 2        ×3
//   Level 3  Combo Step 1 + 2    ×2   (played back-to-back, like in the video)
//   Level 4  Learn Step 3        ×3
//   ...
//   Level N-1  Mix it up         ×2   (all learned steps in shuffled order)
//   Level N  FINAL — whole video ×1
//
// Everything is expressed as clips of the original video/choreography timeline,
// so the music always plays at normal speed and the silhouettes stay in sync.

const MOVES_PER_STEP = 4; // ≈ one 8-count phrase
const LEAD = 1.0; // start each clip a beat before its first move, so you see it coming

/** Cut the choreography into consecutive steps of a few key moves each. */
export function splitSteps(choreo) {
  const mv = choreo.moves, steps = [];
  for (let i = 0; i + MOVES_PER_STEP <= mv.length; i += MOVES_PER_STEP) {
    const moves = mv.slice(i, i + MOVES_PER_STEP);
    const next = mv[i + MOVES_PER_STEP];
    const a = Math.max(choreo.start, moves[0].t - LEAD);
    const b = next ? next.t - LEAD : Math.min(choreo.end, moves.at(-1).t + 1.5);
    const names = [...new Set(moves.map((m) => m.name))].slice(0, 3);
    steps.push({ a, b, moves, names });
  }
  return steps;
}

/**
 * @param opts.steps     how many steps to learn before the final
 * @param opts.finalLen  seconds for the final round (0 = the whole video)
 * @param opts.mode      'plan' | 'full'
 */
export function buildPlan(choreo, { steps: nSteps = 4, finalLen = 0, mode = 'plan' } = {}) {
  const all = splitSteps(choreo);
  const finalEnd = finalLen ? Math.min(choreo.end, choreo.start + finalLen) : choreo.end;
  const final = {
    kind: 'final', title: finalLen ? 'FINAL — Full routine' : 'FINAL — The whole video',
    subtitle: 'Put it all together!', reps: 1, parts: [{ a: choreo.start, b: finalEnd }],
  };
  if (mode === 'full' || all.length === 0) return { levels: [{ ...final, title: 'Full routine', subtitle: 'Dance along with the video' }], steps: all };

  const steps = all.slice(0, nSteps);
  const levels = [];
  const label = (i) => `Step ${i + 1}`;
  steps.forEach((s, i) => {
    levels.push({ kind: 'learn', title: `Learn ${label(i)}`, subtitle: s.names.join(' · '), reps: 3, parts: [s] });
    if (i % 2 === 1) {
      levels.push({ kind: 'combo', title: `Combo · ${label(i - 1)} + ${label(i)}`, subtitle: 'Back-to-back, just like the video', reps: 2, parts: [steps[i - 1], s] });
    }
  });
  if (steps.length % 2 === 1 && steps.length > 1) {
    const i = steps.length - 1;
    levels.push({ kind: 'combo', title: `Combo · ${label(i - 1)} + ${label(i)}`, subtitle: 'Back-to-back, just like the video', reps: 2, parts: [steps[i - 1], steps[i]] });
  }
  if (steps.length >= 3) {
    levels.push({ kind: 'mix', title: 'Mix it up', subtitle: `All ${steps.length} steps in a random order`, reps: 2, parts: steps, shuffle: true });
  }
  levels.push(final);
  return { levels, steps };
}

/** Expand levels into the ordered list of clips to play. */
export function buildQueue(plan) {
  const q = [];
  plan.levels.forEach((lv, level) => {
    for (let rep = 0; rep < lv.reps; rep++) {
      const parts = lv.shuffle ? shuffled(lv.parts) : [{ a: lv.parts[0].a, b: lv.parts.at(-1).b }];
      parts.forEach((p, part) => {
        const stepNo = lv.shuffle ? lv.parts.indexOf(p) + 1 : null;
        q.push({ level, rep, part, parts: parts.length, a: p.a, b: p.b, stepNo });
      });
    }
  });
  return q;
}

/** Rough session length in seconds (clips + get-ready cards). */
export function planDuration(plan) {
  return buildQueue(plan).reduce((s, c) => s + (c.b - c.a) + (c.part > 0 ? 1.5 : 3.5), 0);
}

function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.length > 1 && out.every((x, i) => x === arr[i])) out.push(out.shift()); // never the original order
  return out;
}
