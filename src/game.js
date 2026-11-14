// Stage 4: a tiny game that consumes pipeline events.
//   rep      -> runner jumps; jump height scales with ROM
//   hold     -> charges a shield meter
//   progress -> character crouches as you move toward the target (live feedback)

export class RunnerGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = canvas.width;
    this.H = canvas.height;
    this.groundY = this.H - 50;
    this.reset();
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  reset() {
    this.player = { x: 90, y: this.groundY, vy: 0, w: 28, h: 48, onGround: true, crouch: 0 };
    this.obstacles = [];
    this.spawnTimer = 0;
    this.speed = 220;
    this.score = 0;
    this.hits = 0;
    this.shield = 0; // 0..1
    this.shieldActive = false;
    this.flash = 0;
    this.lastJumpRom = 0;
    this.paused = false;
<<<<<<< Updated upstream
    this.resting = false;
    this.holdTargetMs = 2000;
    this.concentric = this.concentric ?? "toTarget"; // "toTarget" (curl/raise) | "toRest" (squat)
    this.jumpedInActive = false;
    this.peakInActive = 0;
  }

  setConcentric(dir) {
    this.concentric = dir === "toRest" ? "toRest" : "toTarget";
  }

  setResting(resting) {
    this.resting = !!resting;
    if (this.resting) this.obstacles = [];
  }

  setHoldTargetMs(ms) {
    const n = Number(ms);
    this.holdTargetMs = Number.isFinite(n) && n > 0 ? Math.max(1000, n) : 2000;
=======
    this.pauseReason = null;
    this.restText = "";
>>>>>>> Stashed changes
  }

  pause(reason = "paused") {
    this.paused = true;
    this.pauseReason = reason;
    if (reason === "resting" || reason === "done") {
      this.player.y = this.groundY;
      this.player.vy = 0;
      this.player.onGround = true;
      this.player.crouch = 0;
      this.flash = 0;
    }
  }
  resume() {
    this.paused = false;
    this.pauseReason = null;
    this.last = performance.now(); // no catch-up jump after a long pause
  }

  triggerJump(rom) {
    if (this.paused || !this.player.onGround) return false;
    const strength = 0.55 + Math.min(1.2, Math.max(0, rom)) * 0.45; // 0.55..1.09
    this.player.vy = -620 * strength;
    this.player.onGround = false;
    this.player.crouch = 0;
    this.lastJumpRom = rom;
    this.score += Math.round(10 * strength);
    return true;
  }

  // ---- pipeline event handlers ----
  onPhase({ phase, progress = 0.85 }) {
    if (this.paused) return;
    if (phase === "active") {
      this.peakInActive = progress;
      // For lifting/curling exercises (concentric === "toTarget"), jump immediately on the UPWARD movement!
      if (this.concentric === "toTarget") {
        this.jumpedInActive = this.triggerJump(progress);
      } else {
        this.jumpedInActive = false;
      }
    }
  }

  onRep({ rom }) {
    if (this.paused) return;
    this.lastJumpRom = rom;
    // Jump on rep completion if we haven't already jumped on the upward lift
    // (e.g. for squats where standing back up completes the rep, or console-dispatched test reps).
    if (!this.jumpedInActive) {
      this.triggerJump(rom);
    }
    this.jumpedInActive = false;
    this.peakInActive = 0;
  }

  onHold({ holdMs }) {
    if (this.paused) return;
    this.shield = Math.min(1, holdMs / this.holdTargetMs);
    if (this.shield >= 1) this.shieldActive = true;
  }

  onProgress({ progress, phase }) {
    if (this.paused) return;
    const p = Math.max(0, Math.min(1.2, progress));

    if (this.concentric === "toTarget") {
      // If the player just jumped on the upward movement and keeps pulling/lifting higher (e.g. 0.8 -> 1.05)
      // while still rising, boost the upward jump velocity to reward the fuller ROM!
      if (phase === "active" && p > this.peakInActive) {
        const extra = p - this.peakInActive;
        this.peakInActive = p;
        this.lastJumpRom = p;
        if (!this.player.onGround && this.player.vy < 0) {
          this.player.vy -= 280 * extra;
        }
      }
      // Slight coil as you begin lifting (0.1..0.75), uncoiled at rest and in the air
      this.player.crouch = this.player.onGround && phase === "rest" && p > 0.1 ? Math.min(0.6, p * 0.7) : 0;
    } else {
      // Squat (concentric === "toRest"): squat down to crouch; stand up from active to jump!
      if (phase === "active" && !this.jumpedInActive && p <= 0.55) {
        this.jumpedInActive = this.triggerJump(Math.max(0.85, this.peakInActive));
      } else if (phase === "active") {
        this.peakInActive = Math.max(this.peakInActive, p);
      }
      this.player.crouch = this.player.onGround ? Math.max(0, Math.min(1, p)) : 0;
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

    if (this.pauseReason === "resting") {
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
      ctx.font = "bold 32px system-ui";
      ctx.fillText("PAUSED", W / 2, H / 2);
      ctx.font = "14px system-ui";
      ctx.fillStyle = "#8f9bb0";
      ctx.fillText("Press Space or click Resume", W / 2, H / 2 + 28);
    }
    ctx.textAlign = "left";
  }

  update(dt) {
    const p = this.player;
    p.vy += 1500 * dt;
    p.y += p.vy * dt;
    if (p.y >= this.groundY) {
      p.y = this.groundY;
      p.vy = 0;
      p.onGround = true;
    }

    if (!this.resting) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.obstacles.push({ x: this.W + 20, w: 22, h: 28 + Math.random() * 20 });
        this.spawnTimer = 2.2 + Math.random() * 1.6;
      }
    }
    for (const o of this.obstacles) o.x -= this.speed * dt;
    this.obstacles = this.obstacles.filter((o) => {
      if (o.x + o.w < 0) {
        this.score += 5;
        return false;
      }
      return true;
    });

    for (const o of this.obstacles) {
      const hit = o.x < p.x + p.w / 2 && o.x + o.w > p.x - p.w / 2 && p.y > this.groundY - o.h;
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
    this.flash = Math.max(0, this.flash - dt);
  }

  draw() {
    const { ctx, W, H, groundY, player: p } = this;
    ctx.fillStyle = this.flash > 0 ? "#4a2430" : "#1b2230";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#2a3140";
    ctx.fillRect(0, groundY, W, H - groundY);

    for (const o of this.obstacles) {
      ctx.fillStyle = o.hit ? "#5a3a3a" : "#f06a6a";
      ctx.fillRect(o.x, groundY - o.h, o.w, o.h);
    }

    // player: crouches with live progress, so the user sees the pose mapping before the rep completes
    const h = p.h * (1 - 0.35 * p.crouch);
    ctx.fillStyle = "#4fd1a0";
    ctx.fillRect(p.x - p.w / 2, p.y - h, p.w, h);
    ctx.fillStyle = "#0f1218";
    ctx.fillRect(p.x + 4, p.y - h + 10, 6, 6);

    if (this.shieldActive) {
      ctx.strokeStyle = "#7fb3ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y - h / 2, 40, 0, Math.PI * 2);
      ctx.stroke();
    }

    // HUD
    ctx.fillStyle = "#e8ecf3";
    ctx.font = "bold 18px system-ui";
    ctx.fillText(`Score ${this.score}`, 14, 28);
    ctx.fillStyle = "#8f9bb0";
    ctx.font = "13px system-ui";
    ctx.fillText(`Hits ${this.hits}`, 14, 48);
    if (this.lastJumpRom) ctx.fillText(`Last jump ROM ${(this.lastJumpRom * 100).toFixed(0)}%`, 14, 66);

    // shield meter
    ctx.fillStyle = "#8f9bb0";
    ctx.fillText("Shield (hold target)", W - 170, 28);
    ctx.fillStyle = "#2a3140";
    ctx.fillRect(W - 170, 34, 150, 10);
    ctx.fillStyle = this.shieldActive ? "#7fb3ff" : "#4fd1a0";
    ctx.fillRect(W - 170, 34, 150 * this.shield, 10);
  }
}
