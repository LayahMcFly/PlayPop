// Player car: loads the Khronos "Car Concept" glTF (CC BY 4.0), re-rigs the wheels for physics,
// drives the modeled steering wheel, live instrument cluster, lights, paint variants,
// and adds a camera-based digital rear-view mirror.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { InstrumentCluster } from './cluster.js';

export const WHEEL_RADIUS = 0.384;
const PAINTS = [
  { name: 'Carmine Candy', variant: 'Carmine' },
  { name: 'Pearly Swirly', variant: 'Pearl' },
  { name: 'Torched Graphite', variant: 'Graphite' },
  { name: 'Midnight Blue', variant: 'Graphite', color: 0x0b1f4a },
  { name: 'Racing Green', variant: 'Graphite', color: 0x0c3a22 },
  { name: 'Glacier White', variant: 'Pearl', color: 0xf2f2f0 },
];

export class Car {
  constructor(scene, gfx) {
    this.scene = scene; this.gfx = gfx;
    this.root = new THREE.Group();
    this.root.name = 'PlayerCar';
    scene.add(this.root);
    this.hubs = [];
    this.paintIndex = 0;
    this.headlightsOn = false;
  }

  async load(url, onProgress) {
    const loader = new GLTFLoader();
    if (/draco/.test(url)) {
      const draco = new DRACOLoader();
      draco.setDecoderPath('vendor/three/jsm/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
    }
    const gltf = await loader.loadAsync(url, onProgress);
    this.gltf = gltf;
    const model = this.model = gltf.scene;
    this.root.add(model);
    model.updateMatrixWorld(true);

    // collect paint variant materials (KHR_materials_variants), loaded on demand from the parser
    const parser = gltf.parser, defs = parser.json.materials;
    this.variantMats = {};
    for (let i = 0; i < defs.length; i++) {
      const nm = defs[i].name || '';
      const m = /^(Paint 1|Paint 2|Interior 3) (Carmine|Pearl|Graphite)$/.exec(nm);
      if (m) this.variantMats[nm] = await parser.getDependency('material', i);
    }

    const mats = {};
    model.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m.name) mats[m.name] = m;
    });
    this.mats = mats;
    this.setupGlass();
    this.setupLights();
    this.rigWheels();
    this.rigSteering();
    // template for parked cars: wheels rigged, no interior electronics
    this.template = model.clone(true);
    // parked copies get their own (unlit) light materials so they don't mirror the player's lights
    const idle = {};
    this.template.traverse(o => {
      if (!o.isMesh || !/^(Brakelight|Headlight|Dashboard)$/.test(o.material.name)) return;
      const n = o.material.name;
      if (!idle[n]) { idle[n] = o.material.clone(); idle[n].emissiveIntensity = n === 'Headlight' ? 0.4 : 0; }
      o.material = idle[n];
    });
    this.setupCluster();
    this.setupRearMirror();
    this.setupLightSources();
    return this;
  }

  setupGlass() {
    const g = this.mats['Glass'];
    if (g) {
      // Replace screen-space transmission (renders the scene twice) with a physically-plausible
      // thin tinted glass: Fresnel reflections from the HDRI + alpha.
      const glass = new THREE.MeshPhysicalMaterial({
        name: 'Glass', color: 0x0e1418, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.32,
        side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.6, specularIntensity: 1, ior: 1.52,
      });
      this.glass = glass;
      this.model.traverse(o => { if (o.isMesh && o.material === g) { o.material = glass; o.castShadow = false; o.renderOrder = 2; } });
      this.mats['Glass'] = glass;
    }
    const mirror = this.mats['Mirror'];
    if (mirror) { mirror.metalness = 1; mirror.roughness = 0.0; mirror.color.set(0xdddddd); mirror.envMapIntensity = 1.2; mirror.emissiveIntensity = 0.05; }
    for (const n of ['Paint 1 Carmine', 'Paint 2 Carmine']) {
      const m = this.mats[n]; if (m) { m.envMapIntensity = 1.3; }
    }
  }

  setupLights() {
    const brake = this.mats['Brakelight'], head = this.mats['Headlight'], sig = this.mats['Signallight'];
    this.brakeMat = brake; this.headMat = head; this.sigMat = sig;
    if (brake) { brake.emissive.setRGB(1, 0.02, 0.01); brake.emissiveIntensity = 0.0; brake.color.set(0x220000); }
    if (head) { head.emissiveIntensity = 2.5; }
    if (sig) { sig.emissiveIntensity = 0.0; sig.color.set(0x1a0d00); }
  }

  // Wheels in the source asset carry baked steer/spin rotations. Rebuild each as
  // hub (steer + suspension travel) -> spin (rim, tyre, disc); brake pads stay on the hub.
  rigWheels() {
    const names = ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR'];
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    for (const nm of names) {
      const w = this.model.getObjectByName(nm);
      const pos = new THREE.Vector3().setFromMatrixPosition(w.matrixWorld).applyMatrix4(rootInv);
      const hub = new THREE.Group(); hub.name = nm + 'Hub';
      const spin = new THREE.Group(); spin.name = nm + 'Spin';
      hub.add(spin);
      hub.position.copy(pos);
      this.model.add(hub);
      // model has a -90deg X root matrix on its first child; parts must be re-expressed in car space
      const kids = [...w.children];
      for (const k of kids) {
        const isPad = /BrakePad/.test(k.name);
        (isPad ? hub : spin).add(k);
        k.position.set(0, 0, 0);
        k.quaternion.identity();
        // geometry is authored with the axle along local X — matches car X axis
      }
      w.removeFromParent();
      // brake caliper sits at the rear-top of the disc
      for (const k of hub.children) if (/BrakePad/.test(k.name)) k.rotation.x = -0.6;
      this.hubs.push({ hub, spin, rest: pos.clone(), name: nm });
    }
    // model root may be scaled/rotated; hubs are added to the model (car space) directly
  }

  rigSteering() {
    this.steeringNode = this.model.getObjectByName('InteriorSteeringCylinder');
    this.steeringBase = this.steeringNode.quaternion.clone();
    this.paddleL = this.model.getObjectByName('InteriorSteeringHandleL');
    this.paddleR = this.model.getObjectByName('InteriorSteeringHandleR');
    this.paddleBaseL = this.paddleL?.quaternion.clone();
    this.paddleBaseR = this.paddleR?.quaternion.clone();
    this.pedalAccel = this.model.getObjectByName('InteriorPedalAccel');
    this.pedalBrake = this.model.getObjectByName('InteriorPedalBrake');
    this.pedalAccelBase = this.pedalAccel?.position.clone();
    this.pedalBrakeBase = this.pedalBrake?.position.clone();
    this.paddleTimer = 0;
  }

  // The asset's dashboard screen is UV-mapped to a 1024x256 emissive texture.
  // We replace it with a live canvas that renders speed / RPM / gear / fuel / temperature.
  setupCluster() {
    const dash = this.mats['Dashboard'];
    this.cluster = new InstrumentCluster();
    if (dash) {
      dash.emissiveMap = this.cluster.texture;
      dash.emissive.set(0xffffff);
      dash.emissiveIntensity = 2.2;
      dash.needsUpdate = true;
    }
  }

  setupRearMirror() {
    // Camera-based digital rear-view mirror, hung below the windshield header in front of the driver
    this.mirrorRT = new THREE.WebGLRenderTarget(512, 128, { samples: 2 });
    this.mirrorCam = new THREE.PerspectiveCamera(32, 4, 0.5, 600);
    this.mirrorCam.position.set(0, 1.25, -2.4);
    this.mirrorCam.rotation.set(-0.06, Math.PI, 0);
    this.root.add(this.mirrorCam);
    const housing = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.078, 0.03, 4, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6, metalness: 0.2 }));
    const scr = new THREE.PlaneGeometry(0.255, 0.064);
    const uv = scr.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // mirror image
    const screen = new THREE.Mesh(scr, new THREE.MeshBasicMaterial({ map: this.mirrorRT.texture }));
    screen.position.z = -0.0155; screen.rotation.y = Math.PI;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.06, 10), housing.material);
    stem.position.set(0, 0.06, 0.01);
    const m = this.rearMirror = new THREE.Group();
    m.add(housing, screen, stem);
    m.position.set(-0.34, 0.9, 1.02);
    m.rotation.set(-0.12, -0.32, 0, 'YXZ');
    m.scale.setScalar(0.85);
    this.model.add(m);
    this.mirrorFrame = 0;
  }

  setupLightSources() {
    this.headSpots = [];
    for (const x of [0.62, -0.62]) {
      const s = new THREE.SpotLight(0xf4f6ff, 0, 120, 0.42, 0.55, 2);
      s.position.set(x, 0.68, 2.2);
      s.target.position.set(x * 1.5, 0.0, 14);
      this.root.add(s, s.target);
      this.headSpots.push(s);
    }
    this.tailLight = new THREE.PointLight(0xff1a0a, 0, 7, 2);
    this.tailLight.position.set(0, 0.95, -2.1);
    this.root.add(this.tailLight);
  }

  setHeadlights(on) {
    this.headlightsOn = on;
    for (const s of this.headSpots) s.intensity = on ? 260 : 0;
    if (this.headMat) this.headMat.emissiveIntensity = on ? 14 : 2.5;
  }

  setPaint(i) {
    this.paintIndex = (i + PAINTS.length) % PAINTS.length;
    const p = PAINTS[this.paintIndex];
    this.applyPaint(this.model, p, true);
    return p.name;
  }

  applyPaint(obj, p, own) {
    const v = this.variantMats;
    const mk = n => {
      let m = v[`${n} ${p.variant}`];
      if (!m) return null;
      if (p.color && n !== 'Interior 3') { m = m.clone(); m.color.set(p.color); }
      m.envMapIntensity = 1.3;
      return m;
    };
    const rep = { 'Paint 1': mk('Paint 1'), 'Paint 2': mk('Paint 2'), 'Interior 3': mk('Interior 3') };
    obj.traverse(o => {
      if (!o.isMesh) return;
      const n = o.userData.paintSlot || (o.userData.paintSlot = (/^(Paint 1|Paint 2|Interior 3) /.exec(o.material.name || '') || [])[1]);
      if (n && rep[n]) o.material = rep[n];
    });
  }

  makeParkedClone(k) {
    const c = this.template.clone(true);
    this.applyPaint(c, PAINTS[(k + 1) % PAINTS.length], false);
    const g = new THREE.Group();
    g.add(c);
    // steer the front wheels a touch for a natural parked look
    for (const nm of ['WheelFrontLHub', 'WheelFrontRHub']) { const h = c.getObjectByName(nm); if (h) h.rotation.y = (k % 2 ? 0.25 : -0.2); }
    return g;
  }

  setInteriorView(on) {
    this.interior = on;
    if (this.glass) this.glass.opacity = on ? 0.1 : 0.32;
    // the headlight strips sit just below the driver's sight line; keep their glow off the dash
    if (this.headMat) this.headMat.emissiveIntensity = on ? 0.3 : (this.headlightsOn ? 14 : 2.5);
  }

  // state from vehicle.js
  update(dt, s, renderer) {
    // chassis transform
    this.root.position.copy(s.position);
    this.root.quaternion.copy(s.quaternion);
    this.root.updateMatrixWorld();

    // wheels: suspension travel, steer, spin
    for (let i = 0; i < 4; i++) {
      const h = this.hubs[i];
      h.hub.position.set(h.rest.x, s.wheelY[i], h.rest.z);
      h.hub.rotation.set(0, s.wheelSteer[i], 0);
      h.spin.rotation.x = s.wheelSpin[i];
    }
    // steering wheel turns about its column axis (local Y of the column node)
    const sw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -s.steerInput * 2.4);
    this.steeringNode.quaternion.copy(this.steeringBase).multiply(sw);
    // paddle shifter flick on gear change
    if (s.shifted) this.paddleTimer = 0.18 * Math.sign(s.shifted);
    if (this.paddleL && this.paddleTimer !== 0) {
      const t = this.paddleTimer;
      const ang = 0.18 * Math.min(1, Math.abs(t) / 0.18);
      const p = t > 0 ? this.paddleR : this.paddleL, b = t > 0 ? this.paddleBaseR : this.paddleBaseL;
      p.quaternion.copy(b).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang));
      this.paddleTimer = t > 0 ? Math.max(0, t - dt) : Math.min(0, t + dt);
      if (this.paddleTimer === 0) { this.paddleL.quaternion.copy(this.paddleBaseL); this.paddleR.quaternion.copy(this.paddleBaseR); }
    }
    if (this.pedalAccel) this.pedalAccel.position.copy(this.pedalAccelBase).add(new THREE.Vector3(0, 0, 0.04 * s.throttle));
    if (this.pedalBrake) this.pedalBrake.position.copy(this.pedalBrakeBase).add(new THREE.Vector3(0, 0, 0.04 * s.brake));

    // lights
    const tail = this.headlightsOn ? 0.9 : 0.0;
    if (this.brakeMat) this.brakeMat.emissiveIntensity = s.braking ? 7 : tail;
    this.tailLight.intensity = s.braking ? 6 : (this.headlightsOn ? 1.2 : 0);
    if (this.sigMat) this.sigMat.emissiveIntensity = s.gear === 'R' ? 0 : 0; // reserved for indicators

    this.cluster.update(dt, s);

    // digital mirror
    if (this.interior && renderer) {
      this.mirrorFrame++;
      if (this.mirrorFrame % (this.mirrorEvery || 1) === 0) {
        this.rearMirror.visible = false;
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(this.mirrorRT);
        renderer.render(this.scene, this.mirrorCam);
        renderer.setRenderTarget(prev);
        this.rearMirror.visible = true;
      }
    }
  }
}
