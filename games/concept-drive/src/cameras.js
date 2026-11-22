// Camera rig: chase (third person), cockpit (first person), hood, bumper, cinematic trackside.
import * as THREE from 'three';

export const CAMERA_MODES = ['Chase', 'Cockpit', 'Hood', 'Bumper', 'Cinematic'];
const EYE = new THREE.Vector3(0, 0.975, 0.4); // driver's eye in car space (central driving seat)

export class CameraRig {
  constructor(camera, car) {
    this.cam = camera; this.car = car;
    this.mode = 0;
    this.pos = new THREE.Vector3(); this.look = new THREE.Vector3();
    this.orbitYaw = 0; this.orbitPitch = 0; this.lookYaw = 0; this.lookPitch = 0;
    this.shake = 0;
    this.cine = null;
    this.vel = new THREE.Vector3();
    this.lastCarPos = new THREE.Vector3();
    this.gLean = new THREE.Vector2();
    this.initialised = false;
  }
  get name() { return CAMERA_MODES[this.mode]; }
  next() { this.mode = (this.mode + 1) % CAMERA_MODES.length; this.initialised = false; this.cine = null; this.lookYaw = this.lookPitch = 0; return this.name; }
  get interior() { return this.mode === 1; }
  bump(s) { this.shake = Math.min(1, this.shake + s); }

  update(dt, state, drag) {
    const root = this.car.root, cam = this.cam;
    const q = root.quaternion, p = root.position;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const speed = state.speedKmh / 3.6;
    // velocity estimate for look-ahead and g-forces
    const v = p.clone().sub(this.lastCarPos).divideScalar(Math.max(dt, 1e-4));
    const acc = v.clone().sub(this.vel).divideScalar(Math.max(dt, 1e-4));
    this.vel.lerp(v, 0.3); this.lastCarPos.copy(p);
    const accLocal = acc.applyQuaternion(q.clone().invert());
    this.gLean.lerp(new THREE.Vector2(THREE.MathUtils.clamp(accLocal.x / 9.8, -1.2, 1.2), THREE.MathUtils.clamp(accLocal.z / 9.8, -1.2, 1.2)), Math.min(1, dt * 4));

    let fov = 60;
    cam.near = 0.05;
    if (this.mode === 0) {
      if (drag.active) { this.orbitYaw -= drag.dx * 0.006; this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + drag.dy * 0.004, -0.2, 0.9); }
      else { this.orbitYaw *= Math.pow(0.15, dt); this.orbitPitch *= Math.pow(0.3, dt); }
      // follow the direction of travel when moving, otherwise the car's heading
      let dir = fwd.clone(); dir.y = 0;
      dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
      const dist = 6.4 + Math.min(speed, 60) * 0.02, height = 2.0 + this.orbitPitch * 4;
      const target = p.clone().sub(dir.clone().multiplyScalar(dist)).add(new THREE.Vector3(0, height, 0));
      if (!this.initialised) { this.pos.copy(target); this.initialised = true; }
      const k = 1 - Math.pow(0.0015, dt);
      this.pos.lerp(target, k);
      // keep the camera above the ground and close to the target distance
      this.pos.y = Math.max(this.pos.y, p.y + 0.6);
      this.look.copy(p).add(new THREE.Vector3(0, 1.05, 0)).add(fwd.clone().multiplyScalar(1.5));
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
      fov = 58 + Math.min(speed, 70) * 0.18;
    } else if (this.mode === 1 || this.mode === 2 || this.mode === 3) {
      if (drag.active) { this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - drag.dx * 0.004, -2.2, 2.2); this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - drag.dy * 0.003, -0.6, 0.5); }
      else { this.lookYaw *= Math.pow(0.08, dt); this.lookPitch *= Math.pow(0.08, dt); }
      let eye, pitch = 0;
      if (this.mode === 1) {
        // head leans against g-forces, looks slightly into corners
        eye = EYE.clone().add(new THREE.Vector3(-this.gLean.x * 0.03, 0, -this.gLean.y * 0.025));
        pitch = -0.1;
        cam.near = 0.02;
        fov = 70;
      } else if (this.mode === 2) { eye = new THREE.Vector3(0, 1.22, 0.55); pitch = -0.06; fov = 64; }
      else { eye = new THREE.Vector3(0, 0.42, 2.55); pitch = 0; fov = 66; }
      const lookYaw = this.lookYaw + (this.mode === 1 ? (state.steerInput || 0) * 0.12 : 0);
      const local = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch + this.lookPitch, Math.PI + lookYaw, 0, 'YXZ'));
      cam.position.copy(eye).applyMatrix4(root.matrixWorld);
      cam.quaternion.copy(q).multiply(local);
      fov += Math.min(speed, 70) * 0.06;
    } else {
      // cinematic trackside: place a camera ahead of the car beside the road, hold until it passes
      if (!this.cine || this.cine.distanceTo(p) > 55) {
        const side = new THREE.Vector3(fwd.z, 0, -fwd.x).normalize().multiplyScalar(Math.random() < 0.5 ? 5.5 : -5.5);
        this.cine = p.clone().add(fwd.clone().setY(0).normalize().multiplyScalar(30 + speed * 0.8)).add(side);
        this.cine.y = 0.9 + Math.random() * 1.6;
      }
      cam.position.copy(this.cine);
      this.look.lerp(p.clone().add(new THREE.Vector3(0, 0.7, 0)), this.initialised ? 0.25 : 1);
      this.initialised = true;
      cam.lookAt(this.look);
      const d = this.cine.distanceTo(p);
      fov = THREE.MathUtils.clamp(2 * Math.atan(5 / Math.max(d, 1)) * 180 / Math.PI, 12, 60);
    }
    if (this.shake > 0) {
      const s = this.shake * 0.06;
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 3); }
    cam.updateProjectionMatrix();
  }
}
