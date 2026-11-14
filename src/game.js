// Stage 4: DurHack Dino ("Dino Dan") game driven by exercise motion.
// Supports two modes:
//   - "glider" (default): smooth cave humps at one consistent, physio-prescribed tempo (see TEMPOS)
//   - "runner": bicep-curl angle states (<=90 jump, 90-121 run, >=121 duck), hold -> charges shield

// Half the height of the glider cave corridor (was 57 → 114px corridor; now 144px).
const CAVE_HALF_H = 72;

// Rep tempos a physio can prescribe. Each sets how long one cave hill takes to pass:
// lift (up), hold at the top, controlled lower (down), then a rest in the valley.
export const TEMPOS = {
  slow:   { key: "slow",   name: "Slow",   up: 3,    hold: 1,    down: 3,    rest: 1.5 },
  medium: { key: "medium", name: "Medium", up: 2,    hold: 0.75, down: 2,    rest: 1.25 },
  fast:   { key: "fast",   name: "Fast",   up: 1.25, hold: 0.5,  down: 1.25, rest: 1 },
};
export const DEFAULT_TEMPO = "slow";
export const tempoSummary = (key) => {
  const t = TEMPOS[key] ?? TEMPOS[DEFAULT_TEMPO];
  return `${t.up}s up · ${t.hold}s hold · ${t.down}s down`;
};

const PB_KEYS = {
  glider: "durhack_glider_pb",
  runner: "durhack_dino_pb",
};

export const RUNNER_STATES = {
  jumping: { state: "jumping", label: "JUMPING ↑", short: "JUMP", color: "#4fd1a0", rgb: "79, 209, 160" },
  running: { state: "running", label: "RUNNING →", short: "RUN", color: "#60a5fa", rgb: "96, 165, 250" },
  ducking: { state: "ducking", label: "DUCKING ↓", short: "DUCK", color: "#f59e0b", rgb: "245, 158, 11" },
};

export class RunnerGame {
  static stateFromAngle(angle, progress, concentric = "toTarget") {
    if (concentric === "toRest") {
      const p = progress ?? 0;
      if (p >= 0.45) return "ducking";
      if (p <= 0.25) return "jumping";
      return "running";
    }
    const a =
      typeof angle === "number" && Number.isFinite(angle)
        ? angle
        : 148 - Math.max(0, Math.min(1.2, progress ?? 0.5)) * 90;
    if (a <= 90) return "jumping";
    if (a >= 121) return "ducking";
    return "running";
  }

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = canvas.width || 480;
    this.H = 320;
    this.groundY = this.H - 46;
    this.mode = "glider";
    this.hasStarted = false;
    this.#loadPb();
    this.reset(true);
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    }
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  #pbKey() {
    return PB_KEYS[this.mode] || PB_KEYS.glider;
  }

  #loadPb() {
    let v = 0;
    try {
      v = Number(globalThis.localStorage?.getItem?.(this.#pbKey()) || 0) || 0;
    } catch {}
    this.pb = v;
  }

  setMode(mode) {
    const next = mode === "runner" ? "runner" : "glider";
    if (next === this.mode) return;
    this.mode = next;
    this.#loadPb();
    this.reset(!this.hasStarted);
  }

  resize() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw > 0 && ch > 0) {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      this.H = 320;
      this.W = Math.max(300, Math.round(this.H * (cw / ch)));
      const bw = Math.round(this.W * dpr);
      const bh = Math.round(this.H * dpr);
      if (this.canvas.width !== bw) this.canvas.width = bw;
      if (this.canvas.height !== bh) this.canvas.height = bh;
      this.ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
      const prevGround = this.groundY;
      this.groundY = this.H - 46;
      if (this.player) {
        this.player.x = Math.min(86, Math.max(52, Math.round(this.W * 0.2)));
        if (this.mode === "glider") {
          this.player.y = Math.min(this.player.y, this.groundY - 8);
        } else if (this.player.onGround || this.player.y >= prevGround - 1) {
          this.player.y = this.groundY;
        } else {
          this.player.y = Math.min(this.player.y, this.groundY);
        }
      }
    }
  }

  reset(keepWaiting = false) {
    this.groundY = (this.H || 320) - 46;
    this.mode = this.mode ?? "glider";
    this.tempo = this.tempo ?? DEFAULT_TEMPO;
    const isGlider = this.mode === "glider";
    this.player = {
      x: Math.min(86, Math.max(52, Math.round((this.W || 480) * 0.2))),
      y: isGlider ? this.groundY - 10 : this.groundY,
      vy: 0,
      w: 34,
      h: 48,
      onGround: !isGlider,
      ducking: false,
      animTime: 0,
    };
    this.obstacles = [];
    this.humps = [];
    this.coinItems = [];
    this.popups = [];
    this.scrollX = 0;
    this.caveHitCooldown = 0;
    this.spawnTimer = isGlider ? 1.0 : 1.2;
    this.spawnIndex = 0;
    this.speed = isGlider ? 160 : 175;
    this.score = 0;
    this.coins = 0;
    this.hits = 0;
    this.newPb = false;
    this.shield = 0; // 0..1
    this.shieldActive = false;
    this.flash = 0;
    this.lastJumpRom = 0;
    this.resting = false;
    this.holdTargetMs = 2000;
    this.concentric = this.concentric ?? "toTarget"; // "toTarget" (curl/raise) | "toRest" (squat)
    this.didLiftJump = false;
    this.queuedJumpRom = 0;
    this.peakInActive = 0;
    this.lastProgress = 0;
    this.currentProgress = 0;
    this.targetProgress = 0;
    this.runnerState = "running";
    this.currentAngle = 105;
    this.duckTimer = 0;
    this.groundOffset = 0;
    this.animClock = 0;
    if (keepWaiting || !this.hasStarted) {
      this.paused = true;
      this.pauseReason = "waiting";
    } else {
      this.paused = false;
      this.pauseReason = null;
    }
    this.restText = "";
  }

  addScore(pts) {
    if (pts <= 0) return;
    this.score += pts;
    if (this.score > this.pb) {
      this.pb = this.score;
      this.newPb = true;
      try {
        globalThis.localStorage?.setItem?.(this.#pbKey(), String(this.pb));
      } catch {}
    }
  }

  start() {
    this.hasStarted = true;
    this.resume();
  }

  setConcentric(dir) {
    this.concentric = dir === "toRest" ? "toRest" : "toTarget";
  }

  setResting(resting) {
    this.resting = !!resting;
    if (this.resting) {
      this.obstacles = [];
      this.humps = [];
      this.coinItems = [];
    }
  }

  /** Set the rep tempo (slow | medium | fast). Hills not yet on screen are respawned at the new tempo. */
  setTempo(key) {
    const next = TEMPOS[key] ? key : DEFAULT_TEMPO;
    if (next === this.tempo) return;
    this.tempo = next;
    if (!this.humps?.length) return;
    const viewEnd = this.scrollX + this.W;
    this.humps = this.humps.filter((h) => h.worldStartX <= viewEnd);
    const lastEnd = this.humps.length ? this.humps[this.humps.length - 1].worldEndX : this.scrollX;
    this.coinItems = this.coinItems.filter((c) => c.x + this.scrollX <= lastEnd);
  }

  setHoldTargetMs(ms) {
    const n = Number(ms);
    this.holdTargetMs = Number.isFinite(n) && n > 0 ? Math.max(1000, n) : 2000;
  }

  pause(reason = "paused") {
    this.paused = true;
    this.pauseReason = reason;
    if (reason === "resting" || reason === "done" || reason === "waiting") {
      this.player.y = this.mode === "glider" ? this.groundY - 10 : this.groundY;
      this.player.vy = 0;
      this.player.onGround = this.mode !== "glider";
      this.player.ducking = false;
      this.flash = 0;
    }
  }
  resume() {
    this.hasStarted = true;
    this.paused = false;
    this.pauseReason = null;
    this.last = performance.now(); // no catch-up jump after a long pause
  }

  #gliderTargetY() {
    const restY = this.groundY - 10;
    const topY = 96;
    const raw = Math.max(0, Math.min(1.05, this.targetProgress));
    const level = this.concentric === "toRest" ? Math.max(0, 1 - raw) : raw;
    return restY + (topY - restY) * level;
  }

  triggerJump(rom) {
    if (this.paused || this.mode === "glider") return false;
    this.duckTimer = 0;
    this.player.ducking = false;
    const nearGround = this.player.vy > 0 && this.player.y >= this.groundY - 42;
    if (!this.player.onGround && !nearGround) {
      this.queuedJumpRom = Math.max(this.queuedJumpRom, rom);
      return true;
    }
    const strength = 0.6 + Math.min(1.2, Math.max(0, rom)) * 0.45; // 0.60..1.14
    this.player.vy = -580 * strength;
    this.player.onGround = false;
    this.lastJumpRom = rom;
    this.addScore(Math.round(10 * strength));
    return true;
  }

  // ---- pipeline event handlers ----
  onPhase({ phase, progress = 0.85, angle }) {
    if (this.paused) return;
    if (this.mode === "glider") {
      if (typeof progress === "number") {
        this.targetProgress = Math.max(0, Math.min(1.05, progress));
      }
      return;
    }
    if (typeof angle === "number" && Number.isFinite(angle)) {
      this.currentAngle = angle;
      this.runnerState = RunnerGame.stateFromAngle(angle, progress, this.concentric);
    }
    if (phase === "active" && !this.didLiftJump && this.runnerState === "jumping") {
      this.peakInActive = Math.max(this.peakInActive, progress);
      this.didLiftJump = this.triggerJump(progress);
    }
  }

  onRep({ rom }) {
    if (this.paused) return;
    this.lastJumpRom = rom;
    if (this.mode === "glider") {
      const bonus = Math.round(12 * Math.min(1.2, Math.max(0.4, rom)));
      this.addScore(bonus);
      this.popups.push({
        x: this.player.x + 12,
        y: Math.max(62, this.player.y - 44),
        text: `+${bonus} REP`,
        life: 0.75,
      });
      return;
    }
    // Reps complete at arm extension (Ducking zone), so award a rep bonus instead of jumping
    this.addScore(10);
    this.popups.push({
      x: this.player.x + 12,
      y: Math.max(62, this.player.y - 44),
      text: "+10 REP",
      life: 0.75,
    });
    this.didLiftJump = false;
    this.peakInActive = 0;
  }

  onHold({ holdMs }) {
    if (this.paused) return;
    this.shield = Math.min(1, holdMs / this.holdTargetMs);
    if (this.shield >= 1) this.shieldActive = true;
  }

  onProgress({ progress, phase, angle }) {
    if (this.paused) return;
    const p = Math.max(0, Math.min(1.2, progress));
    this.lastProgress = p;
    this.currentProgress = p;
    this.currentAngle =
      typeof angle === "number" && Number.isFinite(angle)
        ? angle
        : Math.round(148 - p * 90);

    if (this.mode === "glider") {
      this.targetProgress = Math.max(0, Math.min(1.05, progress));
      return;
    }

    const nextState = RunnerGame.stateFromAngle(angle, p, this.concentric);
    this.runnerState = nextState;

    if (nextState === "jumping") {
      this.duckTimer = 0;
      this.player.ducking = false;
      if (!this.didLiftJump) {
        this.peakInActive = Math.max(this.peakInActive, p);
        this.didLiftJump = this.triggerJump(Math.max(0.75, p));
      } else if (p > this.peakInActive) {
        const extra = p - this.peakInActive;
        this.peakInActive = p;
        this.lastJumpRom = p;
        if (!this.player.onGround && this.player.vy < 0) {
          this.player.vy = Math.max(-670, this.player.vy - 190 * extra);
        }
      }
    } else if (nextState === "running") {
      this.duckTimer = 0;
      this.player.ducking = false;
      this.didLiftJump = false;
      this.peakInActive = 0;
    } else {
      this.didLiftJump = false;
      this.peakInActive = 0;
      this.duckTimer = 0.35;
      if (!this.player.onGround && this.player.vy < 220) {
        this.player.vy = 220;
      }
      if (this.player.onGround) {
        this.player.ducking = true;
      }
    }
  }

  // ---- loop ----
  loop(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (!this.paused) this.update(dt);
    this.draw();
    if (this.paused) this.drawPausedOverlay();
    requestAnimationFrame((tt) => this.loop(tt));
  }

  drawPausedOverlay() {
    const { ctx, W, H } = this;
    ctx.fillStyle = "rgba(15, 18, 24, 0.68)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";

    if (this.pauseReason === "waiting") {
      ctx.fillStyle = "#e8ecf3";
      ctx.font = "bold 26px system-ui";
      ctx.fillText("READY TO START", W / 2, H / 2 - 10);
      ctx.font = "14px system-ui";
      ctx.fillStyle = "#4fd1a0";
      ctx.fillText("Click 'Start exercise' to begin", W / 2, H / 2 + 20);
    } else if (this.pauseReason === "resting") {
      ctx.fillStyle = "#4fd1a0";
      ctx.font = "bold 28px system-ui";
      ctx.fillText("REST PERIOD", W / 2, H / 2 - 10);
      ctx.font = "15px system-ui";
      ctx.fillStyle = "#e8ecf3";
      ctx.fillText(this.restText || "Rest between sets · relax your arm", W / 2, H / 2 + 20);
    } else if (this.pauseReason === "done") {
      ctx.fillStyle = "#7fb3ff";
      ctx.font = "bold 30px system-ui";
      ctx.fillText("SETS COMPLETED!", W / 2, H / 2 - 12);
      ctx.font = "15px system-ui";
      ctx.fillStyle = "#e8ecf3";
      ctx.fillText(`All sets done ✓  Final Score: ${this.score}`, W / 2, H / 2 + 18);
    } else {
      ctx.fillStyle = "#e8ecf3";
      ctx.font = "bold 30px system-ui";
      ctx.fillText("PAUSED", W / 2, H / 2);
      ctx.font = "13px system-ui";
      ctx.fillStyle = "#8f9bb0";
      ctx.fillText("Press Space or click Resume", W / 2, H / 2 + 26);
    }
    ctx.textAlign = "left";
  }

  #valleyCenterY() {
    return Math.max(150, this.groundY - 34);
  }

  #caveCenterAtWorldX(worldX) {
    const baseY = this.#valleyCenterY();
    for (const h of this.humps) {
      if (worldX < h.worldStartX || worldX > h.worldEndX) continue;
      const localX = worldX - h.worldStartX;
      let t = 1;
      if (localX < h.riseLen) {
        t = 0.5 - 0.5 * Math.cos((Math.PI * localX) / h.riseLen);
      } else if (localX > h.riseLen + h.holdLen) {
        const downX = localX - (h.riseLen + h.holdLen);
        t = 0.5 + 0.5 * Math.cos((Math.PI * downX) / h.fallLen);
      }
      return baseY + (h.peakCenterY - baseY) * t;
    }
    return baseY;
  }

  caveBoundsAtScreenX(screenX) {
    const halfH = CAVE_HALF_H;
    const cy = this.#caveCenterAtWorldX(this.scrollX + screenX);
    const topY = Math.max(36, cy - halfH);
    const botY = Math.min(this.groundY, cy + halfH);
    return { centerY: cy, topY, botY };
  }

  #spawnCaveHump() {
    // Every hump uses the prescribed tempo so the slope (gradient) is consistent rep to rep.
    const t = TEMPOS[this.tempo] ?? TEMPOS[DEFAULT_TEMPO];
    const sec = (s) => Math.round(this.speed * s);
    const prof = {
      label: `${t.name.toUpperCase()} ${t.up + t.hold + t.down}s`,
      seconds: t.up + t.hold + t.down,
      riseLen: sec(t.up),
      holdLen: sec(t.hold),
      fallLen: sec(t.down),
      peakCenterY: 100,
    };
    this.spawnIndex += 1;

    const valleyGap = sec(t.rest);
    const prevEnd = this.humps.length ? this.humps[this.humps.length - 1].worldEndX : 0;
    const minStart = this.scrollX + Math.max(Math.round(this.W * 0.78), this.player.x + 250);
    const worldStartX = this.humps.length ? Math.max(minStart, prevEnd + valleyGap) : minStart;
    const totalLen = prof.riseLen + prof.holdLen + prof.fallLen;
    const hump = {
      ...prof,
      worldStartX,
      worldEndX: worldStartX + totalLen,
      cleared: false,
    };
    this.humps.push(hump);

    // 7 coins trace the smooth ramp-up, crest, and controlled eccentric descent
    const coinFracs = [0.12, 0.28, 0.42, 0.5, 0.58, 0.72, 0.88];
    for (const f of coinFracs) {
      const wx = worldStartX + totalLen * f;
      const cy = this.#caveCenterAtWorldX(wx);
      this.coinItems.push({ x: wx - this.scrollX, y: Math.round(cy), r: 9, taken: false });
    }
  }

  #spawnWave() {
    if (this.mode === "glider") return this.#spawnCaveHump();
    const spawnX = this.W + 28;
    const isHigh = this.spawnIndex % 2 === 1;
    this.spawnIndex += 1;

    if (isHigh) {
      // Overhead DurHack pterodactyl: hits standing Dino (top=groundY-48), misses ducking Dino (top=groundY-26)
      this.obstacles.push({
        type: "high",
        x: spawnX,
        y: this.groundY - 52,
        w: 34,
        h: 22,
        hit: false,
      });
      // Low coins underneath reward ducking
      this.coinItems.push(
        { x: spawnX + 4, y: this.groundY - 16, r: 9, taken: false },
        { x: spawnX + 40, y: this.groundY - 16, r: 9, taken: false }
      );
    } else {
      // Ground crystal cactus to jump over
      const oh = Math.round(26 + Math.random() * 12);
      this.obstacles.push({
        type: "low",
        x: spawnX,
        y: this.groundY - oh,
        w: 20,
        h: oh,
        hit: false,
      });
      // High-arc jump coins + low eccentric coins after landing
      this.coinItems.push(
        { x: spawnX + 4, y: this.groundY - 92, r: 9, taken: false },
        { x: spawnX + 34, y: this.groundY - 108, r: 9, taken: false },
        { x: spawnX + 115, y: this.groundY - 16, r: 9, taken: false },
        { x: spawnX + 150, y: this.groundY - 16, r: 9, taken: false }
      );
    }
  }

  update(dt) {
    const p = this.player;
    this.animClock += dt;
    p.animTime += dt * 10;

    if (this.mode === "glider") {
      const targetY = this.#gliderTargetY();
      const prevY = p.y;
      const alpha = 1 - Math.exp(-12 * dt);
      p.y += (targetY - p.y) * alpha;
      p.vy = dt > 0 ? (p.y - prevY) / dt : 0;
      p.onGround = false;
      p.ducking = false;
    } else {
      p.vy += 1650 * dt;
      p.y += p.vy * dt;
      if (p.y >= this.groundY) {
        p.y = this.groundY;
        p.vy = 0;
        p.onGround = true;
        if (this.queuedJumpRom > 0) {
          const q = this.queuedJumpRom;
          this.queuedJumpRom = 0;
          this.triggerJump(q);
        }
      }

      this.duckTimer = Math.max(0, this.duckTimer - dt);
      p.ducking = p.onGround && (this.runnerState === "ducking" || this.duckTimer > 0);
    }

    const dx = this.speed * dt;
    this.scrollX += dx;
    this.groundOffset = (this.groundOffset + dx) % 48;
    this.caveHitCooldown = Math.max(0, this.caveHitCooldown - dt);

    if (!this.resting) {
      if (this.mode === "glider") {
        let lastEnd = this.humps.length ? this.humps[this.humps.length - 1].worldEndX : 0;
        while (this.humps.length === 0 || lastEnd < this.scrollX + this.W + 240) {
          this.#spawnCaveHump();
          lastEnd = this.humps[this.humps.length - 1].worldEndX;
        }
      } else {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          this.#spawnWave();
          this.spawnTimer = 2.6 + Math.random() * 1.2;
        }
      }
    }

    const ph = this.mode === "runner" && p.ducking ? 26 : p.h;
    const phw = (this.mode === "runner" && p.ducking ? 40 : p.w) / 2;
    const pLeft = p.x - phw;
    const pRight = p.x + phw;
    const pTop = p.y - ph;
    const pBottom = p.y;

    for (const o of this.obstacles) o.x -= dx;
    this.obstacles = this.obstacles.filter((o) => {
      if (o.x + o.w < 0) {
        if (!o.hit) this.addScore(5);
        return false;
      }
      return true;
    });

    for (const c of this.coinItems) {
      c.x -= dx;
      if (
        !c.taken &&
        c.x + c.r > pLeft - 6 &&
        c.x - c.r < pRight + 6 &&
        c.y + c.r > pTop - 6 &&
        c.y - c.r < pBottom + 6
      ) {
        c.taken = true;
        this.coins += 1;
        this.addScore(15);
        this.popups.push({ x: c.x, y: c.y - 8, text: "+15", life: 0.65 });
      }
    }
    this.coinItems = this.coinItems.filter((c) => !c.taken && c.x + c.r > -12);

    for (const pop of this.popups) {
      pop.y -= 28 * dt;
      pop.life -= dt;
    }
    this.popups = this.popups.filter((pop) => pop.life > 0);

    if (this.mode === "glider") {
      for (const h of this.humps) {
        if (!h.cleared && h.worldEndX - this.scrollX < pLeft) {
          h.cleared = true;
          this.addScore(15);
          this.popups.push({ x: p.x + 22, y: Math.max(66, p.y - 54), text: "+15", life: 0.75 });
        }
      }
      this.humps = this.humps.filter((h) => h.worldEndX - this.scrollX > -60);

      let caveHit = false;
      for (const sx of [pLeft + 4, p.x, pRight - 4]) {
        const b = this.caveBoundsAtScreenX(sx);
        if (pTop + 4 < b.topY - 6 || pBottom - 4 > b.botY + 6) {
          caveHit = true;
          break;
        }
      }
      if (caveHit && this.caveHitCooldown <= 0) {
        this.caveHitCooldown = 0.9;
        if (this.shieldActive) {
          this.shieldActive = false;
          this.shield = 0;
        } else {
          this.hits += 1;
          this.flash = 0.3;
        }
      }
    } else {
      for (const o of this.obstacles) {
        const oTop = o.y;
        const oBottom = o.y + o.h;
        const hit =
          o.x + 4 < pRight - 5 &&
          o.x + o.w - 4 > pLeft + 5 &&
          oBottom - 4 > pTop + 4 &&
          oTop + 4 < pBottom - 2;
        if (hit && !o.hit) {
          o.hit = true;
          if (this.shieldActive) {
            this.shieldActive = false;
            this.shield = 0;
          } else {
            this.hits += 1;
            this.flash = 0.3;
          }
        }
      }
    }
    this.flash = Math.max(0, this.flash - dt);
  }

  #drawDino(ctx, p) {
    const legSwap = Math.sin(p.animTime * 1.4) > 0;
    const body = "#4fd1a0";
    const crest = "#a855f7"; // DurHack purple spikes
    const belly = "#7de6be";

    if (this.mode === "runner" && p.ducking) {
      const base = p.y;
      const left = p.x - 22;
      // Tail
      ctx.fillStyle = body;
      ctx.fillRect(left - 8, base - 16, 10, 6);
      // Horizontal crouched torso + head
      ctx.fillRect(left, base - 22, 26, 14);
      ctx.fillRect(left + 22, base - 25, 22, 16);
      ctx.fillStyle = belly;
      ctx.fillRect(left + 6, base - 12, 16, 4);
      // Purple DurHack dorsal spikes along low back
      ctx.fillStyle = crest;
      ctx.fillRect(left + 3, base - 25, 5, 3);
      ctx.fillRect(left + 11, base - 25, 5, 3);
      ctx.fillRect(left + 19, base - 26, 4, 3);
      // Eye
      ctx.fillStyle = "#0f1218";
      ctx.fillRect(left + 35, base - 21, 4, 4);
      // Fast running legs
      ctx.fillStyle = body;
      ctx.fillRect(left + 6, base - 8, 5, legSwap ? 8 : 5);
      ctx.fillRect(left + 16, base - 8, 5, legSwap ? 5 : 8);
      return;
    }

    const isGlider = this.mode === "glider";
    if (isGlider) {
      const tilt = Math.max(-0.28, Math.min(0.28, p.vy * 0.00075));
      ctx.save?.();
      ctx.translate?.(p.x, p.y - 24);
      ctx.rotate?.(tilt);
      ctx.translate?.(-p.x, -(p.y - 24));
    }

    const base = p.y;
    const left = p.x - 16;

    if (isGlider) {
      // DurHack purple hang-glider wing + harness struts above Dino Dan
      ctx.fillStyle = "#6b4c8c";
      ctx.fillRect(left + 8, base - 52, 2, 12);
      ctx.fillRect(left + 18, base - 52, 2, 10);
      ctx.fillStyle = "#a855f7";
      ctx.fillRect(left - 12, base - 58, 46, 7);
      ctx.fillRect(left - 4, base - 63, 32, 6);
      ctx.fillStyle = "#d8b4fe";
      ctx.fillRect(left - 12, base - 58, 46, 2);
      ctx.fillRect(left - 4, base - 63, 32, 2);
    }

    // Tail
    ctx.fillStyle = body;
    ctx.fillRect(left - 8, base - 26, 10, 8);
    ctx.fillRect(left - 12, base - 30, 5, 6);
    // Upright torso
    ctx.fillRect(left, base - 32, 20, 22);
    ctx.fillStyle = belly;
    ctx.fillRect(left + 12, base - 28, 7, 15);
    // Tiny T-Rex arm
    ctx.fillStyle = body;
    ctx.fillRect(left + 19, base - 24, 7, 4);
    ctx.fillRect(left + 24, base - 24, 3, 7);
    // Big T-Rex head & snout
    ctx.fillRect(left + 6, base - 48, 22, 18);
    ctx.fillRect(left + 20, base - 44, 11, 10);
    // Jaw cutout line
    ctx.fillStyle = "#151c29";
    ctx.fillRect(left + 21, base - 36, 10, 2);
    // Purple DurHack dorsal spikes
    ctx.fillStyle = crest;
    ctx.fillRect(left + 2, base - 44, 4, 5);
    ctx.fillRect(left - 3, base - 36, 4, 5);
    ctx.fillRect(left - 4, base - 28, 4, 5);
    // Eye
    ctx.fillStyle = "#0f1218";
    ctx.fillRect(left + 20, base - 44, 4, 4);
    // Legs (animated when running on ground)
    ctx.fillStyle = body;
    if (!p.onGround) {
      ctx.fillRect(left + 3, base - 10, 6, 8);
      ctx.fillRect(left + 12, base - 12, 6, 8);
    } else {
      ctx.fillRect(left + 3, base - 10, 6, legSwap ? 10 : 6);
      ctx.fillRect(left + 12, base - 10, 6, legSwap ? 6 : 10);
    }

    if (isGlider) ctx.restore?.();
  }

  #drawAltitudeGauge(ctx, p) {
    const trackX = 14;
    const trackW = 8;
    const topCenterY = 74;
    const botCenterY = this.groundY - 32;
    const trackH = Math.max(40, botCenterY - topCenterY);
    const curCenterY = Math.max(topCenterY, Math.min(botCenterY, p.y - 24));
    const fillH = botCenterY - curCenterY;
    const targetTickY = botCenterY - trackH * 0.65;

    ctx.fillStyle = "rgba(15, 18, 24, 0.55)";
    ctx.fillRect(6, topCenterY - 20, 28, trackH + 40);

    // Track rail
    ctx.fillStyle = "#263044";
    ctx.fillRect(trackX, topCenterY, trackW, trackH);

    // Filled altitude bar
    ctx.fillStyle = curCenterY <= targetTickY ? "#a855f7" : "#4fd1a0";
    ctx.fillRect(trackX, curCenterY, trackW, fillH);

    // 65% target marker
    ctx.fillStyle = "rgba(216, 180, 254, 0.7)";
    ctx.fillRect(trackX - 3, targetTickY - 1, trackW + 6, 2);

    // Knob indicator
    ctx.fillStyle = "#e8ecf3";
    ctx.beginPath();
    ctx.arc(trackX + trackW / 2, curCenterY, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#9aa8bf";
    ctx.font = "600 9px system-ui";
    ctx.fillText("100%", 7, topCenterY - 8);
    ctx.fillText("0%", 11, botCenterY + 13);
  }

  #drawRunnerZoneGauge(ctx) {
    const { W, groundY, runnerState, currentAngle } = this;
    const trackX = 12;
    const trackW = 10;
    const topY = 64;
    const botY = groundY - 22;
    const trackH = Math.max(60, botY - topY);

    // 58° at top (max jump) down to 148° at bottom (rest/duck)
    const y90 = topY + ((90 - 58) / 90) * trackH;
    const y121 = topY + ((121 - 58) / 90) * trackH;
    const bands = [
      { ...RUNNER_STATES.jumping, y0: topY, y1: y90 },
      { ...RUNNER_STATES.running, y0: y90, y1: y121 },
      { ...RUNNER_STATES.ducking, y0: y121, y1: botY },
    ];

    ctx.fillStyle = "rgba(15, 18, 24, 0.58)";
    ctx.fillRect(6, topY - 10, 48, trackH + 20);

    for (const b of bands) {
      const active = runnerState === b.state;
      ctx.fillStyle = `rgba(${b.rgb}, ${active ? 0.88 : 0.26})`;
      ctx.fillRect(trackX, b.y0, trackW, Math.max(2, b.y1 - b.y0));
      ctx.fillStyle = active ? b.color : "rgba(184, 196, 216, 0.55)";
      ctx.font = active ? "bold 9px system-ui" : "600 8px system-ui";
      ctx.fillText(b.short, trackX + trackW + 4, (b.y0 + b.y1) / 2 + 3);
    }

    // Threshold dividers at 90° and 121°
    ctx.fillStyle = "rgba(232, 236, 243, 0.45)";
    ctx.fillRect(trackX - 2, y90 - 0.5, trackW + 4, 1);
    ctx.fillRect(trackX - 2, y121 - 0.5, trackW + 4, 1);

    // Live angle marker dot on the zone gauge
    const norm = Math.max(0, Math.min(1, (currentAngle - 58) / 90));
    const curY = topY + norm * trackH;
    const activeInfo = RUNNER_STATES[runnerState] || RUNNER_STATES.running;
    ctx.fillStyle = activeInfo.color;
    ctx.beginPath();
    ctx.arc(trackX + trackW / 2, curY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(trackX + trackW / 2, curY, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // State pill at top-right under the HUD bar
    const pillW = 112;
    const pillX = W - pillW - 12;
    const pillY = 54;
    ctx.fillStyle = `rgba(${activeInfo.rgb}, 0.2)`;
    ctx.fillRect(pillX, pillY, pillW, 22);
    ctx.fillStyle = activeInfo.color;
    ctx.fillRect(pillX, pillY, 3, 22);
    ctx.font = "bold 11px system-ui";
    ctx.fillText(`${activeInfo.label} ${Math.round(currentAngle)}°`, pillX + 8, pillY + 15);
  }

  #drawCave(ctx) {
    const { W, groundY } = this;
    const pts = [];
    for (let x = 0; x <= W; x += 8) {
      pts.push({ x, ...this.caveBoundsAtScreenX(x) });
    }
    if (pts[pts.length - 1].x < W) {
      pts.push({ x: W, ...this.caveBoundsAtScreenX(W) });
    }

    // Upper cave rock ceiling
    ctx.fillStyle = "#191f34";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (const pt of pts) ctx.lineTo(pt.x, pt.topY);
    ctx.lineTo(W, 0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = this.caveHitCooldown > 0 ? "#e85d75" : "#a855f7";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].topY);
      else ctx.lineTo(pts[i].x, pts[i].topY);
    }
    ctx.stroke();

    // Lower cave hump rock rising from groundY
    ctx.fillStyle = "#22293e";
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    for (const pt of pts) ctx.lineTo(pt.x, pt.botY);
    ctx.lineTo(W, groundY);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = this.caveHitCooldown > 0 ? "#e85d75" : "#4fd1a0";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].botY);
      else ctx.lineTo(pts[i].x, pts[i].botY);
    }
    ctx.stroke();

    // Smooth dashed target path down the center of the cave corridor
    ctx.save?.();
    ctx.strokeStyle = "rgba(127, 179, 255, 0.34)";
    ctx.lineWidth = 2;
    ctx.setLineDash?.([6, 6]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].centerY);
      else ctx.lineTo(pts[i].x, pts[i].centerY);
    }
    ctx.stroke();
    ctx.setLineDash?.([]);
    ctx.restore?.();

    // Tempo labels inside each cave mound so hump length communicates rep speed
    ctx.textAlign = "center";
    for (const h of this.humps) {
      const crestX = h.worldStartX + h.riseLen + h.holdLen / 2 - this.scrollX;
      if (crestX < -60 || crestX > W + 60) continue;
      const moundTop = Math.min(groundY, h.peakCenterY + CAVE_HALF_H);
      const labelY = Math.min(groundY - 12, moundTop + 20);
      ctx.fillStyle = "#d8b4fe";
      ctx.font = "bold 11px system-ui";
      ctx.fillText(h.label, crestX, labelY);
      if (labelY + 14 <= groundY - 6) {
        ctx.fillStyle = "rgba(184, 196, 216, 0.75)";
        ctx.font = "600 10px system-ui";
        ctx.fillText("↑ slow  ·  ↓ control", crestX, labelY + 14);
      }
    }
    ctx.textAlign = "left";
  }

  #drawObstaclesAndCoins(ctx) {
    if (this.mode === "glider") {
      this.#drawCave(ctx);
    } else {
      for (const o of this.obstacles) {
        if (o.type === "high") {
          // Flapping DurHack pterodactyl
          const wingUp = Math.sin(this.animClock * 11 + o.x * 0.05) > 0;
          ctx.fillStyle = o.hit ? "#5a3a5a" : "#a855f7";
          ctx.fillRect(o.x + 6, o.y + 8, 20, 8);
          if (wingUp) {
            ctx.fillRect(o.x + 10, o.y, 12, 9);
          } else {
            ctx.fillRect(o.x + 10, o.y + 15, 12, 7);
          }
          ctx.fillStyle = o.hit ? "#6e4b4b" : "#f06a6a";
          ctx.fillRect(o.x, o.y + 7, 10, 6);
          ctx.fillStyle = "#fff";
          ctx.fillRect(o.x + 4, o.y + 8, 2, 2);
          if (!o.hit) {
            ctx.fillStyle = "rgba(168, 85, 247, 0.9)";
            ctx.font = "bold 10px system-ui";
            ctx.fillText("DUCK ↓", o.x - 2, o.y - 6);
          }
        } else {
          // Ground crystal cactus
          ctx.fillStyle = o.hit ? "#5a3a3a" : "#f06a6a";
          ctx.fillRect(o.x + 5, o.y, o.w - 10, o.h);
          ctx.fillRect(o.x, o.y + 8, 5, Math.max(6, o.h * 0.4));
          ctx.fillRect(o.x + o.w - 5, o.y + 10, 5, Math.max(6, o.h * 0.35));
          if (!o.hit) {
            ctx.fillStyle = "#ffb4b4";
            ctx.fillRect(o.x + 6, o.y, o.w - 12, 4);
          }
        }
      }
    }

    for (const c of this.coinItems) {
      const rx = Math.max(3, Math.abs(Math.cos(this.animClock * 5 + c.x * 0.04)) * c.r);
      ctx.fillStyle = "#f2b84b";
      ctx.beginPath();
      ctx.ellipse?.(c.x, c.y, rx, c.r, 0, 0, Math.PI * 2);
      if (!ctx.ellipse) ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
      if (rx > 4) {
        ctx.fillStyle = "#fde68a";
        ctx.fillRect(c.x - 1, c.y - 4, 2, 8);
      }
    }

    for (const pop of this.popups) {
      ctx.fillStyle = `rgba(242, 184, 75, ${Math.min(1, pop.life * 2)})`;
      ctx.font = "bold 13px system-ui";
      ctx.fillText(pop.text, pop.x - 10, pop.y);
    }
  }

  draw() {
    const { ctx, W, H, groundY, player: p } = this;

    // Sky gradient
    if (this.flash > 0) {
      ctx.fillStyle = "#4a2430";
      ctx.fillRect(0, 0, W, H);
    } else {
      const sky = ctx.createLinearGradient(0, 0, 0, groundY);
      sky.addColorStop(0, "#141928");
      sky.addColorStop(1, "#1e273e");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, groundY);
    }

    // Ground & scrolling track markers
    ctx.fillStyle = "#242b3d";
    ctx.fillRect(0, groundY, W, H - groundY);
    ctx.fillStyle = "#4c3b6b";
    ctx.fillRect(0, groundY, W, 2);
    ctx.fillStyle = "#333d57";
    for (let x = -this.groundOffset; x < W; x += 48) {
      ctx.fillRect(x, groundY + 11, 24, 3);
    }

    this.#drawObstaclesAndCoins(ctx);

    // Shadow shrinks cleanly as Dino Dan rises higher
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    const shadowScale = Math.max(0.4, 1 - (this.groundY - p.y) / 200);
    const sw = (this.mode === "runner" && p.ducking ? 40 : 30) * shadowScale;
    ctx.fillRect(p.x - sw / 2, groundY + 4, sw, 3);

    this.#drawDino(ctx, p);

    if (this.mode === "glider") {
      this.#drawAltitudeGauge(ctx, p);
    } else {
      this.#drawRunnerZoneGauge(ctx);
    }

    if (this.shieldActive) {
      const sh = p.ducking ? 26 : p.h;
      ctx.strokeStyle = "#7fb3ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y - sh / 2, 34, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Clean single-row top HUD bar: Score · PB · Coins · Hits | Shield
    ctx.fillStyle = "rgba(15, 18, 24, 0.76)";
    ctx.fillRect(10, 10, W - 20, 38);

    ctx.fillStyle = "#e8ecf3";
    ctx.font = "bold 15px system-ui";
    ctx.fillText(`Score ${this.score}`, 18, 34);

    ctx.fillStyle = this.newPb ? "#f2b84b" : "#9aa8bf";
    ctx.font = "600 13px system-ui";
    ctx.fillText(`PB ${this.pb}`, 102, 34);

    // Coin icon + counter
    ctx.fillStyle = "#f2b84b";
    ctx.beginPath();
    ctx.arc(166, 29, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`${this.coins}`, 176, 34);

    if (W >= 420) {
      ctx.fillStyle = "#9aa8bf";
      ctx.fillText(`Hits ${this.hits}`, 214, 34);
    }

    const barW = Math.min(115, Math.max(60, Math.round(W * 0.22)));
    const shieldX = W - barW - 18;
    ctx.fillStyle = "#b8c4d8";
    ctx.font = "600 11px system-ui";
    ctx.fillText(this.shieldActive ? "Shield READY" : "Shield (hold)", shieldX, 24);
    ctx.fillStyle = "#2a3140";
    ctx.fillRect(shieldX, 30, barW, 9);
    ctx.fillStyle = this.shieldActive ? "#7fb3ff" : "#4fd1a0";
    ctx.fillRect(shieldX, 30, barW * this.shield, 9);
  }
}
