// Three.js renderer for compiled fold steps.
//
// The flat-fold engine describes each step exactly (where every face lies when
// folded flat). For display, each sheet is one connected mesh run through a
// paper simulation (see engine/sim.ts) with folds resting a little short of
// flat, so the model looks like real paper. The flat poses are still used to
// place the paper in the scene (turning over, rotating, which side stays put)
// and to draw the fold lines and arrows.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraSpec, CompiledModel, Phase, PhaseFace } from '../engine/types';
import { stateBefore } from '../engine/svg';
import { FoldSim, alignRigid, matchFaces, type SimMesh } from '../engine/sim';

type V2 = [number, number];
const apply = (m: number[], p: V2): V2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const det = (m: number[]) => m[0] * m[3] - m[1] * m[2];
/** For each face, how many overlapping faces lie below it (convex polygons, separating axis test). */
function stackDepth(faces: PhaseFace[], which: 'a' | 'b'): Float32Array {
  const polys = faces.map((f) => {
    const m = which === 'a' ? f.a : f.b, out: V2[] = [];
    for (let k = 0; k < f.p.length; k += 2) out.push(apply(m, [f.p[k], f.p[k + 1]]));
    return out;
  });
  const box = polys.map((P) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  });
  const sep = (A: V2[], B: V2[]) => {
    for (const P of [A, B]) {
      for (let i = 0; i < P.length; i++) {
        const p = P[i], q = P[(i + 1) % P.length], nx = q[1] - p[1], ny = p[0] - q[0];
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const v of A) { const d = v[0] * nx + v[1] * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
        for (const v of B) { const d = v[0] * nx + v[1] * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
        const tol = 1e-3 * Math.hypot(nx, ny);
        if (a1 <= b0 + tol || b1 <= a0 + tol) return true;
      }
    }
    return false;
  };
  const L = faces.map((f) => (which === 'a' ? f.la : f.lb));
  const depth = new Float32Array(faces.length);
  for (let i = 0; i < faces.length; i++) {
    for (let j = 0; j < faces.length; j++) {
      if (i === j || L[j] >= L[i] || faces[i].s !== faces[j].s) continue;
      const a = box[i], b = box[j];
      if (a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]) continue;
      if (!sep(polys[i], polys[j])) depth[i]++;
    }
  }
  return depth;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface Colors { [sheet: string]: { front: string; back: string } }

/** Flat (exact) pose of the faces of one phase, used to place the simulated paper. */
class FlatPhase {
  faces: PhaseFace[];
  zPivot = 0;
  chain: THREE.Matrix4[] = [];
  overlay = new THREE.Group();
  depthA: Float32Array;
  depthB: Float32Array;

  constructor(public phase: Phase, public thick: number) {
    this.faces = phase.faces;
    this.depthA = stackDepth(this.faces, 'a');
    this.depthB = phase.motion === 'crease' || phase.motion === 'none' ? this.depthA : stackDepth(this.faces, 'b');
    const moving = this.faces.filter((f) => f.d !== 0);
    this.zPivot = moving.length ? (moving.reduce((s, f) => s + f.la, 0) / moving.length) * thick : 0;
  }

  /** Paper-world position (x, y, z) of paper point p on face i at time t. */
  pose(i: number, t: number, p: V2, out: THREE.Vector3): THREE.Vector3 {
    const f = this.faces[i], ph = this.phase, e = ease(t), T = this.thick;
    const za = f.la * T, zb = f.lb * T, z = za + (zb - za) * e;
    if (ph.motion === 'spin') {
      const c = ph.center!, ang = ((ph.angle ?? 0) * Math.PI) / 180 * e;
      const a = apply(f.a, p);
      const x = a[0] - c[0], y = a[1] - c[1];
      return out.set(c[0] + Math.cos(ang) * x - Math.sin(ang) * y, c[1] + Math.sin(ang) * x + Math.cos(ang) * y, z);
    }
    if (ph.motion === 'chain') {
      out.set(p[0], p[1], 0).applyMatrix4(this.chain[i]);
      out.z += z;
      return out;
    }
    if (ph.motion === 'none' || ph.motion === 'move' || f.d === 0 || !ph.axis) {
      const a = apply(f.a, p), b = apply(f.b, p);
      return out.set(a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, z);
    }
    const [P, Q] = ph.axis;
    const ux = Q[0] - P[0], uy = Q[1] - P[1], ul = Math.hypot(ux, uy);
    const axis = new THREE.Vector3(ux / ul, uy / ul, 0);
    const pivot = new THREE.Vector3(P[0], P[1], this.zPivot);
    const a = apply(f.a, p);
    const start = new THREE.Vector3(a[0], a[1], za).sub(pivot);
    if (ph.motion === 'crease') {
      return out.copy(start.applyAxisAngle(axis, Math.PI * 0.85 * Math.sin(Math.PI * t) * f.d).add(pivot));
    }
    const rot = start.clone().applyAxisAngle(axis, Math.PI * e * f.d).add(pivot);
    const rotEnd = start.clone().applyAxisAngle(axis, Math.PI * f.d).add(pivot);
    const b = apply(f.b, p);
    return out.copy(rot.add(new THREE.Vector3(b[0], b[1], zb).sub(rotEnd).multiplyScalar(e)));
  }

  prepare(t: number) {
    if (this.phase.motion !== 'chain') return;
    const e = ease(t);
    const n = this.faces.length;
    const done: (THREE.Matrix4 | null)[] = new Array(n).fill(null);
    const lift = (m: number[]) => new THREE.Matrix4().set(m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, det(m) > 0 ? 1 : -1, 0, 0, 0, 0, 1);
    const local = (i: number): THREE.Matrix4 => {
      if (done[i]) return done[i]!;
      const f = this.faces[i];
      let M = new THREE.Matrix4();
      if (f.parent !== undefined && f.parent >= 0 && f.parent !== i) {
        M = local(f.parent).clone();
        if (f.hinge) {
          const [x0, y0, x1, y1] = f.hinge;
          const ax = new THREE.Vector3(x1 - x0, y1 - y0, 0).normalize();
          M.multiply(new THREE.Matrix4().makeTranslation(x0, y0, 0))
            .multiply(new THREE.Matrix4().makeRotationAxis(ax, (f.ang ?? 0) * e))
            .multiply(new THREE.Matrix4().makeTranslation(-x0, -y0, 0));
        }
      }
      done[i] = M;
      return M;
    };
    this.chain = this.faces.map((f, i) => (f.parent === undefined ? lift(f.a) : lift(f.a).multiply(local(i))));
  }

  bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const t of [0, 0.5, 1]) {
      this.prepare(t);
      this.faces.forEach((f, i) => {
        for (let k = 0; k < f.p.length; k += 2) box.expandByPoint(toThree(this.pose(i, t, [f.p[k], f.p[k + 1]], v), v));
      });
    }
    return box;
  }

  dispose() {
    this.overlay.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}

/** Paper world (x right, y up the diagram, z towards the viewer) -> three.js (y up). */
const toThree = (v: THREE.Vector3, out = new THREE.Vector3()) => out.set(v.x, v.z, -v.y);

/** One sheet's simulated mesh in the scene. */
class SheetView {
  geo = new THREE.BufferGeometry();
  front: THREE.Mesh;
  back: THREE.Mesh;
  lines: THREE.LineSegments;
  pos: Float32Array;
  constructor(public mesh: SimMesh, colors: { front: string; back: string }) {
    this.pos = new Float32Array(mesh.n * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.tris), 1));
    const mk = (color: string, side: THREE.Side) => new THREE.MeshStandardMaterial({
      color, side, flatShading: true, roughness: 0.92, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.front = new THREE.Mesh(this.geo, mk(colors.front, THREE.FrontSide));
    this.back = new THREE.Mesh(this.geo, mk(colors.back, THREE.BackSide));
    // Paper casts onto the table only: self-shadowing between layers a hair apart shows as acne.
    for (const m of [this.front, this.back]) { m.castShadow = true; m.receiveShadow = false; }
    // Cartoon-style lines (as in Origami Simulator): a clear outline round the paper's edges and
    // faint creases, so the shape reads at a glance.
    const pick = (kind: number) => {
      const out: number[] = [];
      for (let k = 0; k < mesh.lineKind.length; k++) if (mesh.lineKind[k] === kind) out.push(mesh.lines[2 * k], mesh.lines[2 * k + 1]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', this.geo.getAttribute('position'));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
      return g;
    };
    this.lines = new THREE.LineSegments(pick(1), new THREE.LineBasicMaterial({ color: 0x2b2a28, transparent: true, opacity: 0.22 }));
    this.lines.add(new THREE.LineSegments(pick(2), new THREE.LineBasicMaterial({ color: 0x2b2a28, transparent: true, opacity: 0.55 })));
    this.lines.traverse((o) => (o.frustumCulled = false));
  }
  setColors(c: { front: string; back: string }) {
    (this.front.material as THREE.MeshStandardMaterial).color.set(c.front);
    (this.back.material as THREE.MeshStandardMaterial).color.set(c.back);
  }
  dispose() {
    this.geo.dispose();
    this.lines.traverse((o) => { const l = o as THREE.LineSegments; l.geometry?.dispose(); (l.material as THREE.Material | undefined)?.dispose(); });
    (this.front.material as THREE.Material).dispose();
    (this.back.material as THREE.Material).dispose();
  }
}

const PRESET_DEFAULT: CameraSpec = { azimuth: 0, elevation: 72, zoom: 1 };

export interface ViewerOptions {
  colors: Colors;
  thumbnail?: boolean;
  /** Small live preview: no table, slow turntable spin, rotate only. */
  spin?: boolean;
  /** Leave room at the bottom of the canvas for a step card. */
  cardOffset?: boolean;
  /** Called with the time (0..1) through the current step on every change. */
  onFrame?: (t: number) => void;
  /** Called when a playing step reaches its end. */
  onEnd?: () => void;
}

export class FoldViewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sim: FoldSim;
  sheets: SheetView[];
  model3d = new THREE.Group();
  overlays = new THREE.Group();
  phases: FlatPhase[] = [];
  step = 0;
  /** 0..1 across all phases of the current step. */
  t = 0;
  playing = false;
  /** Seconds per phase while playing. */
  phaseSeconds = 1.6;
  thick: number;
  /** Gap between stacked layers in the simulated mesh. */
  private layerGap: number;
  colors: Colors;
  table: THREE.Group;
  sun: THREE.DirectionalLight;
  private raf = 0;
  private lastTime = 0;
  private camTween: { from: THREE.Spherical; to: THREE.Spherical; tf: THREE.Vector3; tt: THREE.Vector3; t: number } | null = null;
  private resizeObs: ResizeObserver;
  private dirty = true;
  /** Solver iterations still wanted before the paper is at rest. */
  private simBudget = 0;
  private lift = 0;
  /** Lowest the lift may go during this step: keeps the paper clear of the table without bobbing. */
  private liftFloor = 0;
  /** Smoothed placement of the simulated paper (rotation as a quaternion, and translation). */
  private place: { q: THREE.Quaternion; t: THREE.Vector3 }[] = [];
  /** True once the person has turned the camera themselves during this step. */
  userCamera = false;
  /** 0 = folds rest open, 1 = pressed completely flat. */
  flatness = 0.75;
  /** For each sheet and phase, the phase face index of every mesh vertex. */
  private vertMatch: Int32Array[][] = [];
  /** For each sheet and phase, the phase face index of every crease-pattern face. */
  private faceMatch: Int32Array[][] = [];
  private weights: Float64Array[];

  constructor(public el: HTMLElement, public model: CompiledModel, public opts: ViewerOptions) {
    this.colors = opts.colors;
    this.thick = model.extent * 0.0016;
    // Paper thickness, exaggerated a little so stacked layers always read as separate sheets.
    this.layerGap = model.extent * 0.0022;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts.thumbnail });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    el.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.controls.addEventListener('start', () => { this.camTween = null; this.userCamera = true; });
    if (opts.spin) {
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 2.4;
      this.controls.enableZoom = false;
      this.controls.enablePan = false;
    }

    // Soft, even light like a bright room: a big sky/ground fill, a gentle key light with a soft shadow, and a rim.
    this.scene.add(new THREE.HemisphereLight(0xfffbf2, 0xd9cfbd, 1.6));
    const S = model.extent;
    this.sun = new THREE.DirectionalLight(0xffffff, 1.35);
    this.sun.position.set(-0.35 * S, 1.6 * S, 0.55 * S);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 6;
    this.sun.shadow.blurSamples = 16;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = S * 0.002;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -S * 1.4; sc.right = sc.top = S * 1.4; sc.near = S * 0.1; sc.far = S * 5;
    this.scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight(0xfff4e6, 0.35);
    rim.position.set(0.6 * S, 0.5 * S, -0.8 * S);
    this.scene.add(rim);

    this.table = makeTable(S, this.el);
    if (!opts.thumbnail && !opts.spin) this.scene.add(this.table);
    this.scene.add(this.model3d, this.overlays);

    this.sim = new FoldSim(model);
    try { const f = Number(localStorage.getItem('origami:flatness')); if (f >= 0 && f <= 1 && localStorage.getItem('origami:flatness') !== null) this.flatness = f; } catch { /* ignore */ }
    if (opts.thumbnail || opts.spin) this.flatness = 0.75;
    this.sim.setRest([0.62 + 0.38 * this.flatness, 0.96 + 0.04 * this.flatness, 1]);
    this.sheets = this.sim.meshes.map((m) => {
      const sh = model.sheets.find((s) => s.id === m.sheet)!;
      const v = new SheetView(m, this.colors[m.sheet] ?? { front: sh.front, back: sh.back });
      this.model3d.add(v.front, v.back, v.lines);
      return v;
    });
    this.weights = this.sim.meshes.map((m) => new Float64Array(m.n));

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
    if (!this.opts.thumbnail && !this.opts.spin && this.opts.cardOffset !== false) this.camera.setViewOffset(w, h, 0, Math.min(120, h * 0.11), w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Show step i (0-based). i === stepCount shows the finished model. */
  showStep(i: number, { play = true, camera = true } = {}) {
    this.step = Math.max(0, Math.min(i, this.stepCount));
    for (const p of this.phases) { this.overlays.remove(p.overlay); p.dispose(); }
    const finished = this.step === this.stepCount;
    const phases = finished ? [] : this.model.steps[this.step].phases;
    if (phases.length) {
      this.phases = phases.map((ph) => new FlatPhase(ph, this.thick));
      this.faceMatch = this.sim.meshes.map((_, si) => phases.map((__, pi) => this.sim.angles[this.step][pi].match[si]));
      this.vertMatch = this.sim.meshes.map((m, si) => this.faceMatch[si].map((match) => Int32Array.from(m.vertFace, (f) => match[f])));
    } else {
      const faces = stateBefore(this.model, this.step);
      const ph: Phase = { motion: 'none', faces: faces.map((f) => ({ ...f, a: f.b, la: f.lb, d: 0 })), lines: [], arrows: [] };
      this.phases = [new FlatPhase(ph, this.thick)];
      this.faceMatch = this.sim.meshes.map((m) => [matchFaces(m, ph.faces)]);
      this.vertMatch = this.sim.meshes.map((m, si) => [Int32Array.from(m.vertFace, (f) => this.faceMatch[si][0][f])]);
    }
    this.phases.forEach((v, k) => this.buildOverlay(v, k));
    this.sim.load(this.sim.stateAt(this.step, this.opts.thumbnail ? 1.5 : 1));
    this.place = [];
    this.liftFloor = this.stepLiftFloor();
    this.lift = this.liftFloor;
    if (camera) this.userCamera = false;
    this.t = play ? 0 : finished || !phases.length ? 1 : 0;
    this.applyT();
    if (finished || this.opts.thumbnail) this.simBudget = 3000;
    if (camera) this.bestAngle(!this.opts.thumbnail);
    this.playing = play && phases.length > 0;
    this.dirty = true;
  }

  private buildOverlay(v: FlatPhase, k: number) {
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
      const mat = new THREE.MeshBasicMaterial({ color: 0x2b2a28, transparent: true, depthTest: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, S * 0.0045, 6), mat);
      tube.renderOrder = 11;
      v.overlay.add(tube);
      const head = new THREE.Mesh(new THREE.ConeGeometry(S * 0.018, S * 0.045, 14), mat);
      head.position.copy(curve.getPoint(1));
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(1).normalize());
      head.renderOrder = 11;
      v.overlay.add(head);
    }
    this.overlays.add(v.overlay);
  }

  private current(): { index: number; local: number } {
    const n = this.phases.length;
    const x = Math.min(this.t * n, n - 1e-9);
    const index = Math.floor(x);
    return { index, local: this.t >= 1 ? 1 : x - index };
  }

  /** Sets solver targets for the current time and asks for more iterations. */
  private applyT() {
    const { index, local } = this.current();
    if (this.step < this.stepCount && this.model.steps[this.step].phases.length) {
      // Earlier phases of this step are complete; later ones have not started.
      this.sim.setTargets(this.step, index, local);
    } else {
      this.sim.setRestTargets(this.step);
    }
    this.phases.forEach((p, k) => {
      const show = k === index || (k === 0 && index === 0);
      const fade = show && (k === 0 || p.phase.lines.length) ? 1 - smooth(0.42, 0.62, local) : 0;
      p.overlay.visible = fade > 0.01;
      p.overlay.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) mat.opacity = fade;
      });
    });
    this.simBudget = Math.max(this.simBudget, 1200);
    this.dirty = true;
    this.opts.onFrame?.(this.t);
  }

  /** Runs the solver a little and places the meshes. */
  private updateMesh(iters: number) {
    if (iters > 0) {
      const speed = this.sim.iterate(iters);
      this.simBudget -= iters;
      if (speed < 4e-4 && !this.playing) this.simBudget = Math.min(this.simBudget, 0);
    }
    const { index, local } = this.current();
    const fp = this.phases[Math.min(index, this.phases.length - 1)];
    fp.prepare(local);
    const hasStill = fp.phase.motion === 'hinge' && fp.faces.some((f) => f.d === 0) && fp.faces.some((f) => f.d !== 0);
    const v = new THREE.Vector3(), w3 = new THREE.Vector3(), vx = new THREE.Vector3(), vy = new THREE.Vector3();
    let minY = Infinity;
    this.sim.solvers.forEach((sv, si) => {
      const mesh = sv.mesh, W = this.weights[si];
      const n = mesh.n, s = mesh.size, X = sv.x;
      const match = this.vertMatch[si][Math.min(index, this.vertMatch[si].length - 1)];
      // Correspondences: every vertex, plus, for every triangle, a point a little way along its
      // front normal, so the fit cannot settle on the mirror image of a symmetric shape.
      const L = s * 0.2;
      const T = mesh.tris, nt = T.length / 3;
      const src = new Float64Array(3 * (n + nt)), dst = new Float64Array(3 * (n + nt)), ww = new Float64Array(n + nt);
      for (let i = 0; i < n; i++) {
        const fi = match[i];
        src[3 * i] = X[3 * i] * s; src[3 * i + 1] = X[3 * i + 1] * s; src[3 * i + 2] = X[3 * i + 2] * s;
        if (fi < 0) { ww[i] = 0; W[i] = 0; continue; }
        toThree(fp.pose(fi, local, [mesh.paper[2 * i], mesh.paper[2 * i + 1]], v), w3);
        dst[3 * i] = w3.x; dst[3 * i + 1] = w3.y; dst[3 * i + 2] = w3.z;
        const wt = hasStill ? (fp.faces[fi].d === 0 ? 1 : 0.02) : 1;
        ww[i] = wt; W[i] = wt;
      }
      const faceMatch = this.faceMatch[si][Math.min(index, this.faceMatch[si].length - 1)];
      for (let k = 0; k < nt; k++) {
        const a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
        const j = n + k, fi = faceMatch[mesh.triFace[k]];
        // Simulated triangle: centroid plus normal.
        const ux = X[3 * b] - X[3 * a], uy = X[3 * b + 1] - X[3 * a + 1], uz = X[3 * b + 2] - X[3 * a + 2];
        const qx = X[3 * c] - X[3 * a], qy = X[3 * c + 1] - X[3 * a + 1], qz = X[3 * c + 2] - X[3 * a + 2];
        let nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        src[3 * j] = (src[3 * a] + src[3 * b] + src[3 * c]) / 3 + nx * L;
        src[3 * j + 1] = (src[3 * a + 1] + src[3 * b + 1] + src[3 * c + 1]) / 3 + ny * L;
        src[3 * j + 2] = (src[3 * a + 2] + src[3 * b + 2] + src[3 * c + 2]) / 3 + nz * L;
        if (fi < 0) { ww[j] = 0; continue; }
        const px = (mesh.paper[2 * a] + mesh.paper[2 * b] + mesh.paper[2 * c]) / 3;
        const py = (mesh.paper[2 * a + 1] + mesh.paper[2 * b + 1] + mesh.paper[2 * c + 1]) / 3;
        toThree(fp.pose(fi, local, [px, py], v), w3);
        toThree(fp.pose(fi, local, [px + 1, py], v), vx).sub(w3);
        toThree(fp.pose(fi, local, [px, py + 1], v), vy).sub(w3);
        // Paper front normal is x × y in paper space (toThree is a proper rotation).
        const fn = vx.clone().cross(vy).normalize();
        dst[3 * j] = w3.x + fn.x * L; dst[3 * j + 1] = w3.y + fn.y * L; dst[3 * j + 2] = w3.z + fn.z * L;
        ww[j] = hasStill ? (fp.faces[fi].d === 0 ? 1 : 0.02) : 1;
      }
      const fit = alignRigid(src, dst, ww);
      // Ease the placement towards the new fit, so the solver's small corrections do not wobble the model.
      const mq = new THREE.Matrix4().set(fit.R[0], fit.R[1], fit.R[2], 0, fit.R[3], fit.R[4], fit.R[5], 0, fit.R[6], fit.R[7], fit.R[8], 0, 0, 0, 0, 1);
      const q = new THREE.Quaternion().setFromRotationMatrix(mq), tv = new THREE.Vector3(fit.t[0], fit.t[1], fit.t[2]);
      const prev = this.place[si];
      const k = !prev || iters === 0 ? 1 : this.playing ? 0.6 : 0.3;
      if (prev) { prev.q.slerp(q, k); prev.t.lerp(tv, k); } else this.place[si] = { q, t: tv };
      const pl = this.place[si];
      const Rm = new THREE.Matrix4().makeRotationFromQuaternion(pl.q).elements;
      const R = [Rm[0], Rm[4], Rm[8], Rm[1], Rm[5], Rm[9], Rm[2], Rm[6], Rm[10]], t = [pl.t.x, pl.t.y, pl.t.z];
      const P = this.sheets[si].pos;
      for (let i = 0; i < n; i++) {
        const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
        const px = R[0] * x + R[1] * y + R[2] * z + t[0];
        const py = R[3] * x + R[4] * y + R[5] * z + t[1];
        const pz = R[6] * x + R[7] * y + R[8] * z + t[2];
        P[3 * i] = px; P[3 * i + 1] = py; P[3 * i + 2] = pz;
      }
      // Layers that lie flat on each other would z-fight or cross. Lift each triangle off the
      // layers below it, along its own "up" (the side that faced up in the flat diagram).
      const e = ease(local), off = this.layerGap;
      const acc = new Float32Array(3 * n), cnt = new Float32Array(n);
      for (let k = 0; k < nt; k++) {
        const fi = faceMatch[mesh.triFace[k]];
        if (fi < 0) continue;
        const f = fp.faces[fi];
        const moving = f.d !== 0 && fp.phase.motion !== 'none';
        // A moving flap turns over as a rigid stack: keep its start order until halfway, then its end order.
        const dep = moving ? (e > 0.5 ? fp.depthB[fi] : fp.depthA[fi]) : fp.depthA[fi] + (fp.depthB[fi] - fp.depthA[fi]) * e;
        const det0 = det(moving && e > 0.5 ? f.b : f.a) > 0 ? 1 : -1;
        const wgt = 1;
        const a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
        const qx = P[3 * c] - P[3 * a], qy = P[3 * c + 1] - P[3 * a + 1], qz = P[3 * c + 2] - P[3 * a + 2];
        let nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const sc = (det0 * dep * off * wgt) / nl;
        nx *= sc; ny *= sc; nz *= sc;
        for (const vtx of [a, b, c]) { acc[3 * vtx] += nx; acc[3 * vtx + 1] += ny; acc[3 * vtx + 2] += nz; cnt[vtx]++; }
      }
      for (let i = 0; i < n; i++) {
        if (cnt[i]) { P[3 * i] += acc[3 * i] / cnt[i]; P[3 * i + 1] += acc[3 * i + 1] / cnt[i]; P[3 * i + 2] += acc[3 * i + 2] / cnt[i]; }
        if (P[3 * i + 1] < minY) minY = P[3 * i + 1];
      }
      const g = this.sheets[si].geo;
      g.attributes.position.needsUpdate = true;
      g.computeBoundingSphere();
    });
    // Keep the paper clear of the table. The lift never drops during a step (no bobbing), and rises
    // smoothly when an opening fold reaches lower than expected.
    const need = isFinite(minY) ? -minY + this.model.extent * 0.012 : 0;
    const target = Math.max(this.liftFloor, need);
    if (target > this.lift || !this.place.length) this.lift = target > this.lift + this.model.extent * 0.05 ? target : this.lift + (target - this.lift) * 0.35;
    if (need > this.lift) this.lift = need;
    this.liftFloor = Math.max(this.liftFloor, this.lift);
    this.model3d.position.y = this.lift;
    this.overlays.position.y = this.lift;
    this.dirty = true;
  }

  setT(t: number) {
    this.t = Math.max(0, Math.min(1, t));
    this.playing = false;
    this.applyT();
  }

  /** Plays the current step from the start. `speed` 1 is normal; lower is slower. */
  play(speed = 1) {
    this.t = 0;
    this.phaseSeconds = 1.6 / speed;
    if (this.step < this.stepCount) this.sim.load(this.sim.stateAt(this.step));
    this.playing = true;
    this.applyT();
  }

  stop() { this.playing = false; }

  setColors(colors: Colors) {
    this.colors = colors;
    this.sheets.forEach((s) => { const c = colors[s.mesh.sheet]; if (c) s.setColors(c); });
    this.dirty = true;
  }

  private framing(spec: CameraSpec) {
    const box = new THREE.Box3();
    for (const v of this.phases) box.union(v.bounds());
    // The simulated paper rests on the table, a little above the flat pose.
    const center = box.getCenter(new THREE.Vector3());
    center.y = Math.max(0, (box.max.y - box.min.y) / 2) + this.model.extent * 0.03;
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, this.model.extent * 0.3);
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.5, Math.min(this.camera.aspect, 1.6));
    const dist = (radius / Math.sin(fov / 2)) * (aspect < 1 ? 1.15 / aspect : 1.05) / (spec.zoom ?? 1) * (this.opts.thumbnail ? 0.82 : this.opts.spin ? 1.15 : 1);
    const el = (((spec.elevation ?? 72) * Math.PI) / 180);
    const az = (((spec.azimuth ?? 0) * Math.PI) / 180);
    return { center, sph: new THREE.Spherical(dist, Math.PI / 2 - Math.min(el, 89 * Math.PI / 180), az), radius };
  }

  bestAngle(animate = true) {
    const finished = this.step === this.stepCount;
    const spec = finished ? this.model.finish.camera : this.model.steps[this.step] ? this.autoCamera() : PRESET_DEFAULT;
    const { center, sph } = this.framing(spec);
    this.sun.target.position.set(center.x, 0, center.z);
    this.sun.position.set(center.x - 0.35 * this.model.extent, 1.6 * this.model.extent, center.z + 0.55 * this.model.extent);
    this.table.position.set(center.x, 0, center.z);
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
    let dTheta = sph.theta - cur.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const to = sph.clone();
    to.theta = cur.theta + dTheta;
    this.camTween = { from: cur, to, tf: this.controls.target.clone(), tt: center, t: 0 };
  }

  /** Sets how flat the folds are pressed (0 = relaxed and open, 1 = completely flat). */
  setFlatness(f: number) {
    this.flatness = Math.max(0, Math.min(1, f));
    try { localStorage.setItem('origami:flatness', String(this.flatness)); } catch { /* ignore */ }
    const g = this.flatness;
    this.sim.setRest([0.62 + 0.38 * g, 0.96 + 0.04 * g, 1]);
    const t = this.t, playing = this.playing;
    this.sim.load(this.sim.stateAt(this.step, this.opts.thumbnail ? 1.5 : 1));
    this.t = t;
    this.playing = playing;
    this.liftFloor = this.stepLiftFloor();
    this.applyT();
    this.simBudget = Math.max(this.simBudget, 3000);
  }

  /** Height the paper needs above the table for this step, from the exact pose over the whole step. */
  private stepLiftFloor(): number {
    let minY = 0;
    for (const v of this.phases) minY = Math.min(minY, v.bounds().min.y);
    return -minY + this.model.extent * 0.012;
  }

  /**
   * Camera for a step without an authored one: a raised three-quarter view turned so the fold's hinge
   * runs across the picture at an angle, which shows the flap lifting best. Stays near the diagram's
   * own orientation (top of the paper away from you).
   */
  private autoCamera(): CameraSpec {
    const finished = this.step === this.stepCount;
    if (finished) return this.model.finish.camera;
    const step = this.model.steps[this.step];
    if (!step.camera.auto) return step.camera;
    const ph = step.phases.find((p) => p.axis && (p.motion === 'hinge' || p.motion === 'crease'));
    if (!ph?.axis) return { azimuth: 0, elevation: 70, zoom: 1 };
    const [a, b] = ph.axis;
    // Axis direction in three.js ground coordinates (x, z) = (x, -y).
    const ax = b[0] - a[0], az = -(b[1] - a[1]), L = Math.hypot(ax, az) || 1;
    let best = 0, bestScore = Infinity;
    for (let deg = -35; deg <= 35; deg += 5) {
      const r = (deg * Math.PI) / 180;
      // Horizontal view direction for this azimuth (camera looks towards -z when azimuth is 0).
      const vx = -Math.sin(r), vz = -Math.cos(r);
      const ang = Math.acos(Math.min(1, Math.abs((vx * ax + vz * az) / L))) * (180 / Math.PI);
      const score = Math.abs(ang - 50) + Math.abs(deg) * 0.15;
      if (score < bestScore) { bestScore = score; best = deg; }
    }
    return { azimuth: best, elevation: ph.motion === 'crease' ? 62 : 56, zoom: 1 };
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
      const dur = this.phaseSeconds * this.phases.length;
      this.t = Math.min(1, this.t + dt / dur);
      this.applyT();
      if (this.t >= 1) { this.playing = false; this.opts.onEnd?.(); }
    }
    if (this.simBudget > 0) this.updateMesh(Math.min(this.simBudget, this.playing ? 90 : 160));
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
      this.fitDepth();
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Keeps the depth range tight round the model: stacked layers sit a hair apart, so precision matters. */
  private fitDepth() {
    const d = this.camera.position.distanceTo(this.controls.target), S = this.model.extent;
    const near = Math.max(0.05, (d - S * 1.6) * 0.9, d * 0.04), far = d + S * 12;
    if (Math.abs(near - this.camera.near) > 1e-3 || Math.abs(far - this.camera.far) > 1e-3) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Settles the paper and renders immediately (for thumbnails). */
  renderNow() {
    this.sim.settle(1.5);
    this.updateMesh(0);
    this.controls.update();
    this.fitDepth();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const p of this.phases) p.dispose();
    for (const s of this.sheets) s.dispose();
    this.table.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

/** A soft table: a shadow catcher and a faint grid that fades out with distance. */
function makeTable(S: number, el: HTMLElement): THREE.Group {
  const g = new THREE.Group();
  const size = S * 8;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity: 0.16 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.receiveShadow = true;
  g.add(shadow);
  const ink = getComputedStyle(el).getPropertyValue('--ink').trim() || '#2b2a28';
  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(ink) },
      uCell: { value: S >= 20 ? 2 : 1 },
      uMajor: { value: S >= 20 ? 10 : 5 },
      uFade: { value: S * 1.6 },
    },
    vertexShader: `varying vec2 vXY; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vXY = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uCell; uniform float uMajor; uniform float uFade; varying vec2 vXY;
      float grid(float cell){ vec2 c = vXY / cell; vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - min(min(d.x, d.y), 1.0); }
      void main(){
        vec2 o = vXY - (modelMatrix_center);
        float r = length(o);
        float fade = 1.0 - smoothstep(uFade * 0.35, uFade, r);
        float a = max(grid(uCell) * 0.05, grid(uMajor) * 0.11) * fade;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }`.replace('modelMatrix_center', 'uCenter'),
  });
  gridMat.uniforms.uCenter = { value: new THREE.Vector2() };
  gridMat.fragmentShader = 'uniform vec2 uCenter;\n' + gridMat.fragmentShader;
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(size, size), gridMat);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -S * 0.0005;
  grid.onBeforeRender = () => {
    const p = new THREE.Vector3();
    g.getWorldPosition(p);
    (gridMat.uniforms.uCenter.value as THREE.Vector2).set(p.x, p.z);
  };
  g.add(grid);
  return g;
}
