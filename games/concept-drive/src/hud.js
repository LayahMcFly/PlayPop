// On-screen HUD, toasts, help panel, loading screen.
export class HUD {
  constructor() {
    this.el = id => document.getElementById(id);
    this.speed = this.el('hud-speed'); this.unit = this.el('hud-unit'); this.gear = this.el('hud-gear');
    this.rpmFill = this.el('hud-rpm-fill'); this.cam = this.el('hud-cam'); this.toastEl = this.el('toast');
    this.fps = this.el('hud-fps');
    this.units = 'mph';
    this.toastT = 0;
    this.frames = 0; this.fpsT = 0; this.fpsVal = 60;
  }
  setLoading(frac, text) {
    this.el('load-bar').style.width = `${Math.round(frac * 100)}%`;
    if (text) this.el('load-text').textContent = text;
  }
  loaded() {
    this.el('loading').classList.add('done');
    this.el('hud').hidden = false;
  }
  toast(msg) { this.toastEl.textContent = msg; this.toastEl.classList.add('show'); this.toastT = 2.2; }
  setTouchHelp() {
    const t = this.el('help').querySelector('table');
    if (t) t.innerHTML = [
      ['Left pad', 'Steer: hold left or right side, further out = sharper'],
      ['GAS', 'Accelerate'], ['BRAKE', 'Brake · keep holding when stopped to reverse'],
      ['HANDBRAKE', 'Slide the back end'], ['Top buttons', 'Camera, reset, lights, night, paint'],
      ['Drag the view', 'Look around'],
    ].map(([a, b]) => `<tr><td><kbd>${a}</kbd></td><td>${b}</td></tr>`).join('');
  }
  toggleHelp() { this.el('help').classList.toggle('open'); }
  update(dt, s, camName) {
    const v = this.units === 'mph' ? s.speedKmh * 0.621371 : s.speedKmh;
    this.speed.textContent = Math.round(v);
    this.unit.textContent = this.units === 'mph' ? 'MPH' : 'KM/H';
    this.gear.textContent = s.gear;
    const f = Math.min(1, s.rpm / s.maxRpm);
    this.rpmFill.style.width = `${f * 100}%`;
    this.rpmFill.classList.toggle('red', s.rpm > s.redline - 300);
    this.cam.textContent = camName;
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.toastEl.classList.remove('show'); }
    this.frames++; this.fpsT += dt;
    if (this.fpsT > 0.5) { this.fpsVal = this.frames / this.fpsT; this.fps.textContent = `${Math.round(this.fpsVal)} fps`; this.frames = 0; this.fpsT = 0; }
  }
}
