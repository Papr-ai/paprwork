const PaprCurl = {
  canvas: null, ctx: null, raf: null,
  side: 'left', t: 0, target: 0, hoverTarget: 0.14,
  isFlipping: false, onFrame: null, onPeak: null, onComplete: null,
  peakHeld: false, peakAt: 0, peakHoldMs: 220,
  init(id) {
    this.canvas = document.getElementById(id);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
  },
  resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  },
  setManual(side, t) {
    if (this.isFlipping) return;
    this.side = side;
    this.t = Math.max(0, Math.min(0.99, t));
    this.target = this.t;
    this.draw();
    this.onFrame && this.onFrame(this.side, this.t);
  },
  peekStart(side) {
    if (this.isFlipping) return;
    this.side = side;
    this.target = this.hoverTarget;
    this.run();
  },
  peekEnd() {
    if (this.isFlipping) return;
    this.target = 0;
    this.run();
  },
  flip(side, hooks = {}) {
    if (this.isFlipping) return;
    this.side = side;
    this.isFlipping = true;
    this.onFrame = hooks.onFrame || this.onFrame;
    this.onPeak = hooks.onPeak || null;
    this.onComplete = hooks.onComplete || null;
    this.peakHeld = false;
    this.peakAt = 0;
    this.target = 1;
    this.run();
  },
  finish() {
    this.t = 0; this.target = 0;
    this.isFlipping = false;
    this.peakHeld = false; this.peakAt = 0;
    this.ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.onFrame && this.onFrame(this.side, 0);
    this.onComplete && this.onComplete();
    this.onPeak = null; this.onComplete = null;
  },
  run() {
    if (this.raf) return;
    const tick = () => {
      if (this.isFlipping && this.target === 1 && this.t >= 0.995) {
        if (!this.peakAt) this.peakAt = performance.now();
        if (!this.peakHeld && performance.now() - this.peakAt >= this.peakHoldMs) {
          this.peakHeld = true;
          this.onPeak && this.onPeak();
          this.target = 0;
        }
      }

      const d = this.target - this.t;
      if (Math.abs(d) < 0.002) {
        this.t = this.target;
        this.draw();
        this.onFrame && this.onFrame(this.side, this.t);

        // Critical: when holding at peak (t≈1), keep ticking so peakHoldMs can elapse.
        if (this.isFlipping && this.target === 1 && !this.peakHeld) {
          this.raf = requestAnimationFrame(tick);
          return;
        }

        this.raf = null;
        if (this.isFlipping && this.target === 0 && this.t <= 0.002) this.finish();
        return;
      }

      const speed = this.isFlipping ? (this.target > this.t ? 0.048 : 0.062) : 0.14;
      this.t += d * speed;
      this.draw();
      this.onFrame && this.onFrame(this.side, this.t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  draw() {
    this.ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (this.t < 0.001) return;
    window.PaprCurlDraw.render(this.ctx, this.side, this.t, innerWidth, innerHeight);
  }
};
