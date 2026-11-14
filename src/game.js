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
  }

  // ---- pipeline event handlers ----
  onRep({ rom }) {
    if (!this.player.onGround) return;
    const strength = 0.55 + Math.min(1.2, Math.max(0, rom)) * 0.45; // 0.55..1.0
    this.player.vy = -620 * strength;
    this.player.onGround = false;
    this.lastJumpRom = rom;
    this.score += Math.round(10 * strength);
  }
  onHold({ holdMs }) {
    this.shield = Math.min(1, holdMs / 2000); // 2 s hold = full shield
    if (this.shield >= 1) this.shieldActive = true;
  }
  onProgress({ progress }) {
    this.player.crouch = Math.max(0, Math.min(1, progress));
  }

  // ---- loop ----
  loop(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.update(dt);
    this.draw();
    requestAnimationFrame((tt) => this.loop(tt));
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

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.obstacles.push({ x: this.W + 20, w: 22, h: 28 + Math.random() * 20 });
      this.spawnTimer = 2.2 + Math.random() * 1.6;
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
