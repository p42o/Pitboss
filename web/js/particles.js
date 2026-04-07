// Shared animated background — smoke wisps + floating card suits + drifting chips
export function initParticles(canvasId = 'smoke-canvas') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  // ── Smoke wisp ──────────────────────────────────────────────
  class Smoke {
    constructor() { this.reset(true); }
    reset(scatter = false) {
      this.x = Math.random() * canvas.width;
      this.y = scatter ? Math.random() * canvas.height : canvas.height + 30;
      this.r = Math.random() * 90 + 50;
      this.vy = -(Math.random() * 0.3 + 0.08);
      this.vx = (Math.random() - 0.5) * 0.2;
      this.alpha = Math.random() * 0.045 + 0.01;
      this.grow = Math.random() * 0.1 + 0.03;
      this.life = scatter ? Math.random() * 500 : 0;
      this.maxLife = Math.random() * 500 + 300;
    }
    update() {
      this.life++;
      this.y += this.vy;
      this.x += this.vx + Math.sin(this.life * 0.015) * 0.3;
      this.r += this.grow;
      this.a = this.alpha * Math.sin((this.life / this.maxLife) * Math.PI);
      if (this.life >= this.maxLife || this.y < -this.r) this.reset();
    }
    draw() {
      const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.r);
      g.addColorStop(0, `rgba(120, 100, 160, ${this.a})`);
      g.addColorStop(0.5, `rgba(70, 55, 110, ${this.a * 0.4})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ── Floating card suit ──────────────────────────────────────
  const SUITS = ['♠', '♥', '♦', '♣'];
  const SUIT_COLORS = ['rgba(201,168,76,', 'rgba(180,60,60,', 'rgba(180,60,60,', 'rgba(201,168,76,'];
  class Suit {
    constructor() { this.reset(true); }
    reset(scatter = false) {
      this.suit = Math.floor(Math.random() * 4);
      this.x = Math.random() * canvas.width;
      this.y = scatter ? Math.random() * canvas.height : canvas.height + 40;
      this.size = Math.random() * 18 + 10;
      this.vy = -(Math.random() * 0.25 + 0.05);
      this.vx = (Math.random() - 0.5) * 0.18;
      this.rotation = Math.random() * Math.PI * 2;
      this.rotSpeed = (Math.random() - 0.5) * 0.008;
      this.alpha = Math.random() * 0.18 + 0.04;
      this.life = scatter ? Math.random() * 600 : 0;
      this.maxLife = Math.random() * 700 + 400;
    }
    update() {
      this.life++;
      this.y += this.vy;
      this.x += this.vx + Math.sin(this.life * 0.012) * 0.2;
      this.rotation += this.rotSpeed;
      this.a = this.alpha * Math.sin((this.life / this.maxLife) * Math.PI);
      if (this.life >= this.maxLife || this.y < -40) this.reset();
    }
    draw() {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.rotation);
      ctx.globalAlpha = this.a;
      ctx.fillStyle = SUIT_COLORS[this.suit] + '1)';
      ctx.font = `${this.size}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(SUITS[this.suit], 0, 0);
      ctx.restore();
    }
  }

  // ── Chip dot ────────────────────────────────────────────────
  class Chip {
    constructor() { this.reset(true); }
    reset(scatter = false) {
      this.x = Math.random() * canvas.width;
      this.y = scatter ? Math.random() * canvas.height : canvas.height + 20;
      this.r = Math.random() * 4 + 2;
      this.vy = -(Math.random() * 0.2 + 0.04);
      this.vx = (Math.random() - 0.5) * 0.15;
      this.alpha = Math.random() * 0.12 + 0.03;
      this.life = scatter ? Math.random() * 800 : 0;
      this.maxLife = Math.random() * 800 + 500;
      // random chip color: gold, red, blue, white
      const cols = ['201,168,76', '200,60,60', '80,120,200', '200,200,220'];
      this.color = cols[Math.floor(Math.random() * cols.length)];
    }
    update() {
      this.life++;
      this.y += this.vy;
      this.x += this.vx + Math.sin(this.life * 0.02) * 0.15;
      this.a = this.alpha * Math.sin((this.life / this.maxLife) * Math.PI);
      if (this.life >= this.maxLife || this.y < -10) this.reset();
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.color},${this.a})`;
      ctx.fill();
      // inner ring
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r * 0.55, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${this.color},${this.a * 0.5})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // ── Build particle pools ────────────────────────────────────
  const smokes = Array.from({ length: 18 }, () => new Smoke());
  const suits  = Array.from({ length: 22 }, () => new Suit());
  const chips  = Array.from({ length: 30 }, () => new Chip());

  (function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    smokes.forEach(p => { p.update(); p.draw(); });
    suits.forEach(p  => { p.update(); p.draw(); });
    chips.forEach(p  => { p.update(); p.draw(); });
    requestAnimationFrame(animate);
  })();
}
