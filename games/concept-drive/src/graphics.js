// Renderer, HDRI environment, physical sky, sun + shadows, post-processing.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export const QUALITY = {
  low:    { pixelRatio: 0.75, shadowMap: 1024, ao: false, bloom: true,  smaa: false, mirrorEvery: 3 },
  medium: { pixelRatio: 1.0,  shadowMap: 2048, ao: false, bloom: true,  smaa: true,  mirrorEvery: 2 },
  high:   { pixelRatio: 1.0,  shadowMap: 4096, ao: true,  bloom: true,  smaa: true,  mirrorEvery: 1 },
  ultra:  { pixelRatio: 1.5,  shadowMap: 4096, ao: true,  bloom: true,  smaa: true,  mirrorEvery: 1 },
};

export class Graphics {
  constructor(container) {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 3000);

    // physical sky (background) — sun position shared with the directional light
    const sky = this.sky = new Sky();
    sky.scale.setScalar(4500);
    const u = sky.material.uniforms;
    u.turbidity.value = 4; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    this.scene.add(sky);

    this.sun = new THREE.DirectionalLight(0xfff6ec, 2.8);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a3328, 0.25);
    this.scene.add(this.hemi);

    this.sunDir = new THREE.Vector3();
    this.setSun(50, 150);

    this.scene.fog = new THREE.FogExp2(0xbfcad6, 0.0016);
    this.night = false;
    this.nightListeners = [];
    this.resizeListeners = [];
    addEventListener('resize', () => this.resize());
  }

  setSun(elevationDeg, azimuthDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
  }

  async loadEnvironment(url, onProgress) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const hdr = await new HDRLoader().loadAsync(url, onProgress);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    this.envDay = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    // night: environment from a dark sky render
    this.scene.environment = this.envDay;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
  }

  setupPost(quality = 'high') {
    const r = this.renderer;
    const q = this.q = QUALITY[quality];
    this.qualityName = quality;
    r.setPixelRatio(Math.min(devicePixelRatio, 2) * q.pixelRatio);
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }

    if (this.composer) this.composer.dispose();
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.smaa ? 0 : 4 });
    const c = this.composer = new EffectComposer(r, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (q.ao) {
      const ao = this.ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.9;
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 12 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      c.addPass(ao);
    } else this.ao = null;
    if (q.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.14, 0.4, 1.2);
      c.addPass(this.bloom);
    }
    c.addPass(new OutputPass());
    if (q.smaa) c.addPass(new SMAAPass());
    this.applyNight(this.night);
  }

  setNight(on) { this.night = on; this.applyNight(on); }

  applyNight(on) {
    const u = this.sky.material.uniforms;
    if (on) {
      this.setSun(-8, 150);
      this.sun.intensity = 0.0;
      this.sun.castShadow = false;
      this.hemi.intensity = 0.06;
      this.scene.environmentIntensity = 0.06;
      this.renderer.toneMappingExposure = 1.0;
      this.scene.fog.color.set(0x0b0f17);
      u.rayleigh.value = 0.4;
      if (this.bloom) { this.bloom.strength = 0.55; this.bloom.threshold = 0.85; this.bloom.radius = 0.5; }
    } else {
      this.setSun(50, 150);
      this.sun.intensity = 2.8;
      this.sun.castShadow = true;
      this.hemi.intensity = 0.25;
      this.scene.environmentIntensity = 0.85;
      this.renderer.toneMappingExposure = 0.95;
      this.scene.fog.color.set(0xbfcad6);
      u.rayleigh.value = 1.4;
      if (this.bloom) { this.bloom.strength = 0.14; this.bloom.threshold = 1.2; this.bloom.radius = 0.4; }
    }
    for (const f of this.nightListeners) f(on);
  }

  // keep the shadow frustum centred on the player
  followShadow(target) {
    const d = this.sunDir;
    const snap = 2;
    const tx = Math.round(target.x / snap) * snap, tz = Math.round(target.z / snap) * snap;
    this.sun.target.position.set(tx, 0, tz);
    this.sun.position.set(tx + d.x * 150, d.y * 150, tz + d.z * 150);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.composer) {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.composer.setSize(innerWidth, innerHeight);
      if (this.ao) this.ao.setSize(s.x, s.y);
    }
    for (const f of this.resizeListeners) f();
  }

  render() { this.composer.render(); }
}
