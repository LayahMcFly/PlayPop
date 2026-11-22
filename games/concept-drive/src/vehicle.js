// Vehicle dynamics: cannon-es RaycastVehicle (suspension, tyre friction, collisions)
// + engine torque curve, 7-speed automatic gearbox, RWD, brakes, handbrake, reverse,
// aero drag & downforce, simple traction control.
import * as CANNON from 'cannon-es';
import * as THREE from 'three';

const COM_Y = 0.55;          // centre of mass height above ground, car space
const R = 0.384;             // wheel radius (from the model)
const WHEELS = [             // x, z in car space (from the model's wheel nodes)
  [0.975, 1.485], [-0.975, 1.485], [0.982, -1.314], [-0.982, -1.314],
];

export const SPEC = {
  mass: 1480,
  torquePeak: 640,      // N·m
  idle: 900, redline: 8000, limiter: 8300, maxRpm: 9000,
  gears: [3.25, 2.25, 1.72, 1.36, 1.11, 0.92, 0.78],
  reverse: 3.1, final: 3.6, eff: 0.88,
  brakeImpulse: 36, handbrakeImpulse: 70,
  maxSteer: 0.58, highSpeedSteer: 0.12,
  cdA: 0.62, downforce: 0.9, rolling: 14,
};

function torqueCurve(rpm) {
  // normalised torque curve of a turbo V8: builds to plateau 3500–6500, falls toward redline
  const r = rpm / 1000;
  let t;
  if (r < 1) t = 0.35;
  else if (r < 3.5) t = 0.35 + (r - 1) / 2.5 * 0.65;
  else if (r < 6.5) t = 1.0;
  else t = 1.0 - (r - 6.5) / 2.5 * 0.35;
  return t * SPEC.torquePeak;
}

export class Vehicle {
  constructor(physics) {
    this.physics = physics;
    const body = this.body = new CANNON.Body({ mass: SPEC.mass, material: physics.matCar });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.96, 0.26, 2.28)), new CANNON.Vec3(0, 0.08, 0.15));
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.72, 0.2, 1.05)), new CANNON.Vec3(0, 0.48, -0.15));
    body.angularDamping = 0.35;
    body.linearDamping = 0.01;
    body.allowSleep = false;

    const v = this.raycast = new CANNON.RaycastVehicle({
      chassisBody: body, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2,
    });
    const stiff = 34, rest = 0.3;
    const sag = 9.82 / (4 * stiff);
    for (let i = 0; i < 4; i++) {
      const [x, z] = WHEELS[i];
      v.addWheel({
        radius: R,
        directionLocal: new CANNON.Vec3(0, -1, 0),
        axleLocal: new CANNON.Vec3(-1, 0, 0),
        suspensionStiffness: stiff,
        suspensionRestLength: rest,
        frictionSlip: i < 2 ? 3.4 : 3.1,
        dampingRelaxation: 2.4,
        dampingCompression: 4.0,
        maxSuspensionForce: 200000,
        rollInfluence: 0.05,
        maxSuspensionTravel: 0.22,
        chassisConnectionPointLocal: new CANNON.Vec3(x, R + rest - COM_Y - sag, z),
        customSlidingRotationalSpeed: -30,
        useCustomSlidingRotationalSpeed: true,
      });
    }
    v.addToWorld(physics.world);
    this.baseSlip = v.wheelInfos.map(w => w.frictionSlip);

    this.gear = 1; this.mode = 'P';   // 'P' | 'D' | 'R' | 'N'
    this.rpm = SPEC.idle;
    this.steer = 0; this.throttle = 0; this.brake = 0;
    this.shiftTimer = 0; this.shifted = 0;
    this.reverseHold = 0;
    this.spin = [0, 0, 0, 0];
    this.tcs = false;
    this.engineOn = true;
    this.state = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
      wheelY: [R, R, R, R], wheelSteer: [0, 0, 0, 0], wheelSpin: this.spin,
    };
  }

  reset(pos, yaw) {
    const b = this.body;
    b.position.set(pos.x, (pos.y || 0) + COM_Y + 0.25, pos.z);
    b.quaternion.setFromEuler(0, yaw, 0);
    b.velocity.setZero(); b.angularVelocity.setZero();
    b.force.setZero(); b.torque.setZero();
    this.gear = 1; this.mode = 'P'; this.rpm = SPEC.idle;
  }

  // flip upright where it stands
  recover() {
    const b = this.body;
    const fwd = b.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
    const yaw = Math.atan2(fwd.x, fwd.z);
    this.reset(new THREE.Vector3(b.position.x, 0.4, b.position.z), yaw);
  }

  get forwardSpeed() {
    const f = this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
    return f.dot(this.body.velocity);
  }

  // input: {throttle 0..1, brake 0..1, steer -1..1 (left +), handbrake bool}
  step(dt, input) {
    const v = this.raycast, b = this.body;
    const speed = this.forwardSpeed, aspeed = Math.abs(speed);
    this.shifted = 0;

    // ---- gear selector logic (automatic with drive/reverse) ----
    let throttle = 0, brake = 0;
    const wantFwd = input.throttle > 0.05, wantBack = input.brake > 0.05;
    if (this.mode === 'P' && (wantFwd || wantBack)) { this.mode = wantFwd ? 'D' : 'R'; this.gear = 1; }
    if (this.mode === 'D') {
      throttle = input.throttle;
      if (wantBack) {
        if (speed > 0.8) brake = input.brake;
        else { this.reverseHold += dt; brake = 1; if (this.reverseHold > 0.25) { this.mode = 'R'; this.shifted = -1; } }
      } else this.reverseHold = 0;
    } else if (this.mode === 'R') {
      throttle = input.brake;
      if (wantFwd) {
        if (speed < -0.8) brake = input.throttle;
        else { this.reverseHold += dt; brake = 1; if (this.reverseHold > 0.15) { this.mode = 'D'; this.gear = 1; this.shifted = 1; } }
      } else this.reverseHold = 0;
    }
    if (!wantFwd && !wantBack) this.reverseHold = 0;
    if (!wantFwd && !wantBack && aspeed < 0.15 && this.mode !== 'P') { brake = Math.max(brake, 0.25); }

    // ---- automatic shifting ----
    const ratio = this.mode === 'R' ? SPEC.reverse : SPEC.gears[this.gear - 1];
    const wheelRpm = aspeed / R * 60 / (2 * Math.PI);
    let rpm = wheelRpm * ratio * SPEC.final;
    if (this.mode === 'D' && this.shiftTimer <= 0) {
      if (rpm > SPEC.redline - 300 && this.gear < SPEC.gears.length) { this.gear++; this.shiftTimer = 0.22; this.shifted = 1; }
      else if (this.gear > 1) {
        const lower = wheelRpm * SPEC.gears[this.gear - 2] * SPEC.final;
        const down = throttle > 0.6 ? 5200 : 3300;
        if (rpm < (throttle > 0.6 ? 4200 : 2300) && lower < SPEC.redline - 800 && lower > 0 && rpm < down) { this.gear--; this.shiftTimer = 0.18; this.shifted = -1; }
      }
    }
    this.shiftTimer -= dt;
    // clutch slip / launch at low speed
    const slipRpm = SPEC.idle + throttle * 3200;
    if (this.gear === 1 || this.mode === 'R') rpm = Math.max(rpm, slipRpm * Math.max(0, 1 - aspeed / 8));
    rpm = Math.max(SPEC.idle, rpm);
    if (this.shiftTimer > 0) rpm = this.rpm + (rpm - this.rpm) * Math.min(1, dt * 12);
    this.rpm += (Math.min(rpm, SPEC.limiter) - this.rpm) * Math.min(1, dt * 18);

    // ---- drive force (rear wheels) ----
    let force = 0;
    if ((this.mode === 'D' || this.mode === 'R') && this.shiftTimer <= 0 && throttle > 0) {
      const limiterCut = this.rpm >= SPEC.limiter - 20 ? 0 : 1;
      force = torqueCurve(this.rpm) * throttle * ratio * SPEC.final * SPEC.eff / R * limiterCut;
      // traction control: trim force when rear wheels are sliding
      const rearSkid = Math.min(v.wheelInfos[2].skidInfo, v.wheelInfos[3].skidInfo);
      this.tcs = !input.handbrake && rearSkid < 0.85 && aspeed > 1;
      if (this.tcs) force *= 0.55;
      if (this.mode === 'R') force = -Math.min(force, 5000);
    } else this.tcs = false;
    // engine force sign: positive pushes along -forward in cannon's convention
    v.applyEngineForce(-force / 2, 2);
    v.applyEngineForce(-force / 2, 3);
    v.applyEngineForce(0, 0); v.applyEngineForce(0, 1);

    // ---- brakes ----
    const bi = SPEC.brakeImpulse * brake;
    const hb = input.handbrake ? SPEC.handbrakeImpulse : 0;
    const park = this.mode === 'P' ? SPEC.handbrakeImpulse : 0;
    v.setBrake(bi * 1.15, 0); v.setBrake(bi * 1.15, 1);
    v.setBrake(Math.max(bi * 0.85, hb, park), 2); v.setBrake(Math.max(bi * 0.85, hb, park), 3);
    for (const i of [2, 3]) v.wheelInfos[i].frictionSlip = input.handbrake && aspeed > 3 ? this.baseSlip[i] * 0.52 : this.baseSlip[i];

    // ---- steering: rate-limited, speed-sensitive ----
    const maxSteer = THREE.MathUtils.lerp(SPEC.maxSteer, SPEC.highSpeedSteer, Math.min(1, aspeed / 45));
    const target = input.steer * maxSteer;
    const rate = input.steer === 0 ? 3.2 : 2.2;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);
    v.setSteeringValue(this.steer, 0); v.setSteeringValue(this.steer, 1);

    // ---- aero ----
    const vel = b.velocity, sp = vel.length();
    if (sp > 0.5) {
      const drag = 0.5 * 1.2 * SPEC.cdA * sp * sp + SPEC.rolling * sp * 0.2;
      b.applyForce(new CANNON.Vec3(-vel.x / sp * drag, -vel.y / sp * drag, -vel.z / sp * drag));
      const down = b.quaternion.vmult(new CANNON.Vec3(0, -SPEC.downforce * sp * sp, 0));
      b.applyForce(down);
    }

    this.throttle = throttle; this.brake = Math.max(brake, input.handbrake ? 1 : 0);
    this.handbrake = input.handbrake || this.mode === 'P';
    this.braking = brake > 0.05;
    this.steerInput = this.steer / SPEC.maxSteer;
  }

  // per-frame (not per physics step) state for rendering
  getState(dt) {
    const b = this.body, v = this.raycast, s = this.state;
    const q = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    s.quaternion.copy(q);
    s.position.set(b.position.x, b.position.y, b.position.z).add(new THREE.Vector3(0, -COM_Y, 0).applyQuaternion(q));
    const inv = q.clone().invert();
    const speed = this.forwardSpeed;
    for (let i = 0; i < 4; i++) {
      v.updateWheelTransform(i);
      const wt = v.wheelInfos[i].worldTransform.position;
      const local = new THREE.Vector3(wt.x - b.position.x, wt.y - b.position.y, wt.z - b.position.z).applyQuaternion(inv);
      s.wheelY[i] = local.y + COM_Y;
      s.wheelSteer[i] = i < 2 ? this.steer : 0;
      const wi = v.wheelInfos[i];
      let w = speed / R;
      if (i >= 2 && this.handbrake && Math.abs(speed) > 0.5) w = 0;          // locked rears
      else if (i >= 2 && this.throttle > 0.7 && wi.skidInfo < 0.7) w += (this.mode === 'R' ? -1 : 1) * 25; // wheelspin
      this.spin[i] += w * dt;
    }
    const sp = Math.abs(speed);
    s.speedKmh = sp * 3.6;
    s.speedMs = speed;
    s.rpm = this.rpm; s.redline = SPEC.redline; s.maxRpm = SPEC.maxRpm;
    s.gear = this.mode === 'D' ? this.gear : this.mode;
    s.mode = this.mode;
    s.throttle = this.throttle; s.brake = this.brake; s.braking = this.braking && sp > 0.2 || (this.brake > 0.5 && this.mode !== 'P');
    s.steerInput = this.steerInput || 0;
    s.shifted = this.shifted; s.handbrake = this.handbrake; s.tcs = this.tcs; s.engineOn = this.engineOn;
    s.skid = Math.max(0, 1 - Math.min(...v.wheelInfos.map(w => w.isInContact ? w.skidInfo : 1)));
    s.onGround = v.wheelInfos.some(w => w.isInContact);
    s.upright = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y;
    return s;
  }
}
