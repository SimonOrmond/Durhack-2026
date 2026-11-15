// Form-review recording: a patient records ONE set (only after explicit consent), previews it
// locally, and chooses to send it to their physio or discard it. Nothing leaves the browser
// until "Send" is pressed.
//
// Clips are small on purpose so they fit MongoDB's free tier: 480px wide, 15 fps, ~300 kbps,
// capped at 90 s. "Skeleton only" mode records just the pose overlay (no face or room).

import { Api } from "./api.js";

export const RETENTION_DAYS = 30;
const MAX_MS = 90_000;
const WIDTH = 480;
const FPS = 15;
const BITRATE = 300_000;
const CHUNK = 1.5 * 1024 * 1024; // must match server/videos.js

const MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
export const recordingSupported = () =>
  typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
const pickMime = () => MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const fmtSec = (ms) => `${Math.round(ms / 1000)}s`;

/** Small modal built on <dialog>. Resolves with the value passed to close(). */
function modal(html, setup) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "fv-dialog";
    dlg.innerHTML = html;
    document.body.appendChild(dlg);
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    setup?.(dlg, close);
    dlg.showModal();
  });
}

/** Explicit consent, asked every time before recording. Resolves to { mode, consent } or null. */
export function askConsent({ exerciseName, setNumber }) {
  const consentText =
    `I agree to record a video of set ${setNumber} of ${exerciseName} and, if I choose to send it, ` +
    `share it with my physio to review my form. Recording only happens while the red REC badge is showing. ` +
    `Nothing is sent until I press Send, and I can preview and discard it first. Only my physio and I can view it. ` +
    `It is deleted automatically after ${RETENTION_DAYS} days, and I can delete it at any time.`;
  return modal(
    `
    <h3>🎥 Record this set for your physio?</h3>
    <p class="muted">Your physio can watch your technique and send you feedback.</p>
    <fieldset class="fv-modes">
      <legend>What to record</legend>
      <label><input type="radio" name="fv-mode" value="camera" checked> <span><b>Camera + skeleton</b><br><span class="muted small">Your camera video with the tracking lines on top</span></span></label>
      <label><input type="radio" name="fv-mode" value="skeleton"> <span><b>Skeleton only</b> (more private)<br><span class="muted small">Just the tracking lines. Your face and room are not recorded</span></span></label>
    </fieldset>
    <ul class="fv-facts">
      <li>⏺ Records this set only, up to ${MAX_MS / 1000} seconds</li>
      <li>👀 You preview it first. Nothing is sent unless you press <b>Send</b></li>
      <li>🔒 Only you and your physio can view it</li>
      <li>🗑 Auto-deleted after ${RETENTION_DAYS} days; you can delete it any time</li>
    </ul>
    <label class="fv-consent"><input type="checkbox" id="fv-agree"> <span>${esc(consentText)}</span></label>
    <div class="fv-actions">
      <button type="button" data-cancel>Not now</button>
      <button type="button" class="btn-start" data-ok disabled>I agree, start recording</button>
    </div>`,
    (dlg, close) => {
      const ok = dlg.querySelector("[data-ok]");
      dlg.querySelector("#fv-agree").addEventListener("change", (e) => (ok.disabled = !e.target.checked));
      dlg.querySelector("[data-cancel]").addEventListener("click", () => close(null));
      ok.addEventListener("click", () => {
        const mode = dlg.querySelector('input[name="fv-mode"]:checked').value;
        close({ mode, consent: { given: true, text: consentText, at: new Date().toISOString() } });
      });
    }
  );
}

/** Records a composite of the camera video and the pose overlay into a small WebM/MP4. */
export class FormRecorder {
  constructor({ video, overlay, badgeHost }) {
    this.video = video;
    this.overlay = overlay;
    this.badgeHost = badgeHost;
    this.recorder = null;
    this.raf = 0;
    this.timer = 0;
  }

  get recording() {
    return !!this.recorder && this.recorder.state !== "inactive";
  }

  /** Start recording. onAutoStop fires if the 90 s cap is reached. */
  start({ mode, meta, onAutoStop }) {
    if (this.recording) return;
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = Math.round((WIDTH * vh) / vw);
    const ctx = canvas.getContext("2d");
    const draw = () => {
      if (mode === "skeleton") {
        ctx.fillStyle = "#0b0e14";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      }
      if (this.overlay.width) ctx.drawImage(this.overlay, 0, 0, canvas.width, canvas.height);
      this.raf = requestAnimationFrame(draw);
    };
    draw();

    const mimeType = pickMime();
    const stream = canvas.captureStream(FPS);
    this.recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: BITRATE });
    this.parts = [];
    this.mode = mode;
    this.meta = meta;
    this.mimeType = mimeType || "video/webm";
    this.startedAt = performance.now();
    this.pausedMs = 0;
    this.recorder.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.recorder.start(1000);
    this.timer = setTimeout(() => onAutoStop?.(), MAX_MS);
    this.#badge(true);
  }

  pause() {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pauseStart = performance.now();
      this.#badge(true, "PAUSED");
    }
  }
  resume() {
    if (this.recorder?.state === "paused") {
      this.recorder.resume();
      this.pausedMs += performance.now() - (this.pauseStart ?? performance.now());
      this.#badge(true);
    }
  }

  /** Stop and resolve with { blob, durationMs, mimeType, mode, meta } (or null if nothing was recorded). */
  stop() {
    if (!this.recorder) return Promise.resolve(null);
    const rec = this.recorder;
    this.recorder = null;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.#badge(false);
    return new Promise((resolve) => {
      rec.onstop = () => {
        rec.stream.getTracks().forEach((t) => t.stop());
        const durationMs = Math.round(performance.now() - this.startedAt - this.pausedMs);
        const blob = new Blob(this.parts, { type: this.mimeType.split(";")[0] });
        resolve(blob.size ? { blob, durationMs, mimeType: this.mimeType, mode: this.mode, meta: this.meta } : null);
      };
      if (rec.state !== "inactive") rec.stop();
      else rec.onstop();
    });
  }

  /** Stop and throw the recording away (never uploaded). */
  async cancel() {
    await this.stop();
  }

  #badge(show, text = "REC") {
    let el = this.badgeHost.querySelector(".rec-badge");
    if (!show) return el?.remove();
    if (!el) {
      el = document.createElement("div");
      el.className = "rec-badge";
      el.setAttribute("role", "status");
      this.badgeHost.appendChild(el);
    }
    el.innerHTML = `<span class="rec-dot"></span>${text} · recording for your physio`;
  }
}

/** Preview the clip locally, then Send (upload) or Discard. Resolves to "sent" | "discarded". */
export function previewAndSend(clip) {
  const url = URL.createObjectURL(clip.blob);
  const { meta } = clip;
  return modal(
    `
    <h3>Send set ${meta.setNumber} to your physio?</h3>
    <video class="fv-preview" src="${url}" controls playsinline></video>
    <p class="muted small">${esc(meta.exerciseName)} · ${fmtSec(clip.durationMs)} · ${fmtMB(clip.blob.size)} · ${clip.mode === "skeleton" ? "skeleton only" : "camera + skeleton"}</p>
    <div class="fv-progress" hidden><div></div></div>
    <p class="fv-status muted small"></p>
    <div class="fv-actions">
      <button type="button" data-discard>Discard</button>
      <button type="button" class="btn-start" data-send>Send to physio</button>
    </div>`,
    (dlg, close) => {
      const done = (v) => {
        URL.revokeObjectURL(url);
        close(v);
      };
      const status = dlg.querySelector(".fv-status");
      const bar = dlg.querySelector(".fv-progress");
      dlg.querySelector("[data-discard]").addEventListener("click", () => done("discarded"));
      dlg.querySelector("[data-send]").addEventListener("click", async (e) => {
        const btns = dlg.querySelectorAll("button");
        btns.forEach((b) => (b.disabled = true));
        bar.hidden = false;
        try {
          await uploadClip(clip, (p) => {
            bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
            status.textContent = `Sending… ${Math.round(p * 100)}%`;
          });
          status.textContent = "Sent to your physio ✓";
          setTimeout(() => done("sent"), 900);
        } catch (err) {
          status.textContent = `Couldn't send: ${err.message}`;
          btns.forEach((b) => (b.disabled = false));
          e.target.textContent = "Try again";
        }
      });
    }
  );
}

/** Upload in chunks so each request stays under the hosting body limit. */
async function uploadClip(clip, onProgress) {
  const { blob, meta } = clip;
  const { _id, chunkCount } = await Api.startVideo({
    prescriptionId: meta.prescriptionId,
    exerciseKey: meta.exerciseKey,
    setNumber: meta.setNumber,
    mode: clip.mode,
    mimeType: clip.mimeType,
    size: blob.size,
    durationMs: clip.durationMs,
    consent: meta.consent,
  });
  for (let n = 0; n < chunkCount; n++) {
    await Api.uploadVideoChunk(_id, n, blob.slice(n * CHUNK, (n + 1) * CHUNK));
    onProgress?.((n + 1) / chunkCount);
  }
  await Api.completeVideo(_id);
  return _id;
}

/** Download a stored clip (chunk by chunk) and return an object URL for a <video>. */
export async function loadVideoUrl(v) {
  const parts = [];
  for (let n = 0; n < v.chunkCount; n++) parts.push(await Api.videoChunk(v._id, n));
  return URL.createObjectURL(new Blob(parts, { type: v.mimeType }));
}
