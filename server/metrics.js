// Per-rep normalisation and per-session summary. Shared by the API and the seed script.
//
// A stored rep:
//   { n, rom, peakAngle, durationMs, concentricMs, eccentricMs, holdMs, restBeforeMs, cues: [] }
//   rom          0..1.5   fraction of the prescribed range reached (1 = hit the target angle)
//   peakAngle    degrees  actual joint angle at the deepest point
//   concentricMs          time in the muscle-shortening phase (e.g. standing up from a squat)
//   eccentricMs           time in the lengthening / lowering phase
//   holdMs                time held at the target
//   restBeforeMs          pause since the previous rep (null for the first)

import { repTempoScore } from "../src/tempo.js";

const ms = (v) => Math.max(0, Math.round(Number(v) || 0));
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** Game stats sent by the client, clamped to sane values (or null when absent). */
export function normaliseGame(g) {
  if (!g || typeof g !== "object") return null;
  const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  return {
    mode: g.mode === "runner" ? "runner" : "glider",
    coins: int(g.coins, 10000),
    coinsOffered: int(g.coinsOffered, 10000),
    hits: int(g.hits, 10000),
    score: int(g.score, 1e7),
    tunnelPct: g.tunnelPct == null ? null : +clamp01(g.tunnelPct).toFixed(3),
    playSeconds: int(g.playSeconds, 86400),
  };
}

/**
 * Patient-facing performance scores (all 0..1):
 *   tempoAccuracy  how closely each rep's up/down time matched the prescribed tempo
 *   completion     reps done out of the prescribed sets × reps (null for free play)
 *   coinRate       coins collected out of coins the dino passed
 *   score          weighted overall: tempo 40%, completion 40%, tunnel accuracy 20%
 *                  (weights re-balance over whichever parts are available)
 */
export function scorePerformance(reps, { tempo, setsPrescribed, repsPerSet, game }) {
  const tempoAccuracy = reps.length ? avg(reps.map((r) => repTempoScore(r.concentricMs, r.eccentricMs, tempo))) : 0;
  const target = setsPrescribed && repsPerSet ? setsPrescribed * repsPerSet : null;
  const completion = target ? clamp01(reps.length / target) : null;
  const tunnel = game?.tunnelPct ?? null;
  const parts = [
    [tempoAccuracy, 0.4],
    [completion, 0.4],
    [tunnel, 0.2],
  ].filter(([v]) => v != null);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  const score = wsum ? parts.reduce((s, [v, w]) => s + v * w, 0) / wsum : 0;
  return {
    tempo: tempo ?? null,
    tempoAccuracy: +tempoAccuracy.toFixed(3),
    completion: completion == null ? null : +completion.toFixed(3),
    coinRate: game?.coinsOffered ? +clamp01(game.coins / game.coinsOffered).toFixed(3) : null,
    score: Math.round(score * 100), // 0..100
  };
}
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Normalise one rep from the client into the stored shape. */
export function normaliseRep(r, i) {
  const peak = Number(r.peakAngle);
  const rest = Number(r.restBeforeMs);
  return {
    n: i + 1,
    rom: +Math.max(0, Math.min(1.5, Number(r.rom) || 0)).toFixed(2),
    peakAngle: Number.isFinite(peak) && r.peakAngle !== null ? Math.round(peak) : null,
    durationMs: ms(r.durationMs),
    concentricMs: ms(r.concentricMs),
    eccentricMs: ms(r.eccentricMs),
    holdMs: ms(r.holdMs),
    restBeforeMs: r.restBeforeMs != null && Number.isFinite(rest) && rest >= 0 ? Math.round(rest) : null,
    cues: Array.isArray(r.cues) ? r.cues.slice(0, 10).map(String) : [],
  };
}

/** Per-session summary the physio dashboard reads without loading every rep. */
export function summarise(reps, startedAt, endedAt) {
  const minutes = Math.max(1 / 60, (new Date(endedAt) - new Date(startedAt)) / 60000);
  const rests = reps.map((r) => r.restBeforeMs).filter((x) => x != null);
  const peaks = reps.map((r) => r.peakAngle).filter((x) => x != null);
  const best = reps.reduce((a, b) => (b.rom > a.rom ? b : a), reps[0]);
  const cueCounts = {};
  for (const c of reps.flatMap((r) => r.cues)) cueCounts[c] = (cueCounts[c] ?? 0) + 1;
  return {
    repCount: reps.length,
    avgRom: +avg(reps.map((r) => r.rom)).toFixed(2),
    bestRom: +best.rom.toFixed(2),
    avgPeakAngle: peaks.length ? Math.round(avg(peaks)) : null,
    bestPeakAngle: best.peakAngle ?? null,
    avgDurationMs: Math.round(avg(reps.map((r) => r.durationMs))),
    avgConcentricMs: Math.round(avg(reps.map((r) => r.concentricMs))),
    avgEccentricMs: Math.round(avg(reps.map((r) => r.eccentricMs))),
    avgHoldMs: Math.round(avg(reps.map((r) => r.holdMs))),
    avgRestMs: rests.length ? Math.round(avg(rests)) : null,
    tempoRepsPerMin: +(reps.length / minutes).toFixed(1),
    cueCount: reps.reduce((s, r) => s + r.cues.length, 0),
    cueBreakdown: Object.entries(cueCounts).map(([cue, count]) => ({ cue, count })),
  };
}
