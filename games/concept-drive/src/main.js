import * as THREE from 'three';
import { Graphics } from './graphics.js';
import { Physics } from './physics.js';
import { World } from './world.js';
import { Car } from './car.js';
import { Vehicle } from './vehicle.js';
import { CameraRig } from './cameras.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { CarAudio } from './audio.js';
import { asset } from './assets.js';
import { TouchControls, isTouch } from './touch.js';
import { setTextureScale } from './textures.js';

const params = new URLSearchParams(location.search);
const hud = new HUD();
let booted = false;
const showError = msg => { if (!booted) hud.setLoading(1, `Couldn't start: ${msg}`); console.error(msg); };
addEventListener('error', e => showError(e.message || 'script error'));
addEventListener('unhandledrejection', e => showError(e.reason?.message || String(e.reason)));
let gfx = null;
try { gfx = new Graphics(document.getElementById('app')); }
catch (e) { showError('this browser has 3D graphics (WebGL) turned off or unavailable. Try Chrome or Safari, and close other tabs.'); }
const physics = new Physics();
const input = new Input();
const audio = new CarAudio();
const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (isTouch() && Math.min(screen.width, screen.height) < 900);
let quality = params.get('q') || (mobile ? 'low' : 'high');
if (mobile) setTextureScale(0.5);
const gesture = () => audio.start();
addEventListener('pointerdown', gesture);
addEventListener('keydown', gesture);

async function boot() {
  const steps = 7; let n = 0;
  const step = t => hud.setLoading(++n / steps, t);
  step('Loading HDRI environment (Poly Haven)');
  await gfx.loadEnvironment(asset('assets/hdri/pedestrian_overpass_1k.hdr'));
  gfx.setupPost(quality);

  const world = new World(gfx.scene, physics, gfx);
  await world.build(t => step(t));

  step('Loading car model');
  const car = new Car(gfx.scene, gfx);
  await car.load(window.__ASSETS ? asset('assets/source/car_concept.glb') : 'assets/models/car_concept.draco.glb', e => {
    if (e.total) hud.setLoading((n + e.loaded / e.total) / steps, `Loading car model ${Math.round(e.loaded / e.total * 100)}%`);
  });
  car.mirrorEvery = gfx.q.mirrorEvery;
  world.addParkedCars(k => car.makeParkedClone(k));

  const vehicle = new Vehicle(physics);
  vehicle.reset(world.spawn.pos, world.spawn.yaw);
  const rig = new CameraRig(gfx.camera, car);
  if (params.get('cam')) rig.mode = +params.get('cam');

  // street-lamp light pool for night driving: the nearest lamps get real spot lights
  const lampLights = [];
  for (let i = 0; i < 6; i++) {
    const l = new THREE.SpotLight(0xffd7a0, 0, 30, 0.95, 0.7, 2);
    gfx.scene.add(l, l.target);
    lampLights.push(l);
  }
  let lampTimer = 0;
  gfx.nightListeners.push(on => { for (const l of lampLights) l.intensity = on ? 160 : 0; car.setHeadlights(on); });

  // collisions -> sound + camera shake
  vehicle.body.addEventListener('collide', e => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (v > 1.2) { audio.impact(v); rig.bump(Math.min(1, v / 12)); }
  });

  // pre-compile shaders, then reveal
  car.update(0, vehicle.getState(0), null);
  rig.update(0.016, vehicle.getState(0), { active: false, dx: 0, dy: 0 });
  await gfx.renderer.compileAsync(gfx.scene, gfx.camera);
  if (params.get('night') === '1') gfx.setNight(true);
  hud.loaded();
  try { window.focus(); } catch {}
  hud.toast(isTouch() ? 'Left thumb steers · right thumb drives' : 'Press H for controls');
  window.__game = { gfx, world, car, vehicle, rig, input, physics };

  const act = {
    gesture,
    camera: () => hud.toast(`Camera: ${rig.next()}`),
    reset: (toStart) => { if (toStart) vehicle.reset(world.spawn.pos, world.spawn.yaw); else vehicle.recover(); hud.toast('Car reset'); },
    lights: () => { car.setHeadlights(!car.headlightsOn); hud.toast(`Headlights ${car.headlightsOn ? 'on' : 'off'}`); },
    night: () => { gfx.setNight(!gfx.night); hud.toast(gfx.night ? 'Night' : 'Day'); },
    paint: () => hud.toast(`Paint: ${car.setPaint(car.paintIndex + 1)}`),
  };
  if (isTouch()) {
    const tc = new TouchControls(input, act);
    input.touch = tc.state;
    hud.setTouchHelp();
  }
  booted = true;

  let last = performance.now();
  let slowTime = 0;
  const scripted = params.get('demo'); // used by automated tests: e.g. demo=drive
  let tAll = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    tAll += dt;
    let inp = input.update(dt);
    if (scripted === 'drive') inp = { throttle: tAll < 6 ? 1 : 0.4, brake: 0, steer: tAll > 6 && tAll < 7.5 ? 0.6 : 0, handbrake: false };

    // ---- toggles ----
    if (input.hit('KeyC')) act.camera();
    if (input.hit('KeyR')) act.reset(input.down('ShiftLeft', 'ShiftRight'));
    if (input.hit('KeyH')) hud.toggleHelp();
    if (input.hit('KeyL')) act.lights();
    if (input.hit('KeyN')) act.night();
    if (input.hit('KeyP')) act.paint();
    if (input.hit('KeyU')) { hud.units = hud.units === 'mph' ? 'kmh' : 'mph'; }
    if (input.hit('KeyM')) { audio.setMuted(!audio.muted); hud.toast(audio.muted ? 'Sound off' : 'Sound on'); }
    if (input.hit('KeyQ')) {
      const order = ['low', 'medium', 'high', 'ultra'];
      quality = order[(order.indexOf(quality) + 1) % order.length];
      gfx.setupPost(quality); car.mirrorEvery = gfx.q.mirrorEvery; hud.toast(`Graphics: ${quality}`);
    }

    // ---- simulate ----
    physics.step(dt, h => vehicle.step(h, inp));
    const s = vehicle.getState(dt);
    s.units = hud.units; s.headlights = car.headlightsOn;
    world.update(dt);
    car.setInteriorView(rig.interior);
    car.update(dt, s, rig.interior ? gfx.renderer : null);
    rig.update(dt, s, input.consumeDrag());
    if (params.get('dbg')) { const d = params.get('dbg').split(',').map(Number); const c = car.root.position; gfx.camera.position.set(c.x + d[0], c.y + d[1], c.z + d[2]); gfx.camera.lookAt(c.x + d[3], c.y + d[4], c.z + d[5]); }
    gfx.followShadow(car.root.position);
    audio.update(s, rig.interior);

    if (gfx.night && (lampTimer -= dt) <= 0) {
      lampTimer = 0.2;
      world.nearestLamps(car.root.position, lampLights.length).forEach((p, i) => {
        lampLights[i].position.copy(p); lampLights[i].target.position.set(p.x, 0, p.z);
      });
    }
    if (s.upright < 0.2 && s.speedKmh < 3) { slowTime += dt; if (slowTime > 2.5) { vehicle.recover(); slowTime = 0; hud.toast('Auto-recovered'); } } else slowTime = 0;

    gfx.render();
    hud.update(dt, s, rig.name);
    input.endFrame();
    window.__frames = (window.__frames || 0) + 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (gfx) boot().catch(e => showError(e.message || String(e)));
