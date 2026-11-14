// Records one exercise session (reps + the form cues that fired) and saves it to the API.
import { Api } from "./api.js";

export class SessionRecorder {
  constructor() {
    this.reset();
  }
  reset() {
    this.prescription = null;
    this.exerciseKey = null;
    this.startedAt = null;
    this.reps = [];
    this.pendingCues = new Set();
    this.setsCompleted = 0;
    this.saved = false;
  }
  /** Begin recording. prescription may be null for free play (session is still saved). */
  start(exerciseKey, prescription = null) {
    this.reset();
    this.exerciseKey = exerciseKey;
    this.prescription = prescription;
    this.startedAt = new Date();
  }
  get active() {
    return !!this.startedAt && !this.saved;
  }
  /** A form cue fired; attach it to the rep currently in progress. */
  noteCue(cue) {
    if (this.active) this.pendingCues.add(cue);
  }
  /** Rep completed (detail from RepCounter's "rep" event). */
  addRep({ rom, durationMs, holdMs }) {
    if (!this.active) return;
    this.reps.push({ rom, durationMs, holdMs, cues: [...this.pendingCues] });
    this.pendingCues.clear();
  }
  completeSet() {
    this.setsCompleted += 1;
  }
  /** Reps done in the current set (for a "Rep 4/10" display). */
  repsInCurrentSet(repsPerSet) {
    return this.reps.length - this.setsCompleted * repsPerSet;
  }
  /** POST to the API. Resolves to the saved document, or null if there was nothing to save. */
  async save() {
    if (!this.active || !this.reps.length) return null;
    const doc = await Api.saveSession({
      exerciseKey: this.exerciseKey,
      prescriptionId: this.prescription?._id ?? null,
      startedAt: this.startedAt.toISOString(),
      setsCompleted: this.setsCompleted,
      reps: this.reps,
    });
    this.saved = true;
    return doc;
  }
}
