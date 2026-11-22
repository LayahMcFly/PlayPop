// On-screen controls for phones and tablets: analogue steering pad (left thumb),
// gas / brake pedals + handbrake (right thumb), and buttons for camera, reset, lights, night.
export const isTouch = () => (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;

export class TouchControls {
  constructor(input, actions) {
    this.input = input;
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, active: false };
    document.body.classList.add('touch');
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="t-steer" id="tSteer" aria-label="Steering: hold left or right side">
        <span class="t-arrow l">◀</span><span class="t-knob" id="tKnob"></span><span class="t-arrow r">▶</span>
      </div>
      <div class="t-pedals">
        <button class="t-btn t-hb" id="tHb" type="button">HANDBRAKE</button>
        <div class="t-row">
          <button class="t-btn t-brake" id="tBrake" type="button">BRAKE<small>hold to reverse</small></button>
          <button class="t-btn t-gas" id="tGas" type="button">GAS</button>
        </div>
      </div>
      <div class="t-top">
        <button class="t-sm" data-act="camera" type="button">Camera</button>
        <button class="t-sm" data-act="reset" type="button">Reset</button>
        <button class="t-sm" data-act="lights" type="button">Lights</button>
        <button class="t-sm" data-act="night" type="button">Night</button>
        <button class="t-sm" data-act="paint" type="button">Paint</button>
      </div>
      <div class="t-rotate" id="tRotate">Turn your phone sideways for a bigger view</div>`;
    document.body.appendChild(root);
    const $ = id => root.querySelector('#' + id);

    // steering pad: finger position across the pad = steering amount
    const pad = $('tSteer'), knob = $('tKnob');
    let steerId = null;
    const steerFrom = e => {
      const r = pad.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2 * 0.8);
      const v = Math.max(-1, Math.min(1, x));
      this.state.steer = -v; // left on screen = steer left (+)
      knob.style.transform = `translateX(${v * r.width * 0.38}px)`;
    };
    pad.addEventListener('pointerdown', e => { e.preventDefault(); steerId = e.pointerId; pad.setPointerCapture(e.pointerId); pad.classList.add('on'); steerFrom(e); actions.gesture?.(); });
    pad.addEventListener('pointermove', e => { if (e.pointerId === steerId) steerFrom(e); });
    const steerEnd = e => { if (e.pointerId !== steerId) return; steerId = null; this.state.steer = 0; knob.style.transform = ''; pad.classList.remove('on'); };
    pad.addEventListener('pointerup', steerEnd); pad.addEventListener('pointercancel', steerEnd);

    const hold = (el, key) => {
      const on = e => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); el.classList.add('on'); this.state[key] = key === 'handbrake' ? true : 1; actions.gesture?.(); };
      const off = () => { el.classList.remove('on'); this.state[key] = key === 'handbrake' ? false : 0; };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
      el.addEventListener('contextmenu', e => e.preventDefault());
    };
    hold($('tGas'), 'throttle'); hold($('tBrake'), 'brake'); hold($('tHb'), 'handbrake');
    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { actions.gesture?.(); actions[b.dataset.act]?.(); }));
    // block page scroll / pinch zoom while driving
    root.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    this.state.active = true;
  }
}
