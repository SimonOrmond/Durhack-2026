# Durhack-2026 — physio exercise game

Two roles, one app. A **physiotherapist** prescribes exercises; a **patient** does them in front of a webcam and a
game reacts to each rep. Results are saved to **MongoDB Atlas** so the physio can see range-of-motion over time.

Pose tracking runs entirely in the browser (MediaPipe Pose Landmarker). The backend only stores small JSON.

## Run it

```sh
npm install
npm start            # http://localhost:5173 -> login page
```

With no `.env`, the server uses an **in-memory MongoDB** and seeds demo accounts on every start. To use Atlas:

```sh
cp .env.example .env     # paste your Atlas connection string into MONGODB_URI
npm run seed             # once: creates demo physios, patients, prescriptions, past sessions
npm start
```

`npm run seed:reset` wipes the three collections first. `npm run dev` restarts the server on file changes.

### Demo accounts

| Role | Username | Password |
|---|---|---|
| Physio | `dr.khan`, `dr.lee` | `physio` |
| Patient | `alice`, `bob`, `chen` (dr.khan) · `dana`, `eve`, `femi` (dr.lee) | `patient` |

All data is made up. Passwords are stored in plain text on purpose: this is a hackathon demo, not an auth system.

### Demo flow

1. Sign in as `dr.khan` → pick a patient → **Send prescription** (exercise, sets × reps, hold, optional per-patient angle targets, note).
2. Sign out, sign in as that patient → the prescription appears under **Today's plan** → click it → **Start camera** → do the reps.
   Each set counts to the prescribed reps, then a rest countdown runs (physio sets the seconds; **Skip rest** available;
   reps during rest are ignored). After the last set, counting stops and the session is saved and sent to the physio
   automatically. **Finish & save** ends early with the reps so far.
3. Back as the physio: the session appears under **Recent sessions** (refreshes every 10 s, so two laptops works live).

## Pages

| Page | Who | What |
|---|---|---|
| `login.html` | everyone | username/password → stores user in `localStorage`, routes by role |
| `physio.html` | physio | patient list, prescribe form, current plan, recent sessions |
| `index.html` | patient | plan cards, webcam + pose overlay, rep counter, game, session recording. **Free play** dropdown works without a prescription (still recorded) |

## Pipeline (browser)

| Stage | File | What it does |
|---|---|---|
| 1. Pose | `src/pose.js` | Loads Pose Landmarker lazily from CDN, runs `detectForVideo` per frame; loop has pause/resume |
| 2. Angles | `src/angles.js` | `angle2D(a,b,c)` at a joint, `tiltFromVertical`, side picking by visibility, EMA smoother |
| 3. Exercises | `src/exercises.js` | Exercise table (joints, rest/target angle, form checks) + `RepCounter` state machine |
| 4. Game | `src/game.js` | Runner that jumps on `rep` (height ∝ ROM), charges a shield on `hold`, crouches with live `progress` |
| Glue | `src/main.js` | Wires camera → angle → counter → DOM + game, applies prescriptions, records sessions |
| Charts | `src/charts.js` | Dependency-free SVG line / bar / stacked-bar charts with hover tooltips |
| Session | `src/session.js` | `SessionRecorder`: collects reps + form cues, posts to the API |
| API client | `src/api.js` | `Api.*` helpers, `getUser`/`requireUser`/`logout` |

Pipeline events: `progress` (every frame), `phase`, `hold`, `rep { count, rom, durationMs, holdMs }`.

## Backend (`server/`)

Express serves the static files and a JSON API on one port. Identity is an `x-user-id` header set by the client after login.

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/login` | — | `{ username, password }` → user (without password) |
| GET | `/api/exercises` | — | exercise catalogue from `src/exercises.js` |
| GET | `/api/physios/:id/patients` | any | patients of a physio |
| GET | `/api/patients/:id/prescriptions` | any | active prescriptions (`?all=1` includes stopped) |
| POST | `/api/prescriptions` | physio | create; validates exercise key, clamps numbers, keeps only real angle overrides |
| DELETE | `/api/prescriptions/:id` | physio | deactivate |
| POST | `/api/sessions` | patient | save reps; server computes `summary` |
| GET | `/api/patients/:id/sessions` | any | recent sessions, summaries only (reps array excluded) |
| GET | `/api/sessions/:id` | any | one full session with every rep |
| GET | `/api/patients/:id/progress` | any | **aggregation pipeline**: per exercise per day → avg/best ROM, reps, cue count |

### What a rep records

Every completed rep is timed by the state machine in `src/exercises.js` and stored on the session:

| Field | Meaning |
|---|---|
| `rom` | fraction of the prescribed range reached (1.0 = hit the target angle) |
| `peakAngle` | actual joint angle at the deepest point, in degrees |
| `concentricMs` / `eccentricMs` | time in the muscle-shortening vs lengthening phase. Which direction is which is per exercise (`concentric: "toTarget" \| "toRest"`; a squat's way down is eccentric) |
| `holdMs` | time on the plateau at the top of the rep (within 6% of the peak) |
| `durationMs` | concentric + hold + eccentric |
| `restBeforeMs` | pause since the previous rep |
| `cues` | form cues that fired during the rep |

The server computes a `summary` per session (avg/best ROM, avg peak angle, avg concentric/eccentric/hold, tempo in
seconds per rep and reps per minute, cue counts) so the dashboard lists sessions without loading every rep.

**Physio dashboard analysis** (per patient): latest-session tiles, a progress line chart with an exercise filter and a
metric switch (ROM, peak angle, tempo, concentric, eccentric, hold, cues), a sessions table, and a rep-by-rep view with
ROM bars against the target, stacked concentric/hold/eccentric bars, and a full rep table.

### Collections

```
users          { username, password, name, role: "physio"|"patient", physioId?, condition? }
prescriptions  { patientId, physioId, exerciseKey, exerciseName, sets, reps, holdSeconds, restSeconds,
                 angleOverrides: { restAngle?, targetAngle? } | null, notes, active, createdAt }
sessions       { patientId, physioId, prescriptionId, exerciseKey, exerciseName, startedAt, endedAt, setsCompleted,
                 reps: [{ n, rom, peakAngle, durationMs, concentricMs, eccentricMs, holdMs, restBeforeMs, cues: [] }],
                 summary: { repCount, avgRom, bestRom, avgPeakAngle, bestPeakAngle, avgDurationMs, avgConcentricMs,
                            avgEccentricMs, avgHoldMs, avgRestMs, tempoRepsPerMin, cueCount, cueBreakdown }, source }
```

Indexes: `users.username` (unique), `users.physioId`, `prescriptions {patientId, active}`,
`sessions {patientId, startedAt desc}`, `sessions.prescriptionId`.

The progress endpoint is `$match → $unwind reps → $group by exercise + $dateTrunc(day) → $project`. It's the data
for a physio-side chart (not built yet) and a natural fit for Atlas Charts.

## Exercises included

| Group | Exercise | Camera | Angle measured | Rest → target |
|---|---|---|---|---|
| Knee / hip | Squat / sit-to-stand | side-on | hip–knee–ankle | 170° → 95° |
| Knee | Seated knee extension | side-on | hip–knee–ankle | 95° → 165° |
| Knee | Straight leg raise (lying) | side-on | shoulder–hip–knee | 175° → 130° |
| Knee | Heel slide (knee flexion) | side-on | hip–knee–ankle | 175° → 90° |
| Hip | Standing hip abduction | facing | shoulder–hip–ankle | 175° → 145° |
| Hip / lower back | Glute bridge | side-on | shoulder–hip–knee | 125° → 170° |
| Shoulder | Shoulder abduction (arm raise) | facing | hip–shoulder–elbow | 20° → 140° |
| Shoulder | Shoulder flexion (forward raise) | side-on | hip–shoulder–wrist | 15° → 150° |
| Elbow | Elbow flexion (bicep curl) | facing | shoulder–elbow–wrist | 160° → 50° |

Based on exercises that recur across NHS trust home-programme leaflets for knee, hip and shoulder rehab. Angles are
starting points, not clinical values. A physio can override rest/target per prescription, which is the per-patient
calibration hook. Form cues are shared helpers in `src/exercises.js`: `trunkUpright`, `kneeStraight`, `elbowStraight`.

## Adding an exercise

Add an entry to `EXERCISES` in `src/exercises.js`: three landmark indices, rest angle, target angle, `group`, and
optional `formChecks`. The dropdowns, gauge, counter, game, API catalogue and prescribe form all pick it up.

## Tuning / debugging

- Thresholds: `restAngle` / `targetAngle` per exercise; hysteresis in `RepCounter` (`enterTarget` 0.8, `exitTarget` 0.25).
- Jitter: `Smoother(alpha)` in `main.js` — lower alpha = smoother but laggier.
- Tick **Debug** to see raw vs smoothed angle, progress, phase, landmark visibility, and the full skeleton.
- Console: `__physio.counter`, `__physio.recorder`, `__physio.game`, `__physio.exercise`. Fake a rep with
  `__physio.counter.dispatchEvent(new CustomEvent("rep", { detail: { count: 1, rom: 0.9, durationMs: 1200, holdMs: 0 } }))`.
- **Space** / **P** pauses.
