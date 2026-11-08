// Three.js renderer for compiled fold steps.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraSpec, CompiledModel, Phase, PhaseFace } from '../engine/types';
import { stateBefore } from '../engine/svg';

type V2 = [number, number];
const apply = (m: number[], p: V2): V2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const det = (m: number[]) => m[0] * m[3] - m[1] * m[2];
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface Colors { [sheet: string]: { front: string; back: string } }

interface FaceGeom { face: PhaseFace; pts: V2[]; }

/** A static or animated arrangement of faces, one mesh pair per sheet. */
class PhaseView {
  group = new THREE.Group();
  faces: FaceGeom[];
  meshes = new Map<string, { front: THREE.Mesh; back: THREE.Mesh; geo: THREE.BufferGeometry; list: FaceGeom[] }>();
  edges: THREE.LineSegments;
  overlay = new THREE.Group();
  zPivot = 0;
  chainCache: THREE.Matrix4[] = [];

  constructor(public phase: Phase, public thick: number, colors: Colors, sheets: CompiledModel['sheets']) {
    this.faces = phase.faces.map((face) => {
      const pts: V2[] = [];
      for (let i = 0; i < face.p.length; i += 2) pts.push([face.p[i], face.p[i + 1]]);
      return { face, pts };
    });
    const bySheet = new Map<string, FaceGeom[]>();
    for (const f of this.faces) bySheet.set(f.face.s, [...(bySheet.get(f.face.s) ?? []), f]);
    for (const [sheet, list] of bySheet) {
      const tris = list.reduce((n, f) => n + (f.pts.length - 2), 0);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
      const c = colors[sheet] ?? { front: sheets.find((s) => s.id === sheet)?.front ?? '#e8642c', back: '#fbf7ee' };
      const mk = (color: string, side: THREE.Side) => new THREE.MeshLambertMaterial({
        color, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const front = new THREE.Mesh(geo, mk(c.front, THREE.FrontSide));
      const back = new THREE.Mesh(geo, mk(c.back, THREE.BackSide));
      this.group.add(front, back);
      this.meshes.set(sheet, { front, back, geo, list });
    }
    const edgeCount = this.faces.reduce((n, f) => n + f.pts.length, 0);
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeCount * 6), 3));
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
    this.group.add(this.edges, this.overlay);
    const moving = this.faces.filter((f) => f.face.d !== 0);
    this.zPivot = moving.length ? (moving.reduce((s, f) => s + f.face.la, 0) / moving.length) * thick : 0;
  }

  setColors(colors: Colors) {
    for (const [sheet, m] of this.meshes) {
      const c = colors[sheet];
      if (!c) continue;
      (m.front.material as THREE.MeshLambertMaterial).color.set(c.front);
      (m.back.material as THREE.MeshLambertMaterial).color.set(c.back);
    }
  }

  /** Paper-world position (x, y, z) of a paper point of a face at time t. */
  pose(fg: FaceGeom, t: number): (p: V2) => THREE.Vector3 {
    const f = fg.face, ph = this.phase, e = ease(t), T = this.thick;
    const za = f.la * T, zb = f.lb * T;
    const lin = (p: V2) => {
      const a = apply(f.a, p), b = apply(f.b, p);
      return new THREE.Vector3(a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, za + (zb - za) * e);
    };
    if (ph.motion === 'none' || ph.motion === 'move' || (f.d === 0 && ph.motion !== 'spin' && ph.motion !== 'chain')) return lin;
    if (ph.motion === 'spin') {
      const c = ph.center!, ang = ((ph.angle ?? 0) * Math.PI) / 180 * e;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      return (p) => {
        const a = apply(f.a, p);
        const x = a[0] - c[0], y = a[1] - c[1];
        return new THREE.Vector3(c[0] + cs * x - sn * y, c[1] + sn * x + cs * y, za + (zb - za) * e);
      };
    }
    if (ph.motion === 'chain') {
      const M = this.chainCache[this.faces.indexOf(fg)];
      return (p) => {
        const v = new THREE.Vector3(p[0], p[1], 0).applyMatrix4(M);
        v.z += za + (zb - za) * e;
        return v;
      };
    }
    // Hinge (fold, crease, turn over): rotate about the axis, then settle into place.
    const [P, Q] = ph.axis!;
    const ux = Q[0] - P[0], uy = Q[1] - P[1], ul = Math.hypot(ux, uy);
    const axis = new THREE.Vector3(ux / ul, uy / ul, 0);
    const pivot = new THREE.Vector3(P[0], P[1], this.zPivot);
    const crease = ph.motion === 'crease';
    const theta = crease ? Math.PI * 0.85 * Math.sin(Math.PI * t) * f.d : Math.PI * e * f.d;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, theta);
    const qEnd = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI * f.d);
    return (p) => {
      const a = apply(f.a, p);
      const start = new THREE.Vector3(a[0], a[1], za).sub(pivot);
      const rot = start.clone().applyQuaternion(q).add(pivot);
      if (crease) return rot;
      const rotEnd = start.clone().applyQuaternion(qEnd).add(pivot);
      const b = apply(f.b, p);
      const target = new THREE.Vector3(b[0], b[1], zb);
      return rot.add(target.sub(rotEnd).multiplyScalar(e));
    };
  }

  prepareChain(t: number) {
    const e = ease(t);
    const n = this.faces.length;
    const done: (THREE.Matrix4 | null)[] = new Array(n).fill(null);
    const lift = (m: number[]) => new THREE.Matrix4().set(m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, det(m) > 0 ? 1 : -1, 0, 0, 0, 0, 1);
    const local = (i: number): THREE.Matrix4 => {
      if (done[i]) return done[i]!;
      const f = this.faces[i].face;
      let M = new THREE.Matrix4();
      if (f.parent !== undefined && f.parent >= 0 && f.parent !== i) {
        M = local(f.parent).clone();
        if (f.hinge) {
          const [x0, y0, x1, y1] = f.hinge;
          const ax = new THREE.Vector3(x1 - x0, y1 - y0, 0).normalize();
          const R = new THREE.Matrix4().makeRotationAxis(ax, (f.ang ?? 0) * e);
          const T1 = new THREE.Matrix4().makeTranslation(x0, y0, 0), T2 = new THREE.Matrix4().makeTranslation(-x0, -y0, 0);
          M.multiply(T1).multiply(R).multiply(T2);
        }
      }
      done[i] = M;
      return M;
    };
    this.chainCache = this.faces.map((fg, i) => (fg.face.parent === undefined ? lift(fg.face.a) : lift(fg.face.a).multiply(local(i))));
  }

  update(t: number) {
    if (this.phase.motion === 'chain') this.prepareChain(t);
    for (const m of this.meshes.values()) {
      const arr = m.geo.attributes.position.array as Float32Array;
      let k = 0;
      for (const fg of m.list) {
        const P = this.pose(fg, t);
        const v = fg.pts.map((p) => toThree(P(p)));
        for (let i = 1; i < v.length - 1; i++) {
          for (const w of [v[0], v[i], v[i + 1]]) { arr[k++] = w.x; arr[k++] = w.y; arr[k++] = w.z; }
        }
      }
      m.geo.attributes.position.needsUpdate = true;
      m.geo.computeVertexNormals();
      m.geo.computeBoundingSphere();
    }
    const ea = this.edges.geometry.attributes.position.array as Float32Array;
    let k = 0;
    for (const fg of this.faces) {
      const P = this.pose(fg, t);
      const v = fg.pts.map((p) => toThree(P(p)));
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        ea[k++] = a.x; ea[k++] = a.y; ea[k++] = a.z; ea[k++] = b.x; ea[k++] = b.y; ea[k++] = b.z;
      }
    }
    this.edges.geometry.attributes.position.needsUpdate = true;
    this.edges.geometry.computeBoundingSphere();
  }

  bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const t of [0, 1]) {
      if (this.phase.motion === 'chain') this.prepareChain(t);
      for (const fg of this.faces) {
        const P = this.pose(fg, t);
        for (const p of fg.pts) box.expandByPoint(toThree(P(p)));
      }
    }
    return box;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
  }
}

/** Paper world (x right, y up the diagram, z towards the viewer) -> three.js (y up). */
const toThree = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.z, -v.y);

const PRESET_DEFAULT: CameraSpec = { azimuth: 0, elevation: 72, zoom: 1 };

export interface ViewerOptions {
  colors: Colors;
  thumbnail?: boolean;
  background?: string | null;
  onFrame?: (t: number) => void;
}

export class FoldViewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  views: PhaseView[] = [];
  step = 0;
  /** 0..1 across all phases of the current step. */
  t = 0;
  playing = false;
  thick: number;
  colors: Colors;
  shadow: THREE.Mesh;
  private raf = 0;
  private lastTime = 0;
  private camTween: { from: THREE.Spherical; to: THREE.Spherical; tf: THREE.Vector3; tt: THREE.Vector3; t: number } | null = null;
  private resizeObs: ResizeObserver;
  private dirty = true;

  constructor(public el: HTMLElement, public model: CompiledModel, public opts: ViewerOptions) {
    this.colors = opts.colors;
    this.thick = model.extent * 0.0016;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts.thumbnail });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.controls.addEventListener('start', () => (this.camTween = null));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc4b0, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-0.4, 1, 0.6);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(0.5, -0.4, -0.6);
    this.scene.add(fill);
    this.shadow = makeShadow();
    this.scene.add(this.shadow);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(el);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  get stepCount() { return this.model.steps.length; }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    // Shift the picture up so the step card at the bottom does not cover the model.
    if (!this.opts.thumbnail) this.camera.setViewOffset(w, h, 0, Math.min(120, h * 0.11), w, h);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Show step i (0-based). i === stepCount shows the finished model. */
  showStep(i: number, { play = true, camera = true } = {}) {
    this.step = Math.max(0, Math.min(i, this.stepCount));
    for (const v of this.views) { this.scene.remove(v.group); v.dispose(); }
    this.views = [];
    const finished = this.step === this.stepCount;
    const phases = finished ? [] : this.model.steps[this.step].phases;
    if (phases.length) {
      this.views = phases.map((ph) => new PhaseView(ph, this.thick, this.colors, this.model.sheets));
    } else {
      const faces = stateBefore(this.model, finished ? this.stepCount : this.step);
      this.views = [new PhaseView({ motion: 'none', faces: faces.map((f) => ({ ...f, a: f.b, la: f.lb, d: 0 })), lines: [], arrows: [] }, this.thick, this.colors, this.model.sheets)];
    }
    this.views.forEach((v, k) => this.buildOverlay(v, k));
    this.t = 0;
    this.applyT();
    if (camera) this.bestAngle(!this.opts.thumbnail);
    this.playing = play && phases.length > 0;
    if (!play) { this.t = finished ? 1 : 0; this.applyT(); }
    this.dirty = true;
  }

  private buildOverlay(v: PhaseView, k: number) {
    if (k > 0 && !v.phase.lines.length && !v.phase.arrows.length) return;
    const topZ = (Math.max(0, ...v.phase.faces.map((f) => f.la)) + 3) * this.thick;
    const S = this.model.extent;
    const ribbon = (a: THREE.Vector3, b: THREE.Vector3, width: number, mat: THREE.Material) => {
      const len = a.distanceTo(b);
      if (len < 1e-6) return;
      const g = new THREE.PlaneGeometry(len, width);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      m.renderOrder = 10;
      v.overlay.add(m);
    };
    for (const l of v.phase.lines) {
      const valley = l.kind !== 'mountain';
      const mat = new THREE.MeshBasicMaterial({ color: valley ? 0x2f6fdb : 0xc4540a, transparent: true, depthTest: false, side: THREE.DoubleSide });
      const a = toThree(new THREE.Vector3(l.p[0], l.p[1], topZ)), b = toThree(new THREE.Vector3(l.q[0], l.q[1], topZ));
      const len = a.distanceTo(b), dir = b.clone().sub(a).normalize();
      const pattern = valley ? [0.045, 0.03] : [0.06, 0.02, 0.01, 0.02];
      const w = S * 0.007;
      let pos = 0, i = 0;
      while (pos < len) {
        const seg = pattern[i % pattern.length] * S;
        if (i % 2 === 0) ribbon(a.clone().addScaledVector(dir, pos), a.clone().addScaledVector(dir, Math.min(len, pos + seg)), w, mat);
        pos += seg;
        i++;
      }
    }
    for (const ar of v.phase.arrows) {
      const a = new THREE.Vector3(ar.from[0], ar.from[1], topZ), b = new THREE.Vector3(ar.to[0], ar.to[1], topZ);
      const d = a.distanceTo(b);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      // Bow the arrow sideways (as on a paper diagram) and lift it off the paper.
      const side = new THREE.Vector3(-(b.y - a.y), b.x - a.x, 0).normalize().multiplyScalar(d * 0.28);
      mid.add(side);
      if (ar.kind !== 'turn-over' && ar.kind !== 'rotate') mid.z += d * 0.3;
      const curve = new THREE.QuadraticBezierCurve3(toThree(a), toThree(mid), toThree(b));
      const col = 0x2b2a28;
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, depthTest: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, S * 0.0045, 6), mat);
      tube.renderOrder = 11;
      v.overlay.add(tube);
      const head = new THREE.Mesh(new THREE.ConeGeometry(S * 0.018, S * 0.045, 14), mat);
      const end = curve.getPoint(1), tan = curve.getTangent(1);
      head.position.copy(end);
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan.normalize());
      head.renderOrder = 11;
      v.overlay.add(head);
    }
  }

  private currentPhase(): { view: PhaseView; local: number; index: number } {
    const n = this.views.length;
    const x = Math.min(this.t * n, n - 1e-9);
    const index = Math.floor(x);
    return { view: this.views[index], local: this.t >= 1 ? 1 : x - index, index };
  }

  private applyT() {
    const { view, local, index } = this.currentPhase();
    for (const v of this.views) v.group.visible = v === view;
    if (!view.group.parent) this.scene.add(view.group);
    for (const v of this.views) if (v !== view && v.group.parent) this.scene.remove(v.group);
    view.update(local);
    const fade = index === 0 || view.phase.lines.length ? Math.max(0, 1 - local / 0.3) : 0;
    view.overlay.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) mat.opacity = fade;
    });
    view.overlay.visible = fade > 0.01;
    this.dirty = true;
    this.opts.onFrame?.(this.t);
  }

  setT(t: number) {
    this.t = Math.max(0, Math.min(1, t));
    this.playing = false;
    this.applyT();
  }

  play() {
    if (this.t >= 1) this.t = 0;
    this.playing = true;
  }

  setColors(colors: Colors) {
    this.colors = colors;
    for (const v of this.views) v.setColors(colors);
    this.dirty = true;
  }

  private framing(spec: CameraSpec) {
    const box = new THREE.Box3();
    for (const v of this.views) box.union(v.bounds());
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, this.model.extent * 0.3);
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.5, Math.min(this.camera.aspect, 1.6));
    const dist = (radius / Math.sin(fov / 2)) * (aspect < 1 ? 1.15 / aspect : 1.05) / (spec.zoom ?? 1) * (this.opts.thumbnail ? 0.82 : 1);
    const el = (((spec.elevation ?? 72) * Math.PI) / 180);
    const az = (((spec.azimuth ?? 0) * Math.PI) / 180);
    const sph = new THREE.Spherical(dist, Math.PI / 2 - el, az);
    // Leave room for the step card at the bottom of the screen.
    if (!this.opts.thumbnail) center.y -= 0;
    return { center, sph, radius };
  }

  bestAngle(animate = true) {
    const finished = this.step === this.stepCount;
    const spec = finished ? this.model.finish.camera : this.model.steps[this.step]?.camera ?? PRESET_DEFAULT;
    const { center, sph, radius } = this.framing(spec);
    this.shadow.position.set(center.x, -this.thick * 2, center.z);
    this.shadow.scale.setScalar(radius * 2.4);
    if (!animate) {
      this.controls.target.copy(center);
      this.camera.position.copy(new THREE.Vector3().setFromSpherical(sph).add(center));
      this.camera.lookAt(center);
      this.controls.update();
      this.dirty = true;
      return;
    }
    const cur = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    if (cur.radius < 1e-6) cur.copy(sph);
    // Take the short way round.
    let dTheta = sph.theta - cur.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const to = sph.clone();
    to.theta = cur.theta + dTheta;
    this.camTween = { from: cur, to, tf: this.controls.target.clone(), tt: center, t: 0 };
  }

  zoomBy(k: number) {
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(1 / k);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
  }

  private loop(time: number) {
    const dt = Math.min(0.05, (time - (this.lastTime || time)) / 1000);
    this.lastTime = time;
    if (this.playing) {
      const dur = 1.6 * this.views.length;
      this.t = Math.min(1, this.t + dt / dur);
      this.applyT();
      if (this.t >= 1) this.playing = false;
    }
    if (this.camTween) {
      const c = this.camTween;
      c.t = Math.min(1, c.t + dt / 0.7);
      const e = ease(c.t);
      const s = new THREE.Spherical(
        c.from.radius + (c.to.radius - c.from.radius) * e,
        c.from.phi + (c.to.phi - c.from.phi) * e,
        c.from.theta + (c.to.theta - c.from.theta) * e,
      );
      this.controls.target.lerpVectors(c.tf, c.tt, e);
      this.camera.position.setFromSpherical(s).add(this.controls.target);
      this.camera.lookAt(this.controls.target);
      if (c.t >= 1) this.camTween = null;
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Render immediately (for thumbnails). */
  renderNow() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const v of this.views) v.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function makeShadow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(60,45,25,0.22)');
  grad.addColorStop(0.6, 'rgba(60,45,25,0.08)');
  grad.addColorStop(1, 'rgba(60,45,25,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}
