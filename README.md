# Durhack-2026 — physio pose pipeline (draft)

Webcam → MediaPipe Pose → joint angle → rep state machine → game events. No training data, no backend.

## Run it

Any static server works (ES modules won't load from `file://`):

```sh
npm start                      # serves on http://localhost:5173
# or
python -m http.server 5173
```

Open http://localhost:5173 in Chrome, click **Start camera**, allow the webcam.

## Pipeline

| Stage | File | What it does |
|---|---|---|
| 1. Pose | `src/pose.js` | Loads Pose Landmarker (lite model, GPU), runs `detectForVideo` every frame, returns 33 landmarks |
| 2. Angles | `src/angles.js` | `angle2D(a,b,c)` at a joint, `tiltFromVertical`, side picking by visibility, EMA smoother |
| 3. Exercises | `src/exercises.js` | Exercise table (joints, rest/target angle, form checks) + `RepCounter` state machine |
| 4. Game | `src/game.js` | Runner that jumps on `rep` (height ∝ ROM), charges a shield on `hold`, crouches with live `progress` |
| Glue | `src/main.js` | Wires camera → angle → counter → DOM + game, draws the skeleton overlay |

## Events the game consumes

- `progress` `{ progress 0..1, phase }` every frame
- `phase` `{ phase: "rest" | "active" }` on transitions
- `hold` `{ holdMs }` while at target
- `rep` `{ count, rom, durationMs, holdMs }` on a completed rest → active → rest cycle

## Adding an exercise

Add an entry to `EXERCISES` in `src/exercises.js`: three landmark indices, the angle at rest, the angle at the
target position, and optional `formChecks`. Everything else (gauge, counter, game) picks it up automatically.

## Tuning

- Thresholds: `restAngle` / `targetAngle` per exercise; hysteresis in `RepCounter` (`enterTarget` 0.8, `exitTarget` 0.25).
- Jitter: `Smoother(alpha)` in `main.js` — lower alpha = smoother but laggier.
- Tick **Debug** in the header to see raw vs smoothed angle, progress, phase, and landmark visibility live.
