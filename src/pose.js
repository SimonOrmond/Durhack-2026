// Stage 1: pose tracking. Wraps MediaPipe Pose Landmarker running on a live webcam.
// Emits one callback per video frame with normalized (0..1) landmarks and 3D world landmarks.
//
// The MediaPipe bundle (~2 MB) is loaded lazily with a dynamic import so the page UI
// is interactive immediately and we can show download progress in the status line.

const CDN_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3";
const WASM_URL = `${CDN_BASE}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

let mpPromise = null;

/** Download the MediaPipe tasks-vision module once. Resolves to the module namespace. */
export function loadMediaPipe(onStatus = () => {}) {
  if (!mpPromise) {
    onStatus("Downloading MediaPipe (~2 MB)…");
    mpPromise = import(CDN_BASE).catch((err) => {
      mpPromise = null; // allow retry
      throw new Error(`Could not load MediaPipe from CDN (offline?): ${err.message}`);
    });
  }
  return mpPromise;
}

/** Returns { landmarker, mp } where mp is the MediaPipe module (for DrawingUtils, POSE_CONNECTIONS). */
export async function createPoseTracker({ onStatus = () => {} } = {}) {
  const mp = await loadMediaPipe(onStatus);
  onStatus("Loading pose model…");
  const vision = await mp.FilesetResolver.forVisionTasks(WASM_URL);
  let landmarker;
  try {
    landmarker = await mp.PoseLandmarker.createFromOptions(vision, options("GPU"));
  } catch (err) {
    console.warn("GPU delegate failed, falling back to CPU", err);
    onStatus("GPU unavailable, loading CPU model…");
    landmarker = await mp.PoseLandmarker.createFromOptions(vision, options("CPU"));
  }
  onStatus("Model ready.");
  return { landmarker, mp };
}

function options(delegate) {
  return {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      `Camera API unavailable. Serve the page over http://localhost or https (current: ${location.protocol}//${location.host || "file"}).`
    );
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    const hints = {
      NotAllowedError: "Camera permission denied. Click the camera icon in Chrome's address bar and allow it, then reload.",
      NotFoundError: "No camera found.",
      NotReadableError: "Camera is in use by another app (Teams/Zoom/OBS?). Close it and retry.",
      OverconstrainedError: "Camera doesn't support the requested resolution.",
    };
    throw new Error(hints[err.name] ?? `${err.name}: ${err.message}`);
  }
  video.srcObject = stream;
  await new Promise((res) => (video.onloadedmetadata = res));
  await video.play();
  return stream;
}

/**
 * Runs detection on every new video frame.
 * onFrame({ landmarks, worldLandmarks, timestampMs, fps }) — landmarks is null when no person is seen.
 * Returns a controller: { stop(), pause(), resume(), toggle(), get paused }.
 * While paused the camera keeps streaming but no frames are sent to the model or to onFrame.
 */
export function runDetectionLoop(landmarker, video, onFrame) {
  let running = true;
  let paused = false;
  let lastVideoTime = -1;
  let lastTs = performance.now();
  let fps = 0;

  const tick = () => {
    if (!running) return;
    if (paused) {
      requestAnimationFrame(tick);
      return;
    }
    if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const result = landmarker.detectForVideo(video, now);
      fps = fps * 0.9 + (1000 / Math.max(1, now - lastTs)) * 0.1;
      lastTs = now;
      onFrame({
        landmarks: result.landmarks?.[0] ?? null,
        worldLandmarks: result.worldLandmarks?.[0] ?? null,
        timestampMs: now,
        fps,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
    },
    pause() {
      paused = true;
    },
    resume() {
      // Reset timing so the first frame after a pause doesn't report a bogus fps.
      lastTs = performance.now();
      paused = false;
    },
    toggle() {
      paused ? this.resume() : this.pause();
      return paused;
    },
    get paused() {
      return paused;
    },
  };
}
