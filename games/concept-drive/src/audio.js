// Synthesised audio (no sample files needed): V8 engine, tyre squeal, wind, impacts.
export class CarAudio {
  constructor() { this.started = false; this.muted = false; }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0.55; this.master.connect(ctx.destination);

    // engine: two detuned saws + sub square -> waveshaper -> lowpass
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0.0;
    const lp = this.engLP = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.4); }
    shaper.curve = curve;
    this.oscs = [['sawtooth', 1, 0.5], ['sawtooth', 1.005, 0.4], ['square', 0.5, 0.35], ['triangle', 2, 0.18]].map(([type, mul, g]) => {
      const o = ctx.createOscillator(); o.type = type;
      const gg = ctx.createGain(); gg.gain.value = g;
      o.connect(gg).connect(shaper); o.start();
      return { o, mul };
    });
    // firing-pulse tremolo for a lumpy V8 burble at low rpm
    this.trem = ctx.createOscillator(); this.trem.type = 'sine';
    const tremGain = ctx.createGain(); tremGain.gain.value = 0.25;
    this.trem.connect(tremGain); this.trem.start();
    const ampMod = ctx.createGain(); ampMod.gain.value = 0.75;
    tremGain.connect(ampMod.gain);
    shaper.connect(ampMod).connect(lp).connect(this.engGain).connect(this.master);

    // noise buffer
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    // tyre squeal: narrow band noise
    this.sqGain = ctx.createGain(); this.sqGain.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 9;
    noise().connect(bp).connect(this.sqGain).connect(this.master);
    // wind + road roar
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    const wl = ctx.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 500;
    noise().connect(wl).connect(this.windGain).connect(this.master);
    this.started = true;
  }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.55; }

  update(s, interior) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const fire = s.rpm / 60 * 4; // V8 firing frequency
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(fire * mul * 0.5, t, 0.03);
    this.trem.frequency.setTargetAtTime(s.rpm / 60 / 2, t, 0.05);
    const load = 0.35 + s.throttle * 0.65;
    this.engLP.frequency.setTargetAtTime(400 + s.rpm * 0.22 * load * (interior ? 0.7 : 1), t, 0.05);
    this.engGain.gain.setTargetAtTime(s.engineOn ? (0.18 + s.throttle * 0.22) * (interior ? 0.8 : 1) : 0, t, 0.06);
    const sp = s.speedKmh / 3.6;
    this.sqGain.gain.setTargetAtTime(Math.min(0.35, s.skid * Math.min(1, sp / 6) * 0.5), t, 0.05);
    this.windGain.gain.setTargetAtTime(Math.min(0.35, (sp / 60) ** 2 * (interior ? 0.25 : 0.5)), t, 0.1);
  }

  impact(strength) {
    if (!this.started || strength < 0.5) return;
    const ctx = this.ctx, s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const g = ctx.createGain(), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380 + strength * 60;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(Math.min(0.9, strength * 0.12), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(lp).connect(g).connect(this.master); s.start(t); s.stop(t + 0.4);
  }
}
