import * as CANNON from 'cannon-es';

export class Physics {
  constructor() {
    const w = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.allowSleep = true;
    w.defaultContactMaterial.friction = 0.3;
    w.solver.iterations = 10;
    this.matGround = new CANNON.Material('ground');
    this.matWorld = new CANNON.Material('world');
    this.matCar = new CANNON.Material('car');
    w.addContactMaterial(new CANNON.ContactMaterial(this.matCar, this.matWorld, { friction: 0.05, restitution: 0.15 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.matCar, this.matGround, { friction: 0.15, restitution: 0.05 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.matWorld, this.matGround, { friction: 0.5, restitution: 0.1 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.matWorld, this.matWorld, { friction: 0.4, restitution: 0.1 }));
    this.fixed = 1 / 120;
  }
  step(dt, before) {
    // fixed-step integration, max 8 sub-steps per frame
    this.acc = (this.acc || 0) + Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= this.fixed && n < 8) {
      before?.(this.fixed);
      this.world.step(this.fixed);
      this.acc -= this.fixed; n++;
    }
    this.alpha = this.acc / this.fixed;
  }
}
