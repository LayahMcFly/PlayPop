// City environment: road grid, sidewalks, buildings, streetlights, traffic signals,
// street signs, park, construction cones, parked cars. Builds matching physics colliders.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GeoBuilder } from './geobuilder.js';
import { getMaterialTextures, getFacadeTextures, optionalAssets } from './textures.js';
import { asset } from './assets.js';

export const CITY = {
  LOT: 70, ROAD: 14, WALK: 4, CURB: 0.15, N: 4, OUTER: 50,
};
const STEP = CITY.LOT + CITY.ROAD; // 84
export const roadPos = i => (i - CITY.N / 2) * STEP; // i=0..N
const HALF = (CITY.N / 2) * STEP + CITY.ROAD / 2; // 175: inner edge of the outer ring of lots

const AVENUES = ['Harbor Ave', 'Linden Ave', 'Central Ave', 'Kingsley Ave', 'Rivers Ave'];
const STREETS = ['1st St', '2nd St', '3rd St', '4th St', '5th St'];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export class World {
  constructor(scene, physics, gfx) {
    this.scene = scene; this.physics = physics; this.gfx = gfx;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.dynamic = []; // {mesh, body}
    this.streetLampPositions = [];
    this.signalTimer = 0;
    this.spawn = { pos: new THREE.Vector3(roadPos(2) - 1.75, 0, roadPos(0) + 18), yaw: 0 };
  }

  staticBox(cx, cy, cz, hx, hy, hz, mat) {
    const b = new CANNON.Body({ mass: 0, material: mat || this.physics.matWorld });
    b.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
    b.position.set(cx, cy, cz);
    this.physics.world.addBody(b);
    return b;
  }

  async build(onStep = () => {}) {
    onStep('Generating road & pavement materials');
    await this.buildGround();
    onStep('Building city blocks');
    this.buildBlocks();
    onStep('Painting road markings');
    this.buildMarkings();
    onStep('Placing streetlights & signals');
    this.buildStreetlights();
    this.buildSignals();
    onStep('Loading props');
    await this.buildProps();
    await this.tryOptionalTrees();
    this.gfx.nightListeners.push(on => this.setNight(on));
  }

  // ---------------- ground, sidewalks, park ----------------
  async buildGround() {
    const asphalt = await getMaterialTextures('asphalt', [1, 1]);
    const ext = 900;
    const tile = 6; // metres per asphalt tile
    const roadMat = this.roadMat = new THREE.MeshStandardMaterial({
      ...asphalt, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 0.6,
    });
    const g = new THREE.PlaneGeometry(ext * 2, ext * 2);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ext * 2 / tile, uv.getY(i) * ext * 2 / tile);
    const ground = new THREE.Mesh(g, roadMat);
    ground.receiveShadow = true;
    this.group.add(ground);

    const pb = new CANNON.Body({ mass: 0, material: this.physics.matGround });
    pb.addShape(new CANNON.Plane());
    pb.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.physics.world.addBody(pb);

    const walk = await getMaterialTextures('sidewalk', [1, 1]);
    const curb = await getMaterialTextures('curb', [1, 1]);
    const grass = await getMaterialTextures('grass', [1, 1]);
    this.walkMat = new THREE.MeshStandardMaterial({ ...walk, roughness: 1, metalness: 0 });
    this.curbMat = new THREE.MeshStandardMaterial({ ...curb, roughness: 1, metalness: 0 });
    this.grassMat = new THREE.MeshStandardMaterial({ ...grass, roughness: 1, metalness: 0 });
    this.roofTex = await getMaterialTextures('roof', [1, 1]);
  }

  // lots: list of rectangles (x0,z0,x1,z1) raised by the curb height
  lots() {
    const L = [];
    for (let i = 0; i < CITY.N; i++) for (let j = 0; j < CITY.N; j++) {
      const x0 = roadPos(i) + CITY.ROAD / 2, z0 = roadPos(j) + CITY.ROAD / 2;
      L.push({ x0, z0, x1: x0 + CITY.LOT, z1: z0 + CITY.LOT, i, j, inner: true });
    }
    const H = HALF, O = HALF + CITY.OUTER;
    L.push({ x0: -O, z0: H, x1: O, z1: O, outer: 'n' });
    L.push({ x0: -O, z0: -O, x1: O, z1: -H, outer: 's' });
    L.push({ x0: H, z0: -H, x1: O, z1: H, outer: 'e' });
    L.push({ x0: -O, z0: -H, x1: -H, z1: H, outer: 'w' });
    return L;
  }

  buildBlocks() {
    const C = CITY.CURB, W = CITY.WALK;
    const walkB = new GeoBuilder(), curbB = new GeoBuilder(), grassB = new GeoBuilder();
    const styles = ['glass', 'brick', 'stone', 'panel'];
    const facades = {};
    styles.forEach((s, k) => facades[s] = getFacadeTextures(s, 5 + k * 7));
    facades.store = getFacadeTextures('store', 77);
    const fb = {}; for (const s of [...styles, 'store']) fb[s] = new GeoBuilder();
    const roofB = new GeoBuilder(), trimB = new GeoBuilder(), mechB = new GeoBuilder();
    const R = rng(4242);
    this.parkLot = null;

    for (const lot of this.lots()) {
      const { x0, z0, x1, z1 } = lot;
      walkB.top(x0, z0, x1, z1, C, 2.0);
      curbB.walls(x0, z0, x1, z1, 0, C, 1, 1);
      this.staticBox((x0 + x1) / 2, C / 2, (z0 + z1) / 2, (x1 - x0) / 2, C / 2, (z1 - z0) / 2, this.physics.matGround);

      if (lot.inner && lot.i === 1 && lot.j === 2) { // park block
        this.parkLot = lot;
        const g = 6;
        grassB.top(x0 + g, z0 + g, (x0 + x1) / 2 - 2, (z0 + z1) / 2 - 2, C + 0.02, 4);
        grassB.top((x0 + x1) / 2 + 2, z0 + g, x1 - g, (z0 + z1) / 2 - 2, C + 0.02, 4);
        grassB.top(x0 + g, (z0 + z1) / 2 + 2, (x0 + x1) / 2 - 2, z1 - g, C + 0.02, 4);
        grassB.top((x0 + x1) / 2 + 2, (z0 + z1) / 2 + 2, x1 - g, z1 - g, C + 0.02, 4);
        curbB.walls(x0 + g, z0 + g, (x0 + x1) / 2 - 2, (z0 + z1) / 2 - 2, C, C + 0.02, 1, 1);
        continue;
      }
      // parcel subdivision of the buildable interior
      const bx0 = x0 + W, bz0 = z0 + W, bx1 = x1 - W, bz1 = z1 - W;
      const parcels = [];
      const split = (a0, b0, a1, b1, depth) => {
        const w = a1 - a0, d = b1 - b0;
        if ((w < 34 && d < 34) || depth > 5) { parcels.push([a0, b0, a1, b1]); return; }
        if (w >= d) { const m = a0 + Math.round((w * (0.35 + R() * 0.3)) / 3) * 3; split(a0, b0, m, b1, depth + 1); split(m, b0, a1, b1, depth + 1); }
        else { const m = b0 + Math.round((d * (0.35 + R() * 0.3)) / 3) * 3; split(a0, b0, a1, m, depth + 1); split(a0, m, a1, b1, depth + 1); }
      };
      split(bx0, bz0, bx1, bz1, 0);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const downtown = 1 - Math.min(1, Math.hypot(cx, cz) / 260);
      for (const [a0, b0, a1, b1] of parcels) {
        const gap = 0.4;
        const px0 = a0 + gap, pz0 = b0 + gap, px1 = a1 - gap, pz1 = b1 - gap;
        const style = styles[Math.floor(R() * styles.length)];
        const floors = Math.max(3, Math.round(3 + R() * 6 + downtown * downtown * (8 + R() * 22)));
        const gH = 4.5, fH = 3.5;
        const top = C + gH + floors * fH;
        const fbStore = fb.store, fbUp = fb[style];
        // storefront base
        fbStore.walls(px0, pz0, px1, pz1, C, C + gH, 12, 18, C);
        // upper floors (texture tile = 4 bays x 3m, 4 floors x 3.5m)
        fbUp.walls(px0, pz0, px1, pz1, C + gH, top, 12, 14, C + gH);
        // trim band between store & upper, cornice, parapet
        trimB.box(px0 - 0.15, C + gH - 0.1, pz0 - 0.15, px1 + 0.15, C + gH + 0.35, pz1 + 0.15, 2);
        trimB.box(px0 - 0.3, top, pz0 - 0.3, px1 + 0.3, top + 0.45, pz1 + 0.3, 2);
        trimB.walls(px0, pz0, px1, pz1, top + 0.45, top + 1.2, 2, 2);
        trimB.walls(px0 + 0.3, pz0 + 0.3, px1 - 0.3, pz1 - 0.3, top + 0.45, top + 1.2, 2, 2);
        trimB.top(px0, pz0, px1, pz0 + 0.3, top + 1.2, 2); trimB.top(px0, pz1 - 0.3, px1, pz1, top + 1.2, 2);
        trimB.top(px0, pz0, px0 + 0.3, pz1, top + 1.2, 2); trimB.top(px1 - 0.3, pz0, px1, pz1, top + 1.2, 2);
        roofB.top(px0 + 0.3, pz0 + 0.3, px1 - 0.3, pz1 - 0.3, top + 0.46, 6);
        // rooftop mechanical units
        const nm = 1 + Math.floor(R() * 3);
        for (let k = 0; k < nm; k++) {
          const w = 2 + R() * 4, d = 2 + R() * 3, h = 1.2 + R() * 2;
          const mx = px0 + 2 + R() * Math.max(0.1, px1 - px0 - 4 - w), mz = pz0 + 2 + R() * Math.max(0.1, pz1 - pz0 - 4 - d);
          mechB.box(mx, top + 0.46, mz, mx + w, top + 0.46 + h, mz + d, 1.5);
        }
        // setback tower on tall downtown buildings
        if (floors > 14 && (px1 - px0) > 20 && (pz1 - pz0) > 20) {
          const ins = 4, tFloors = Math.round(floors * (0.3 + R() * 0.4));
          const t0 = top + 0.46, t1 = t0 + tFloors * fH;
          fb.glass.walls(px0 + ins, pz0 + ins, px1 - ins, pz1 - ins, t0, t1, 12, 14, t0);
          trimB.box(px0 + ins - 0.3, t1, pz0 + ins - 0.3, px1 - ins + 0.3, t1 + 0.6, pz1 - ins + 0.3, 2);
          roofB.top(px0 + ins, pz0 + ins, px1 - ins, pz1 - ins, t1 + 0.61, 6);
        }
        this.staticBox((px0 + px1) / 2, top / 2, (pz0 + pz1) / 2, (px1 - px0) / 2, top / 2, (pz1 - pz0) / 2);
      }
    }

    const add = (builder, mat, cast = true) => {
      if (builder.empty) return null;
      const m = new THREE.Mesh(builder.build(), mat);
      m.castShadow = cast; m.receiveShadow = true;
      this.group.add(m); return m;
    };
    add(walkB, this.walkMat, false);
    add(curbB, this.curbMat, false);
    add(grassB, this.grassMat, false);
    this.windowMats = [];
    for (const s of Object.keys(fb)) {
      const t = facades[s];
      const mat = new THREE.MeshStandardMaterial({
        map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, metalnessMap: t.metalnessMap,
        roughness: 1, metalness: 1, emissiveMap: t.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0,
        envMapIntensity: 1.0,
      });
      this.windowMats.push(mat);
      add(fb[s], mat);
    }
    const trimTex = this.curbMat;
    add(trimB, new THREE.MeshStandardMaterial({ map: trimTex.map, normalMap: trimTex.normalMap, color: 0xd8d2c8, roughness: 0.8 }));
    add(roofB, new THREE.MeshStandardMaterial({ ...this.roofTex, roughness: 1 }), false);
    add(mechB, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.45, metalness: 0.7, normalMap: this.roofTex.normalMap }));
  }

  // ---------------- road paint ----------------
  buildMarkings() {
    const P = new GeoBuilder(true);
    const Y = 0.012, WHITE = [0.86, 0.86, 0.82], YEL = [0.85, 0.62, 0.12];
    const R2 = CITY.ROAD / 2;
    // stripe helpers for road running along axis 'z' (constant x) or 'x' (constant z)
    const rect = (ax, c0, c1, s0, s1, col) => { // along-road range c0..c1, cross range s0..s1
      if (ax === 'z') P.top(s0, c0, s1, c1, Y, 1, col); else P.top(c0, s0, c1, s1, Y, 1, col);
    };
    for (const ax of ['z', 'x']) {
      for (let i = 0; i <= CITY.N; i++) {
        const c = roadPos(i);
        for (let j = 0; j < CITY.N; j++) {
          const a = roadPos(j) + R2, b = roadPos(j + 1) - R2; // segment between intersections
          const s0 = a + 5.5, s1 = b - 5.5;
          // double yellow centre
          rect(ax, s0, s1, c - 0.27, c - 0.12, YEL); rect(ax, s0, s1, c + 0.12, c + 0.27, YEL);
          // lane dashes (3 m dash, 9 m gap)
          for (let t = s0 + 2; t < s1 - 3; t += 12) {
            rect(ax, t, t + 3, c - 3.56, c - 3.44, WHITE); rect(ax, t, t + 3, c + 3.44, c + 3.56, WHITE);
          }
          // edge lines
          rect(ax, s0, s1, c - 6.65, c - 6.5, WHITE); rect(ax, s0, s1, c + 6.5, c + 6.65, WHITE);
          // stop lines (right-hand traffic). Along +z: lanes at x<c. Along +x: lanes at z>c.
          const posSide = ax === 'z' ? [c - 6.6, c - 0.3] : [c + 0.3, c + 6.6];
          const negSide = ax === 'z' ? [c + 0.3, c + 6.6] : [c - 6.6, c - 0.3];
          rect(ax, s1, s1 + 0.5, posSide[0], posSide[1], WHITE);
          rect(ax, s0 - 0.5, s0, negSide[0], negSide[1], WHITE);
          // continental crosswalks at both ends
          for (const [k0, k1] of [[a + 1.2, a + 4.4], [b - 4.4, b - 1.2]]) {
            for (let s = c - R2 + 0.7; s < c + R2 - 0.6; s += 1.25) rect(ax, k0, k1, s, s + 0.6, WHITE);
          }
        }
      }
    }
    const paint = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0,
      normalMap: this.roadMat.normalMap, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(P.build(), paint);
    m.receiveShadow = true;
    this.group.add(m);
  }

  // ---------------- streetlights ----------------
  buildStreetlights() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.42, metalness: 0.85 });
    this.lampLensMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffe2b0, emissiveIntensity: 0.05, roughness: 0.2 });
    const pole = new THREE.CylinderGeometry(0.07, 0.11, 8.5, 16).translate(0, 4.25, 0);
    const base = new THREE.CylinderGeometry(0.2, 0.24, 0.6, 16).translate(0, 0.3, 0);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 8.3, 0), new THREE.Vector3(0, 9.3, 0.6), new THREE.Vector3(0, 9.1, 2.4));
    const arm = new THREE.TubeGeometry(curve, 20, 0.055, 10);
    const head = new THREE.CylinderGeometry(0.28, 0.34, 0.16, 24).scale(1, 1, 1.9).translate(0, 9.05, 2.75);
    const lens = new THREE.CylinderGeometry(0.25, 0.25, 0.02, 24).scale(1, 1, 1.8).translate(0, 8.96, 2.75);
    const metalGeo = mergeGeometries([pole, base, arm, head].map(g => g.toNonIndexed()));
    const geo = mergeGeometries([metalGeo, lens.toNonIndexed()], true);
    const spots = [];
    const R2 = CITY.ROAD / 2;
    for (const ax of ['z', 'x']) for (let i = 0; i <= CITY.N; i++) {
      const c = roadPos(i);
      for (let j = 0; j < CITY.N; j++) {
        const a = roadPos(j) + R2 + 8, b = roadPos(j + 1) - R2 - 8;
        for (let t = a; t <= b + 0.1; t += (b - a) / 2) {
          for (const side of [-1, 1]) {
            const off = c + side * (R2 + 0.8);
            const x = ax === 'z' ? off : t, z = ax === 'z' ? t : off;
            // arm points toward road centre: local +z -> direction (-side) across road
            const yaw = ax === 'z' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : (side > 0 ? Math.PI : 0);
            spots.push({ x, z, yaw });
          }
        }
      }
    }
    const inst = new THREE.InstancedMesh(geo, [metal, this.lampLensMat], spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    spots.forEach((s, k) => {
      q.setFromEuler(e.set(0, s.yaw, 0));
      m4.compose(new THREE.Vector3(s.x, CITY.CURB, s.z), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(k, m4);
      const lamp = new THREE.Vector3(0, CITY.CURB + 8.9, 2.75).applyQuaternion(q).add(new THREE.Vector3(s.x, 0, s.z));
      this.streetLampPositions.push(lamp);
      this.staticBox(s.x, 4, s.z, 0.14, 4, 0.14);
    });
    inst.castShadow = true;
    this.group.add(inst);
  }

  // ---------------- traffic signals + street name signs ----------------
  buildSignals() {
    const paintM = new THREE.MeshStandardMaterial({ color: 0x2d3033, roughness: 0.5, metalness: 0.8 });
    const housingM = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.55, metalness: 0.3 });
    const pole = new THREE.CylinderGeometry(0.12, 0.16, 6.4, 16).translate(0, 3.2, 0);
    const arm = new THREE.CylinderGeometry(0.07, 0.09, 6.6, 12).rotateZ(Math.PI / 2).translate(3.3, 6.1, 0);
    const poleGeo = mergeGeometries([pole.toNonIndexed(), arm.toNonIndexed()]);
    const housing = new THREE.BoxGeometry(0.38, 1.1, 0.28).translate(0, 0, 0);
    const visor = new THREE.CylinderGeometry(0.13, 0.13, 0.22, 16, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
    const housingGeo = mergeGeometries([housing.toNonIndexed(),
      ...[0.34, 0, -0.34].map(y => visor.clone().translate(0, y + 0.06, -0.25).toNonIndexed())]);
    const lens = new THREE.CircleGeometry(0.11, 20).rotateY(Math.PI).translate(0, 0, -0.145);

    const heads = [];
    const R2 = CITY.ROAD / 2;
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    for (let i = 0; i <= CITY.N; i++) for (let j = 0; j <= CITY.N; j++) {
      const cx = roadPos(i), cz = roadPos(j);
      for (const [fx, fz] of dirs) {
        // approach exists if a road segment leads into the intersection from -f
        const ii = i - fx, jj = j - fz;
        if (fx !== 0 && (ii < 0 || ii > CITY.N)) continue;
        if (fz !== 0 && (jj < 0 || jj > CITY.N)) continue;
        // right vector of travel direction f: f x up = (-fz, 0, fx)
        const rx = -fz, rz = fx;
        const px = cx + fx * (R2 + 1.6) + rx * (R2 + 1.6), pz = cz + fz * (R2 + 1.6) + rz * (R2 + 1.6);
        const yaw = Math.atan2(fx, fz);
        heads.push({ px, pz, yaw, ns: fz !== 0, cross: fz !== 0 ? STREETS[j] : AVENUES[i] });
      }
    }
    const n = heads.length;
    const poles = new THREE.InstancedMesh(poleGeo, paintM, n);
    const hous = new THREE.InstancedMesh(housingGeo, housingM, n * 2);
    const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), toneMapped: true });
    this.lenses = [0, 1, 2].map(() => new THREE.InstancedMesh(lens, lensMat, n * 2));
    this.signalHeads = heads;

    // street-name sign atlas
    const names = [...AVENUES, ...STREETS];
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 64 * names.length;
    const g = cv.getContext('2d');
    names.forEach((nm, k) => {
      g.fillStyle = '#0d6b3a'; g.fillRect(0, k * 64, 1024, 64);
      g.strokeStyle = '#e8efe9'; g.lineWidth = 4; g.strokeRect(6, k * 64 + 6, 1012, 52);
      g.fillStyle = '#f4f7f4'; g.font = 'bold 42px "Highway Gothic", "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(nm, 512, k * 64 + 34);
    });
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const signGeos = [];

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
    const tmp = new THREE.Matrix4();
    heads.forEach((h, k) => {
      q.setFromEuler(e.set(0, h.yaw, 0));
      const base = new THREE.Matrix4().compose(new THREE.Vector3(h.px, CITY.CURB, h.pz), q, one);
      poles.setMatrixAt(k, base);
      this.staticBox(h.px, 3, h.pz, 0.18, 3, 0.18);
      [4.4, 1.0].forEach((ax, s) => {
        // first head hangs over the lanes, second mounted on the pole
        const local = new THREE.Matrix4().makeTranslation(ax, s === 0 ? 5.35 : 3.4, s === 0 ? 0 : -0.25);
        tmp.multiplyMatrices(base, local);
        hous.setMatrixAt(k * 2 + s, tmp);
        [0.34, 0, -0.34].forEach((y, c) => {
          const lm = new THREE.Matrix4().multiplyMatrices(tmp, new THREE.Matrix4().makeTranslation(0, y + 0.06, 0));
          this.lenses[c].setMatrixAt(k * 2 + s, lm);
        });
      });
      const idx = names.indexOf(h.cross);
      const sg = new THREE.PlaneGeometry(2.4, 0.42);
      const uv = sg.attributes.uv;
      const v0 = 1 - (idx + 1) / names.length, v1 = 1 - idx / names.length;
      for (let t = 0; t < uv.count; t++) uv.setY(t, uv.getY(t) > 0.5 ? v1 : v0);
      sg.rotateY(Math.PI).translate(2.2, 6.55, 0);
      const back = new THREE.PlaneGeometry(2.4, 0.42).translate(2.2, 6.55, 0.004); // reverse side reads mirrored-free too
      for (let t = 0; t < back.attributes.uv.count; t++) back.attributes.uv.setY(t, back.attributes.uv.getY(t) > 0.5 ? v1 : v0);
      signGeos.push(sg.applyMatrix4(base), back.applyMatrix4(base));
    });
    poles.castShadow = hous.castShadow = true;
    this.group.add(poles, hous, ...this.lenses);
    const signs = new THREE.Mesh(mergeGeometries(signGeos), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.1 }));
    signs.castShadow = true;
    this.group.add(signs);
    this.updateSignals(0);
  }

  updateSignals(dt) {
    this.signalTimer += dt;
    const cycle = 32, t = this.signalTimer % cycle;
    // 0-13 NS green, 13-16 NS yellow, 16-29 EW green, 29-32 EW yellow
    const state = ns => {
      const tt = ns ? t : (t + 16) % cycle;
      return tt < 13 ? 2 : tt < 16 ? 1 : 0; // 2 green, 1 yellow, 0 red
    };
    const ON = [new THREE.Color(1.0, 0.08, 0.04), new THREE.Color(1.0, 0.55, 0.02), new THREE.Color(0.1, 1.0, 0.45)];
    const OFF = [new THREE.Color(0.06, 0.01, 0.01), new THREE.Color(0.06, 0.04, 0.0), new THREE.Color(0.0, 0.05, 0.03)];
    if (this._lastSig === `${state(true)}${state(false)}`) return;
    this._lastSig = `${state(true)}${state(false)}`;
    this.signalHeads.forEach((h, k) => {
      const s = state(h.ns);
      for (let c = 0; c < 3; c++) {
        const lit = (c === 0 && s === 0) || (c === 1 && s === 1) || (c === 2 && s === 2);
        this.lenses[c].setColorAt(k * 2, lit ? ON[c] : OFF[c]);
        this.lenses[c].setColorAt(k * 2 + 1, lit ? ON[c] : OFF[c]);
      }
    });
    for (const l of this.lenses) l.instanceColor.needsUpdate = true;
  }

  // ---------------- props: traffic cones, parked cars ----------------
  async buildProps() {
    const loader = new GLTFLoader();
    try {
      const cone = await loader.loadAsync(asset('assets/models/traffic_cone.glb'));
      // the sample scene contains two cones + a ground plane: keep one cone
      let src = null;
      cone.scene.traverse(o => { if (!src && o.isMesh && /cone normal/i.test(o.name)) src = o; });
      if (!src) cone.scene.traverse(o => { if (!src && o.isMesh && /cone/i.test(o.name)) src = o; });
      const geo = src.geometry.clone();
      geo.computeBoundingBox();
      let sz = geo.boundingBox.getSize(new THREE.Vector3());
      if (sz.z > sz.y * 1.2) geo.rotateX(-Math.PI / 2); // asset is authored Z-up
      geo.computeBoundingBox();
      sz = geo.boundingBox.getSize(new THREE.Vector3());
      const scale = 0.72 / sz.y;
      const bb = geo.boundingBox;
      geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      geo.scale(scale, scale, scale);
      const mat = src.material;
      // construction zone closing the outer north-bound lane on Kingsley Ave
      const x = roadPos(3) - 5.2;
      const places = [];
      for (let k = 0; k < 9; k++) places.push([x + Math.min(k, 4) * 0.2, roadPos(1) + 20 + k * 4.5]);
      // slalom on 3rd St east of Central Ave
      for (let k = 0; k < 8; k++) places.push([roadPos(2) + 22 + k * 7, roadPos(2) + 1.75]);
      for (const [px, pz] of places) {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true; m.receiveShadow = true;
        this.group.add(m);
        const b = new CANNON.Body({ mass: 4, material: this.physics.matWorld, linearDamping: 0.3, angularDamping: 0.4 });
        b.addShape(new CANNON.Box(new CANNON.Vec3(0.2, 0.36, 0.2)), new CANNON.Vec3(0, 0.36, 0));
        b.position.set(px, 0.01, pz);
        b.allowSleep = true; b.sleepSpeedLimit = 0.2;
        this.physics.world.addBody(b);
        this.dynamic.push({ mesh: m, body: b, yOff: 0 });
      }
    } catch (e) { console.warn('cone load failed', e); }
  }

  // Parked cars use clones of the player car model in other paint variants (set up by car.js)
  addParkedCars(makeClone) {
    const spots = [
      [roadPos(1) + 5.3, roadPos(2) + 25, Math.PI], [roadPos(1) + 5.3, roadPos(2) + 33, Math.PI],
      [roadPos(1) - 5.3, roadPos(1) + 40, 0], [roadPos(3) + 5.3, roadPos(3) + 18, Math.PI],
      [roadPos(1) + 30, roadPos(3) - 5.3, Math.PI / 2], [roadPos(2) + 52, roadPos(1) + 5.3, -Math.PI / 2],
    ];
    spots.forEach(([x, z, yaw], k) => {
      const obj = makeClone(k);
      obj.position.set(x, 0, z); obj.rotation.y = yaw;
      this.group.add(obj);
      const b = new CANNON.Body({ mass: 1400, material: this.physics.matWorld, linearDamping: 0.6, angularDamping: 0.8 });
      b.addShape(new CANNON.Box(new CANNON.Vec3(0.98, 0.42, 2.2)), new CANNON.Vec3(0, 0.62, 0.2));
      b.position.set(x, 0, z);
      b.quaternion.setFromEuler(0, yaw, 0);
      b.allowSleep = true; b.sleepSpeedLimit = 0.1; b.sleepTimeLimit = 0.5;
      this.physics.world.addBody(b);
      this.dynamic.push({ mesh: obj, body: b, yOff: 0 });
    });
  }

  // Optional: drop a Poly Haven tree glTF into assets/models/optional/tree.glb (see README)
  async tryOptionalTrees() {
    try {
      if (!(await optionalAssets()).tree) return;
      const gltf = await new GLTFLoader().loadAsync('assets/models/optional/tree.glb');
      const root = gltf.scene; root.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(root), h = bb.max.y - bb.min.y;
      const s = 9 / h;
      const spots = [];
      const R2 = CITY.ROAD / 2;
      for (const ax of ['z', 'x']) for (let i = 0; i <= CITY.N; i++) for (let j = 0; j < CITY.N; j++) {
        const a = roadPos(j) + R2 + 20, b = roadPos(j + 1) - R2 - 20;
        for (const t of [a, b]) for (const side of [-1, 1]) {
          const off = roadPos(i) + side * (R2 + 2.2);
          spots.push(ax === 'z' ? [off, t] : [t, off]);
        }
      }
      if (this.parkLot) {
        const L = this.parkLot, rr = rng(9);
        for (let k = 0; k < 18; k++) spots.push([L.x0 + 10 + rr() * 50, L.z0 + 10 + rr() * 50]);
      }
      const meshes = [];
      root.traverse(o => { if (o.isMesh) meshes.push(o); });
      for (const src of meshes) {
        const inst = new THREE.InstancedMesh(src.geometry, src.material, spots.length);
        spots.forEach(([x, z], k) => {
          const m = new THREE.Matrix4().compose(new THREE.Vector3(x, CITY.CURB - bb.min.y * s, z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, k * 2.4, 0)), new THREE.Vector3(s, s, s));
          inst.setMatrixAt(k, m.multiply(src.matrixWorld));
        });
        inst.castShadow = true; inst.receiveShadow = true;
        this.group.add(inst);
      }
      spots.forEach(([x, z]) => this.staticBox(x, 2, z, 0.25, 2, 0.25));
      console.log('[world] optional trees loaded:', spots.length);
    } catch (e) { console.warn('optional trees not loaded', e); }
  }

  setNight(on) {
    for (const m of this.windowMats) m.emissiveIntensity = on ? 0.9 : 0;
    this.lampLensMat.emissiveIntensity = on ? 6 : 0.05;
  }

  nearestLamps(pos, count) {
    return this.streetLampPositions
      .map(p => [p, (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2])
      .sort((a, b) => a[1] - b[1]).slice(0, count).map(a => a[0]);
  }

  update(dt) {
    this.updateSignals(dt);
    for (const d of this.dynamic) {
      if (d.body.sleepState === CANNON.Body.SLEEPING) continue;
      d.mesh.position.copy(d.body.position);
      d.mesh.quaternion.copy(d.body.quaternion);
    }
  }
}
