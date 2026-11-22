// Tiny geometry accumulator so thousands of quads become a handful of draw calls.
import * as THREE from 'three';

export class GeoBuilder {
  constructor(withColor = false) {
    this.p = []; this.n = []; this.uv = []; this.idx = []; this.c = withColor ? [] : null;
  }
  // quad from 4 corners (counter-clockwise when viewed from the front), uv rect
  quad(a, b, c, d, nrm, uv = [0, 0, 1, 1], color = null) {
    const base = this.p.length / 3;
    for (const v of [a, b, c, d]) this.p.push(v[0], v[1], v[2]);
    for (let i = 0; i < 4; i++) this.n.push(nrm[0], nrm[1], nrm[2]);
    const [u0, v0, u1, v1] = uv;
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    if (this.c) for (let i = 0; i < 4; i++) this.c.push(color[0], color[1], color[2]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // horizontal rectangle facing up at height y
  top(x0, z0, x1, z1, y, tile = 1, color = null, uvOrigin = [0, 0]) {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0],
      [(x0 - uvOrigin[0]) / tile, -(z1 - uvOrigin[1]) / tile, (x1 - uvOrigin[0]) / tile, -(z0 - uvOrigin[1]) / tile], color);
  }
  // 4 vertical walls of an axis-aligned box, UVs in world units / tile size
  walls(x0, z0, x1, z1, y0, y1, tileU = 1, tileV = 1, vOffset = 0) {
    const h0 = (y0 - vOffset) / tileV, h1 = (y1 - vOffset) / tileV;
    const w = (x1 - x0) / tileU, d = (z1 - z0) / tileU;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [0, h0, w, h1]); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [0, h0, w, h1]); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [0, h0, d, h1]); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [0, h0, d, h1]); // -x
  }
  box(x0, y0, z0, x1, y1, z1, tile = 1) {
    this.walls(x0, z0, x1, z1, y0, y1, tile, tile);
    this.top(x0, z0, x1, z1, y1, tile);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
  get empty() { return this.idx.length === 0; }
}
