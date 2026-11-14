// Stage 4: DurHack Dino ("Dino Dan") game driven by exercise motion.
// Supports two modes:
//   - "glider" (default): 1:1 joint-angle-to-altitude hang-gliding through wide pipe gates + coin trails
//   - "runner": upward lift -> Dino Dan jumps, downward return -> duck, hold -> charges shield

const PB_KEYS = {
  glider: "durhack_glider_pb",
  runner: "durhack_dino_pb",
};

export class RunnerGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = canvas.width || 480;
    this.H = 320;
    this.groundY = this.H - 46;
    this.mode = "glider";
    this.#loadPb();
    this.reset();
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
    this.reset();
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

  reset() {
    this.groundY = (this.H || 320) - 46;
    this.mode = this.mode ?? "glider";
    const isGlider = this.mode === "glider";
    this.player = {
      x: Math.min(86, Math.max(52, Math.round((this.W || 480) * 0.2))),
      y: isGlider ? this.groundY - 8 : this.groundY,
      vy: 0,
      w: 34,
      h: 48,
      onGround: !isGlider,
      ducking: false,
      animTime: 0,
    };
    this.obstacles = [];
    this.coinItems = [];
    this.popups = [];
    this.spawnTimer = isGlider ? 1.0 : 1.2;
    this.spawnIndex = 0;
    this.lastGapCenter = (this.groundY - 8 + 98) / 2;
    this.speed = isGlider ? 160 : 175;
    this.score = 0;
    this.coins = 0;
    this.hits = 0;
    this.newPb = false;
    this.shield = 0; // 0..1
    this.shieldActive = false;
    this.flash = 0;
    this.lastJumpRom = 0;
    this.paused = false;
    this.resting = false;
    this.holdTargetMs = 2000;
    this.concentric = this.concentric ?? "toTarget"; // "toTarget" (curl/raise) | "toRest" (squat)
    this.didLiftJump = false;
    this.queuedJumpRom = 0;
    this.peakInActive = 0;
    this.lastProgress = 0;
    this.currentProgress = 0;
    this.targetProgress = 0;
    this.duckTimer = 0;
    this.groundOffset = 0;
    this.animClock = 0;
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

  setConcentric(dir) {
    this.concentric = dir === "toRest" ? "toRest" : "toTarget";
  }

  setResting(resting) {
    this.resting = !!resting;
    if (this.resting) {
      this.obstacles = [];
      this.coinItems = [];
    }
  }

  setHoldTargetMs(ms) {
    const n = Number(ms);
    this.holdTargetMs = Number.isFinite(n) && n > 0 ? Math.max(1000, n) : 2000;
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.last = performance.now(); // no catch-up jump after a long pause
  }

  #gliderTargetY() {
    const restY = this.groundY - 8;
    const topY = 98;
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
  onPhase({ phase, progress = 0.85 }) {
    if (this.paused) return;
    if (this.mode === "glider") {
      if (typeof progress === "number") {
        this.targetProgress = Math.max(0, Math.min(1.05, progress));
      }
      return;
    }
    if (phase === "active") {
      this.peakInActive = Math.max(this.peakInActive, progress);
      if (this.concentric === "toTarget") {
        if (!this.didLiftJump) {
          this.didLiftJump = this.triggerJump(progress);
        }
      } else {
        this.didLiftJump = false;
      }
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
    // Jump on rep completion only if we haven't already jumped during the upward movement
    if (!this.didLiftJump) {
      this.triggerJump(rom);
    }
    this.didLiftJump = false;
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
    const dp = p - this.lastProgress;
    this.lastProgress = p;
    this.currentProgress = p;

    if (this.mode === "glider") {
      this.targetProgress = Math.max(0, Math.min(1.05, progress));
      return;
    }

    if (this.concentric === "toTarget") {
      // Continuing higher during active phase boosts jump arc to reach high coins
      if (phase === "active" && p > this.peakInActive) {
        const extra = p - this.peakInActive;
        this.peakInActive = p;
        this.lastJumpRom = p;
        if (!this.player.onGround && this.player.vy < 0) {
          this.player.vy = Math.max(-670, this.player.vy - 190 * extra);
        }
      } else if (phase === "rest" && dp > 0.015 && p >= 0.58 && !this.didLiftJump) {
        // Early responsive jump on clear upward lifts before reaching full enterTarget
        this.peakInActive = Math.max(this.peakInActive, p);
        this.didLiftJump = this.triggerJump(p);
      }

      if (p > this.peakInActive) this.peakInActive = p;

      // Downward eccentric movement (lowering limb): duck Dino Dan
      if ((dp < -0.012 && this.peakInActive >= 0.45) || (phase === "active" && p < this.peakInActive - 0.10)) {
        this.duckTimer = 0.85;
      }

      if (phase === "rest" && p <= 0.30) {
        this.peakInActive = 0;
        this.didLiftJump = false;
      }
    } else {
      // Squat (concentric === "toRest"): squat down to duck, stand up to jump
      if (p >= 0.35 && this.player.onGround) {
        this.duckTimer = 0.35;
      }
      if (p > this.peakInActive) this.peakInActive = p;
      if (this.peakInActive >= 0.45 && dp < -0.02 && p <= 0.60 && !this.didLiftJump) {
        this.didLiftJump = this.triggerJump(Math.max(0.85, this.peakInActive));
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
    ctx.fillStyle = "rgba(15, 18, 24, 0.6)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#e8ecf3";
    ctx.font = "bold 30px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("PAUSED", W / 2, H / 2);
    ctx.font = "13px system-ui";
    ctx.fillStyle = "#8f9bb0";
    ctx.fillText("Press Space or click Resume", W / 2, H / 2 + 26);
    ctx.textAlign = "left";
  }

  #spawnGliderWave() {
    const spawnX = this.W + 28;
    const trailId = this.spawnIndex;
    const isHigh = this.spawnIndex % 2 === 0;
    this.spawnIndex += 1;

    const gapH = 130;
    const gapTop = isHigh
      ? Math.round(52 + Math.random() * 8)
      : this.groundY - 6 - gapH;
    const gapBottom = gapTop + gapH;
    const gateCenter = (gapTop + gapBottom) / 2;
    const prevCenter = this.lastGapCenter ?? gateCenter;
    this.lastGapCenter = gateCenter;

    const gateX = spawnX + 125;
    this.obstacles.push({
      type: "gate",
      x: gateX,
      y: 0,
      w: 42,
      h: this.groundY,
      gapTop,
      gapBottom,
      hit: false,
      cleared: false,
    });

    // 5-coin curve guiding the smooth raise/lower path into & through the gate
    const coinXs = [spawnX, spawnX + 55, spawnX + 100, gateX + 21, gateX + 76];
    const interpTs = [0.22, 0.56, 0.88, 1.0, 1.0];
    for (let i = 0; i < coinXs.length; i++) {
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * interpTs[i]);
      const cy = Math.round(prevCenter + (gateCenter - prevCenter) * ease);
      this.coinItems.push({ x: coinXs[i], y: cy, r: 9, taken: false, trailId });
    }
  }

  #spawnWave() {
    if (this.mode === "glider") return this.#spawnGliderWave();
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
      const highAhead = this.obstacles.some(
        (o) => o.type === "high" && !o.hit && o.x >= p.x - 10 && o.x <= p.x + 140
      );
      if (highAhead && this.concentric === "toTarget" && this.currentProgress <= 0.35 && p.onGround) {
        this.duckTimer = Math.max(this.duckTimer, 0.25);
      }
      p.ducking = p.onGround && this.duckTimer > 0;
    }

    this.groundOffset = (this.groundOffset + this.speed * dt) % 48;

    if (!this.resting) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.#spawnWave();
        this.spawnTimer =
          this.mode === "glider"
            ? 2.45 + Math.random() * 0.65
            : 2.6 + Math.random() * 1.2;
      }
    }

    const ph = this.mode === "runner" && p.ducking ? 26 : p.h;
    const phw = (this.mode === "runner" && p.ducking ? 40 : p.w) / 2;
    const pLeft = p.x - phw;
    const pRight = p.x + phw;
    const pTop = p.y - ph;
    const pBottom = p.y;

    for (const o of this.obstacles) o.x -= this.speed * dt;
    this.obstacles = this.obstacles.filter((o) => {
      if (o.type === "gate" && !o.cleared && !o.hit && o.x + o.w < pLeft) {
        o.cleared = true;
        this.addScore(10);
        this.popups.push({ x: o.x + o.w / 2, y: (o.gapTop + o.gapBottom) / 2 - 10, text: "+10", life: 0.7 });
      }
      if (o.x + o.w < 0) {
        if (!o.hit && !o.cleared) this.addScore(5);
        return false;
      }
      return true;
    });

    for (const c of this.coinItems) {
      c.x -= this.speed * dt;
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

    for (const o of this.obstacles) {
      let hit = false;
      if (o.type === "gate") {
        const inX = o.x + 5 < pRight - 4 && o.x + o.w - 5 > pLeft + 4;
        if (inX) {
          const hitsTopPipe = pTop + 4 < o.gapTop - 6;
          const hitsBottomPipe = pBottom - 4 > o.gapBottom + 6;
          hit = hitsTopPipe || hitsBottomPipe;
        }
      } else {
        const oTop = o.y;
        const oBottom = o.y + o.h;
        hit =
          o.x + 4 < pRight - 5 &&
          o.x + o.w - 4 > pLeft + 5 &&
          oBottom - 4 > pTop + 4 &&
          oTop + 4 < pBottom - 2;
      }
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

  #drawObstaclesAndCoins(ctx) {
    if (this.mode === "glider" && this.coinItems.length > 1) {
      const trails = new Map();
      for (const c of this.coinItems) {
        if (c.trailId == null) continue;
        let arr = trails.get(c.trailId);
        if (!arr) {
          arr = [];
          trails.set(c.trailId, arr);
        }
        arr.push(c);
      }
      if (trails.size > 0) {
        ctx.save?.();
        ctx.strokeStyle = "rgba(242, 184, 75, 0.34)";
        ctx.lineWidth = 2;
        ctx.setLineDash?.([5, 5]);
        for (const pts of trails.values()) {
          if (pts.length < 2) continue;
          pts.sort((a, b) => a.x - b.x);
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.stroke();
        }
        ctx.setLineDash?.([]);
        ctx.restore?.();
      }
    }

    for (const o of this.obstacles) {
      if (o.type === "gate") {
        const bodyCol = o.hit ? "#5a3a4a" : "#e85d75";
        const capCol = o.hit ? "#6e4b6e" : "#a855f7";
        const shineCol = "rgba(255, 255, 255, 0.16)";
        if (o.gapTop > 0) {
          ctx.fillStyle = bodyCol;
          ctx.fillRect(o.x, 0, o.w, o.gapTop);
          ctx.fillStyle = shineCol;
          ctx.fillRect(o.x + 5, 0, 6, o.gapTop);
          const capH = Math.min(12, o.gapTop);
          ctx.fillStyle = capCol;
          ctx.fillRect(o.x - 4, o.gapTop - capH, o.w + 8, capH);
        }
        const botH = this.groundY - o.gapBottom;
        if (botH > 0) {
          ctx.fillStyle = bodyCol;
          ctx.fillRect(o.x, o.gapBottom, o.w, botH);
          ctx.fillStyle = shineCol;
          ctx.fillRect(o.x + 5, o.gapBottom, 6, botH);
          const capH = Math.min(12, botH);
          ctx.fillStyle = capCol;
          ctx.fillRect(o.x - 4, o.gapBottom, o.w + 8, capH);
        }
      } else if (o.type === "high") {
        // Flapping DurHack pterodactyl
        const wingUp = Math.sin(this.animClock * 11 + o.x * 0.05) > 0;
        ctx.fillStyle = o.hit ? "#5a3a5a" : "#a855f7";
        ctx.fillRect(o.x + 6, o.y + 8, 20, 8);
        // Wings
        if (wingUp) {
          ctx.fillRect(o.x + 10, o.y, 12, 9);
        } else {
          ctx.fillRect(o.x + 10, o.y + 15, 12, 7);
        }
        // Head & beak pointing left
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

    // Subtle elevation guide lines in glider mode
    if (this.mode === "glider") {
      ctx.fillStyle = "rgba(148, 163, 184, 0.08)";
      ctx.fillRect(36, 116, W - 36, 1);
      ctx.fillRect(36, 174, W - 36, 1);
      ctx.fillRect(36, 232, W - 36, 1);
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
