// Rep tempos a physio can prescribe, shared by the game (cave hill timing), the physio form,
// the patient dashboard and the server (tempo-accuracy scoring). Plain data: safe to import in Node.
//   up / hold / down: seconds for the lift, the pause at the top and the controlled lower
//   rest: seconds in the valley before the next hill

export const TEMPOS = {
  slow:   { key: "slow",   name: "Slow",   up: 3,    hold: 1,    down: 3,    rest: 1.5 },
  medium: { key: "medium", name: "Medium", up: 2,    hold: 0.75, down: 2,    rest: 1.25 },
  fast:   { key: "fast",   name: "Fast",   up: 1.25, hold: 0.5,  down: 1.25, rest: 1 },
};
export const DEFAULT_TEMPO = "slow";

export const tempoOf = (key) => TEMPOS[key] ?? TEMPOS[DEFAULT_TEMPO];

export const tempoSummary = (key) => {
  const t = tempoOf(key);
  return `${t.up}s up · ${t.hold}s hold · ${t.down}s down`;
};

/**
 * How closely one rep matched the prescribed tempo, 0..1.
 * Each phase scores 1 when on target and falls linearly to 0 at 100% off (twice or zero the time).
 */
export function repTempoScore(concentricMs, eccentricMs, tempoKey) {
  const t = tempoOf(tempoKey);
  const phase = (actualMs, targetS) => {
    const target = targetS * 1000;
    if (!(actualMs > 0)) return 0;
    return Math.max(0, 1 - Math.abs(actualMs - target) / target);
  };
  return (phase(concentricMs, t.up) + phase(eccentricMs, t.down)) / 2;
}

/** "too fast" / "too slow" / null for an average up+down time against the tempo. */
export function tempoDirection(avgConcentricMs, avgEccentricMs, tempoKey) {
  const t = tempoOf(tempoKey);
  const actual = (avgConcentricMs || 0) + (avgEccentricMs || 0);
  const target = (t.up + t.down) * 1000;
  if (!actual) return null;
  if (actual < target * 0.8) return "too fast";
  if (actual > target * 1.25) return "too slow";
  return null;
}
