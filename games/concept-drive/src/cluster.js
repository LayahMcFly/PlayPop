// Live instrument cluster drawn into the car's own dashboard screen UV layout (1024x256).
// Tachometer (left dial), digital + analog speedometer (right dial), gear selector PRND,
// fuel, coolant temperature, and warning lamps.
import * as THREE from 'three';

export class InstrumentCluster {
  constructor() {
    const c = this.canvas = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    this.ctx = c.getContext('2d');
    const t = this.texture = new THREE.CanvasTexture(c);
    t.flipY = false; // glTF UV convention
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    this.acc = 0;
    this.temp = 0.25;
    this.fuel = 0.82;
    this.draw({ speedKmh: 0, rpm: 900, gear: 'P', redline: 8000, maxRpm: 9000, throttle: 0, engineOn: true, units: 'mph', handbrake: true });
  }

  update(dt, s) {
    this.acc += dt;
    this.temp += ((s.engineOn ? 0.55 + s.throttle * 0.1 : 0.2) - this.temp) * dt * 0.02;
    this.fuel = Math.max(0.05, this.fuel - s.throttle * dt * 0.00008);
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    this.draw(s);
  }

  dial(cx, cy, r, value, max, ticks, labelEvery, red, label, unitLabel) {
    const g = this.ctx;
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
    const ang = v => a0 + (a1 - a0) * Math.min(1, Math.max(0, v / max));
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 10;
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    if (red) { g.strokeStyle = '#ff2a1a'; g.beginPath(); g.arc(cx, cy, r, ang(red), a1); g.stroke(); }
    // value arc
    const grd = g.createLinearGradient(cx - r, cy, cx + r, cy);
    grd.addColorStop(0, '#1fb6ff'); grd.addColorStop(1, '#8ae9ff');
    g.strokeStyle = grd; g.lineWidth = 10;
    g.beginPath(); g.arc(cx, cy, r, a0, ang(value)); g.stroke();
    // ticks
    g.fillStyle = '#e8f6ff'; g.strokeStyle = '#e8f6ff';
    for (let i = 0; i <= ticks; i++) {
      const v = max * i / ticks, a = ang(v), major = i % labelEvery === 0;
      g.lineWidth = major ? 3 : 1.5;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14));
      g.lineTo(cx + Math.cos(a) * (r - (major ? 28 : 21)), cy + Math.sin(a) * (r - (major ? 28 : 21)));
      g.stroke();
      if (major) {
        g.font = '600 17px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(label(v), cx + Math.cos(a) * (r - 45), cy + Math.sin(a) * (r - 45));
      }
    }
    // needle
    const a = ang(value);
    g.strokeStyle = '#ff5a2a'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12);
    g.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10)); g.stroke();
    g.fillStyle = '#222'; g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#555'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#9fb3c2'; g.font = '600 14px Arial'; g.fillText(unitLabel, cx, cy + r * 0.55);
  }

  draw(s) {
    const g = this.ctx, W = 1024, H = 256;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    // bezel matching the screen outline in the original asset texture
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 4;
    g.beginPath();
    g.moveTo(160, 20); g.lineTo(864, 20); g.quadraticCurveTo(884, 20, 892, 34);
    g.lineTo(1000, 220); g.quadraticCurveTo(1004, 238, 984, 238); g.lineTo(40, 238);
    g.quadraticCurveTo(20, 238, 26, 220); g.lineTo(134, 34); g.quadraticCurveTo(142, 20, 160, 20);
    g.stroke();
    if (!s.engineOn) return void (this.texture.needsUpdate = true);

    const mph = s.units === 'mph';
    const spd = mph ? s.speedKmh * 0.621371 : s.speedKmh;
    // tachometer
    this.dial(265, 140, 96, s.rpm, s.maxRpm, 18, 2, s.redline, v => (v / 1000).toFixed(0), 'x1000 RPM');
    // speedometer
    const smax = mph ? 200 : 320;
    this.dial(760, 140, 96, spd, smax, mph ? 20 : 16, mph ? 4 : 2, 0, v => v.toFixed(0), mph ? 'MPH' : 'KM/H');

    // centre: digital speed, gear, PRND
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff'; g.font = '700 74px Arial';
    g.fillText(Math.round(Math.abs(spd)).toString(), 512, 118);
    g.fillStyle = '#9fb3c2'; g.font = '600 16px Arial';
    g.fillText(mph ? 'mph' : 'km/h', 512, 140);
    const prnd = ['P', 'R', 'N', 'D'];
    const cur = s.gear === 'P' ? 'P' : s.gear === 'R' ? 'R' : s.gear === 'N' ? 'N' : 'D';
    prnd.forEach((l, i) => {
      const x = 452 + i * 40;
      g.font = l === cur ? '800 28px Arial' : '600 22px Arial';
      g.fillStyle = l === cur ? '#4fd1ff' : 'rgba(255,255,255,0.35)';
      g.fillText(l, x, 184);
    });
    if (cur === 'D') { g.fillStyle = '#4fd1ff'; g.font = '700 18px Arial'; g.fillText(String(s.gear), 512, 210); }

    // fuel + temperature bars
    const bar = (x, frac, lab, warnLow) => {
      for (let i = 0; i < 8; i++) {
        const on = i < Math.round(frac * 8);
        g.fillStyle = on ? (warnLow && frac < 0.2 ? '#ff8a1a' : (!warnLow && frac > 0.85 ? '#ff3a1a' : '#e8f6ff')) : 'rgba(255,255,255,0.12)';
        g.fillRect(x, 196 - i * 17, 18, 12);
      }
      g.fillStyle = '#9fb3c2'; g.font = '600 13px Arial'; g.fillText(lab, x + 9, 226);
    };
    bar(120, this.fuel, 'FUEL', true);
    bar(886, this.temp, 'TEMP', false);

    // telltales
    if (s.handbrake) { g.fillStyle = '#ff3b2f'; g.font = '800 18px Arial'; g.fillText('(P)', 410, 60); }
    if (s.headlights) { g.fillStyle = '#3cff8a'; g.font = '800 18px Arial'; g.fillText('≡D', 614, 60); }
    if (s.tcs) { g.fillStyle = '#ffb21a'; g.font = '800 16px Arial'; g.fillText('TCS', 512, 60); }
    if (s.rpm > s.redline - 200) { g.fillStyle = '#ff2a1a'; g.fillRect(380, 228, 264, 6); }
    this.texture.needsUpdate = true;
  }
}
