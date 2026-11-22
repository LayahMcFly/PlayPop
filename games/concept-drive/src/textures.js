// Procedural PBR texture generator (tileable) + optional overrides from downloaded
// Poly Haven / ambientCG texture sets (see README "Optional higher-res textures").
import * as THREE from 'three';

// ---------- tileable value noise ----------
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

class TileNoise {
  constructor(seed = 1) {
    const r = makeRng(seed);
    this.p = new Float32Array(256 * 256);
    for (let i = 0; i < this.p.length; i++) this.p[i] = r();
  }
  // periodic value noise, period in lattice cells
  v(x, y, period) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const P = this.p;
    const a = P[(y0 & 255) * 256 + (x0 & 255)], b = P[(y0 & 255) * 256 + (x1 & 255)];
    const c = P[(y1 & 255) * 256 + (x0 & 255)], d = P[(y1 & 255) * 256 + (x1 & 255)];
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  }
  // fbm on unit square [0,1) -> tileable; base = lattice cells at octave 0
  fbm(u, v, base, oct = 5, gain = 0.5) {
    let sum = 0, amp = 0.5, norm = 0, p = base;
    for (let o = 0; o < oct; o++) {
      sum += amp * this.v(u * p, v * p, p);
      norm += amp; amp *= gain; p *= 2;
    }
    return sum / norm;
  }
}

function canvasTex(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finalize(canvas, { srgb = false, repeat = [1, 1], aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// Build albedo / normal / ORM(roughness in G, metalness in B) canvases from a per-pixel fn.
function buildSet(size, fn, normalStrength = 2) {
  const n = size * size;
  const H = new Float32Array(n);
  const ca = canvasTex(size, size), cr = canvasTex(size, size), cn = canvasTex(size, size);
  const ia = ca.getContext('2d').createImageData(size, size);
  const ir = cr.getContext('2d').createImageData(size, size);
  const inn = cn.getContext('2d').createImageData(size, size);
  const out = { r: 0, g: 0, b: 0, h: 0, rough: 0.8, metal: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x / size, y / size, out, x, y);
      const i = y * size + x, j = i * 4;
      ia.data[j] = Math.max(0, Math.min(255, out.r * 255));
      ia.data[j + 1] = Math.max(0, Math.min(255, out.g * 255));
      ia.data[j + 2] = Math.max(0, Math.min(255, out.b * 255));
      ia.data[j + 3] = 255;
      ir.data[j] = 255;
      ir.data[j + 1] = Math.max(0, Math.min(255, out.rough * 255));
      ir.data[j + 2] = Math.max(0, Math.min(255, out.metal * 255));
      ir.data[j + 3] = 255;
      H[i] = out.h;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = H[y * size + ((x - 1 + size) % size)], r = H[y * size + ((x + 1) % size)];
      const u = H[((y - 1 + size) % size) * size + x], d = H[((y + 1) % size) * size + x];
      let nx = (l - r) * normalStrength, ny = (d - u) * normalStrength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const j = (y * size + x) * 4;
      inn.data[j] = (nx / len * 0.5 + 0.5) * 255;
      inn.data[j + 1] = (ny / len * 0.5 + 0.5) * 255;
      inn.data[j + 2] = (nz / len * 0.5 + 0.5) * 255;
      inn.data[j + 3] = 255;
    }
  }
  ca.getContext('2d').putImageData(ia, 0, 0);
  cr.getContext('2d').putImageData(ir, 0, 0);
  cn.getContext('2d').putImageData(inn, 0, 0);
  return { albedo: ca, orm: cr, normal: cn };
}

function toTextures(set, repeat = [1, 1]) {
  return {
    map: finalize(set.albedo, { srgb: true, repeat }),
    roughnessMap: finalize(set.orm, { repeat }),
    normalMap: finalize(set.normal, { repeat }),
  };
}

// ---------- individual materials ----------
export function asphaltSet(size = 1024) {
  const N = new TileNoise(7), M = new TileNoise(19), K = new TileNoise(41);
  return buildSet(size, (u, v, o) => {
    const low = N.fbm(u, v, 3, 4);
    const mid = N.fbm(u, v, 24, 3);
    const grain = M.v(u * 512, v * 512, 512);
    const grain2 = M.v(u * 256 + 3.1, v * 256 + 7.7, 256);
    const fine = K.v(u * 1024, v * 1024, 1024);
    const stone = grain > 0.8 ? (grain - 0.8) * 4 : 0;
    const crackN = N.fbm(u + 0.3, v + 0.1, 4, 5);
    const crack = Math.abs(crackN - 0.5) < 0.0035 && low > 0.55 ? 1 : 0;
    let base = 0.075 + low * 0.035 + (mid - 0.5) * 0.025 + stone * 0.16 + (grain2 - 0.5) * 0.025 + (fine - 0.5) * 0.02;
    base *= crack ? 0.5 : 1;
    o.r = base; o.g = base * 1.005; o.b = base * 1.03;
    o.h = grain * 0.35 + stone * 0.6 + fine * 0.25 - crack * 0.5;
    o.rough = 0.9 - stone * 0.25 + (low - 0.5) * 0.12;
    o.metal = 0;
  }, 1.4);
}

export function concreteSet(size = 1024, { joints = 2, tint = [0.58, 0.57, 0.55], seed = 3 } = {}) {
  const N = new TileNoise(seed);
  return buildSet(size, (u, v, o) => {
    const low = N.fbm(u, v, 3, 4);
    const fine = N.fbm(u, v, 128, 2);
    const ju = (u * joints) % 1, jv = (v * joints) % 1;
    const j = (ju < 0.006 || ju > 0.994 || jv < 0.006 || jv > 0.994) ? 1 : 0;
    const stain = Math.max(0, N.fbm(u + 0.5, v + 0.2, 5, 4) - 0.58) * 1.6;
    const k = (0.82 + low * 0.25 + (fine - 0.5) * 0.12 - stain * 0.35) * (j ? 0.55 : 1);
    o.r = tint[0] * k; o.g = tint[1] * k; o.b = tint[2] * k;
    o.h = fine * 0.4 - j * 1.0;
    o.rough = 0.88 + (fine - 0.5) * 0.1 - stain * 0.1;
    o.metal = 0;
  }, 2.5);
}

export function grassSet(size = 1024) {
  const N = new TileNoise(11), M = new TileNoise(23);
  return buildSet(size, (u, v, o) => {
    const low = N.fbm(u, v, 4, 4);
    const blades = M.fbm(u, v, 256, 2);
    const dry = Math.max(0, N.fbm(u + 0.7, v, 6, 3) - 0.55) * 2;
    const k = 0.55 + blades * 0.6;
    o.r = (0.10 + dry * 0.18) * k; o.g = (0.20 + low * 0.08 + dry * 0.08) * k; o.b = 0.05 * k;
    o.h = blades;
    o.rough = 0.92; o.metal = 0;
  }, 4);
}

export function roofSet(size = 512) {
  const N = new TileNoise(31);
  return buildSet(size, (u, v, o) => {
    const g = N.fbm(u, v, 64, 3), low = N.fbm(u, v, 4, 3);
    const k = 0.22 + g * 0.12 + low * 0.08;
    o.r = k; o.g = k; o.b = k * 1.02;
    o.h = g; o.rough = 0.95; o.metal = 0;
  }, 2);
}

// Building facade: tile covers `bays` window bays x `floors` floors.
// style: 'glass' | 'brick' | 'stone' | 'panel' | 'store'
export function facadeSet(style, size = 1024, seed = 5) {
  const N = new TileNoise(seed), R = makeRng(seed * 13);
  const bays = 4, floors = 4;
  const lit = []; // emissive per window
  for (let i = 0; i < bays * floors; i++) lit.push(R() < 0.35 ? 0.4 + R() * 0.6 : 0);
  const tint = { glass: [0.55, 0.57, 0.6], brick: [0.45, 0.2, 0.14], stone: [0.72, 0.66, 0.56], panel: [0.82, 0.82, 0.8], store: [0.2, 0.2, 0.21] }[style];
  const win = {
    glass: [0.04, 0.04, 0.96, 0.9],
    brick: [0.25, 0.2, 0.75, 0.78],
    stone: [0.2, 0.22, 0.8, 0.8],
    panel: [0.08, 0.3, 0.92, 0.78],
    store: [0.03, 0.02, 0.97, 0.82],
  }[style];
  const emis = canvasTex(size, size);
  const ie = emis.getContext('2d').createImageData(size, size);
  const set = buildSet(size, (u, v, o, px, py) => {
    // v from canvas top -> flip so floor 0 at bottom of texture
    const fu = (u * bays), fv = ((1 - v) * floors);
    const bu = fu % 1, bv = fv % 1;
    const bay = Math.floor(fu), fl = Math.floor(fv);
    const inWin = bu > win[0] && bu < win[2] && bv > win[1] && bv < win[3];
    const frame = inWin && (bu < win[0] + 0.02 || bu > win[2] - 0.02 || bv < win[1] + 0.02 || bv > win[3] - 0.02);
    const mullion = inWin && style !== 'brick' && Math.abs(bu - 0.5) < 0.008;
    const fine = N.fbm(u, v, 128, 2), low = N.fbm(u, v, 4, 3);
    const j = (py * size + px) * 4;
    let e = 0;
    if (inWin && !frame && !mullion) {
      // glass: reflective, slight interior variation
      const g = 0.03 + low * 0.03;
      o.r = g; o.g = g * 1.1; o.b = g * 1.25;
      o.h = -0.6; o.rough = (style === 'store' ? 0.16 : 0.05) + fine * 0.04 + low * 0.05; o.metal = style === 'store' ? 0.3 : 0.8;
      const lt = lit[(fl % floors) * bays + (bay % bays)];
      e = lt * (0.75 + 0.25 * Math.sin(bu * 9 + bay));
    } else if (frame || mullion) {
      const c = style === 'glass' ? 0.12 : 0.18;
      o.r = c; o.g = c; o.b = c * 1.05; o.h = -0.2; o.rough = 0.45; o.metal = style === 'store' ? 0.5 : 0.8;
    } else {
      let k = 0.75 + low * 0.3 + (fine - 0.5) * 0.15;
      let h = fine * 0.3;
      if (style === 'brick') {
        const rows = 40, cols = 16;
        const ry = (1 - v) * rows * floors / 4;
        const rx = u * cols + (Math.floor(ry) % 2) * 0.5;
        const mortar = (ry % 1) < 0.12 || (rx % 1) < 0.05;
        const bk = N.v(Math.floor(rx) * 3.1, Math.floor(ry) * 1.7, 256);
        k *= mortar ? 1.6 : 0.8 + bk * 0.4;
        h = mortar ? -0.6 : 0.2 + fine * 0.2;
        if (mortar) { o.r = 0.5 * k * 0.5; o.g = 0.48 * k * 0.5; o.b = 0.45 * k * 0.5; }
      }
      // horizontal floor band / sill
      if (bv < 0.06 && style !== 'glass') { k *= 0.85; h = 0.5; }
      if (!(style === 'brick' && ((((1 - v) * 40 * floors / 4) % 1) < 0.12))) {
        o.r = tint[0] * k; o.g = tint[1] * k; o.b = tint[2] * k;
      }
      o.h = h; o.rough = style === 'panel' ? 0.45 : 0.85; o.metal = 0;
      if (style === 'glass') { o.r *= 0.35; o.g *= 0.35; o.b *= 0.38; o.rough = 0.3; o.metal = 0.9; }
      // reveal shadow around punched windows (fake depth)
      if (style !== 'glass' && style !== 'store') {
        const dx = Math.max(win[0] - bu, bu - win[2], 0), dy = Math.max(win[1] - bv, bv - win[3], 0);
        const near = bu > win[0] - 0.03 && bu < win[2] + 0.03 && bv > win[1] - 0.03 && bv < win[3] + 0.03;
        if (near) { const k2 = 0.55 + Math.min(1, (dx + dy) * 30) * 0.45; o.r *= k2; o.g *= k2; o.b *= k2; o.h += 0.3; }
        if (bv < win[1] && bv > win[1] - 0.05 && bu > win[0] - 0.03 && bu < win[2] + 0.03) { o.h = 0.9; o.r *= 1.15; o.g *= 1.15; o.b *= 1.15; } // sill
      }
    }
    ie.data[j] = 255 * e; ie.data[j + 1] = 200 * e; ie.data[j + 2] = 140 * e; ie.data[j + 3] = 255;
  }, 3);
  emis.getContext('2d').putImageData(ie, 0, 0);
  return { ...set, emissive: emis, bays, floors };
}

const cache = new Map();
// phones/tablets get half-resolution generated textures (less memory, faster start)
let TEX_SCALE = 1;
export function setTextureScale(s) { TEX_SCALE = s; }
const S = n => Math.max(256, Math.round(n * TEX_SCALE));

// assets/optional.json lists which optional downloads are present, e.g. {"textures":["asphalt"],"tree":true}
let optional = null;
export async function optionalAssets() {
  if (optional) return optional;
  optional = {};
  if (location.protocol === 'file:') return optional;
  try { const r = await fetch('assets/optional.json'); if (r.ok) optional = await r.json(); } catch {}
  return optional;
}
const optionalList = async () => (await optionalAssets()).textures || [];

// Try to load an override texture set from assets/textures/<name>/ (color.jpg, normal.jpg, roughness.jpg)
async function tryOverride(name, repeat) {
  const base = `assets/textures/${name}/`;
  try {
    if (!(await optionalList()).includes(name)) return null;
    const L = new THREE.TextureLoader();
    const load = (f, srgb) => L.loadAsync(base + f).then(t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.anisotropy = 8;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t;
    }).catch(() => null);
    const [map, normalMap, roughnessMap] = await Promise.all([load('color.jpg', true), load('normal.jpg'), load('roughness.jpg')]);
    console.log('[textures] using downloaded override for', name);
    return { map, normalMap, roughnessMap, override: true };
  } catch { return null; }
}

export async function getMaterialTextures(name, repeat = [1, 1]) {
  const key = name + repeat.join('x');
  if (cache.has(key)) return cache.get(key);
  let tex = await tryOverride(name, repeat);
  if (!tex) {
    const gen = { asphalt: () => asphaltSet(S(1024)), sidewalk: () => concreteSet(S(1024), { joints: 2 }),
      curb: () => concreteSet(S(512), { joints: 1, tint: [0.62, 0.61, 0.6], seed: 9 }),
      grass: () => grassSet(S(1024)), roof: () => roofSet(S(512)) }[name];
    tex = toTextures(gen(), repeat);
  }
  cache.set(key, tex);
  return tex;
}

export function getFacadeTextures(style, seed) {
  const s = facadeSet(style, S(1024), seed);
  const t = toTextures(s);
  t.emissiveMap = finalize(s.emissive, { srgb: true });
  t.metalnessMap = t.roughnessMap;
  t.bays = s.bays; t.floors = s.floors;
  return t;
}
