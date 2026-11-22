// Keyboard (+ arrow keys) and gamepad input with analogue-style smoothing.
export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.throttle = 0; this.brake = 0; this.steer = 0;
    this.touch = null; // set by TouchControls
    addEventListener('keydown', e => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.drag = { active: false, dx: 0, dy: 0 };
    addEventListener('pointerdown', e => { if (e.target.tagName === 'CANVAS') { this.drag.active = true; this.drag.lx = e.clientX; this.drag.ly = e.clientY; } });
    addEventListener('pointerup', () => { this.drag.active = false; });
    addEventListener('pointermove', e => {
      if (!this.drag.active) return;
      this.drag.dx += e.clientX - this.drag.lx; this.drag.dy += e.clientY - this.drag.ly;
      this.drag.lx = e.clientX; this.drag.ly = e.clientY;
    });
  }
  down(...codes) { return codes.some(c => this.keys.has(c)); }
  hit(code) { if (this.pressed.has(code)) { this.pressed.delete(code); return true; } return false; }
  consumeDrag() { const d = { dx: this.drag.dx, dy: this.drag.dy, active: this.drag.active }; this.drag.dx = this.drag.dy = 0; return d; }

  update(dt) {
    let thr = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brk = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    let st = (this.down('KeyA', 'ArrowLeft') ? 1 : 0) - (this.down('KeyD', 'ArrowRight') ? 1 : 0);
    let hb = this.down('Space');
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && [...pads].find(p => p && p.connected);
    if (gp) {
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.12) st = -ax;
      thr = Math.max(thr, gp.buttons[7]?.value || 0);
      brk = Math.max(brk, gp.buttons[6]?.value || 0);
      hb = hb || gp.buttons[0]?.pressed;
    }
    const t = this.touch;
    if (t) {
      thr = Math.max(thr, t.throttle); brk = Math.max(brk, t.brake);
      if (t.steer !== 0) st = t.steer;
      hb = hb || t.handbrake;
    }
    const ramp = (cur, tgt, up, dn) => cur + Math.max(-dn * dt, Math.min(up * dt, tgt - cur));
    this.throttle = ramp(this.throttle, thr, 4, 8);
    this.brake = ramp(this.brake, brk, 5, 10);
    this.steer = st; // vehicle applies its own rate limit
    this.handbrake = !!hb;
    return { throttle: this.throttle, brake: this.brake, steer: this.steer, handbrake: this.handbrake };
  }
  endFrame() { this.pressed.clear(); }
}
