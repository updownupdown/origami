// Three.js renderer for compiled fold steps.
//
// The flat-fold engine describes each step exactly (where every face lies when
// folded flat). Steps of plain folds are drawn straight from that exact pose:
// flaps turn rigidly about their hinges and each layer sits a paper thickness
// above the one below. Collapses, 3D shaping and every step after the paper has
// been shaped are posed by rigid-origami kinematics (engine/kinematic.ts): faces stay
// flat and rigid, creases close up exactly, and the motion follows the fold angles the
// script asks for, so the same step always looks the same. The physics simulation
// (engine/sim.ts) is kept behind the `physics` option.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraSpec, CompiledModel, Phase, PhaseFace } from '../engine/types';
import { stateBefore } from '../engine/svg';
import { FoldSim, alignRigid, matchFaces, type SimMesh } from '../engine/sim';
import { Kinematics } from '../engine/kinematic';

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
  // Height of the stack under each face: one more than the tallest face it rests on. (Counting every
  // face below would count one layer many times over where creases cut it into pieces, and the
  // layers would spread far apart.)
  const depth = new Float32Array(faces.length);
  const order = faces.map((_, i) => i).sort((i, j) => L[i] - L[j]);
  for (const i of order) {
    for (const j of order) {
      if (L[j] >= L[i]) break;
      if (faces[i].s !== faces[j].s || depth[j] + 1 <= depth[i]) continue;
      const a = box[i], b = box[j];
      if (a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]) continue;
      if (!sep(polys[i], polys[j])) depth[i] = depth[j] + 1;
    }
  }
  return depth;
}

const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));
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
    this.depthB = phase.motion === 'crease' || phase.motion === 'none' || phase.motion === 'shape' || phase.motion === 'stand' ? this.depthA : stackDepth(this.faces, 'b');
    const moving = this.faces.filter((f) => f.d !== 0);
    this.zPivot = moving.length ? (moving.reduce((s, f) => s + f.la, 0) / moving.length) * thick : 0;
  }

  /** Paper-world position (x, y, z) of paper point p on face i at time t, with the model's tilt (standing). */
  pose(i: number, t: number, p: V2, out: THREE.Vector3): THREE.Vector3 {
    this.poseFlat(i, t, p, out);
    return this.tilt(t, out);
  }

  /** Applies the model's tilt (standing) at time t of the phase to a paper-world point, in place. */
  tilt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const tl = this.phase.tilt;
    if (!tl) return out;
    const ang = ((tl.a0 + (tl.a1 - tl.a0) * ease(t)) * Math.PI) / 180;
    if (Math.abs(ang) < 1e-9) return out;
    return out.sub(new THREE.Vector3(tl.p[0], tl.p[1], 0))
      .applyAxisAngle(new THREE.Vector3(tl.q[0] - tl.p[0], tl.q[1] - tl.p[1], 0).normalize(), ang)
      .add(new THREE.Vector3(tl.p[0], tl.p[1], 0));
  }

  /** Tilt at the end of the phase as a three.js matrix (for the diagram overlay). */
  tiltMatrix(): THREE.Matrix4 | null {
    const tl = this.phase.tilt;
    if (!tl || Math.abs(tl.a1) < 1e-9) return null;
    const P = toThree(new THREE.Vector3(tl.p[0], tl.p[1], 0)), Q = toThree(new THREE.Vector3(tl.q[0], tl.q[1], 0));
    return new THREE.Matrix4().makeTranslation(P.x, P.y, P.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(Q.clone().sub(P).normalize(), (tl.a1 * Math.PI) / 180))
      .multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
  }

  private poseFlat(i: number, t: number, p: V2, out: THREE.Vector3): THREE.Vector3 {
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
      return out.copy(start.applyAxisAngle(axis, Math.PI * 0.85 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t)) * f.d).add(pivot));
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
  /** Positions of the mesh vertices (used for the crease lines and framing). */
  pos: Float32Array;
  posAttr: THREE.BufferAttribute;
  /**
   * The drawn surface has its own copy of each vertex per crease-pattern face, so every face can be
   * lifted off the layers below it as one rigid piece (no kinks inside a face).
   */
  rpos: Float32Array;
  /** For each drawn vertex: its mesh vertex, and its crease-pattern face. */
  rvert: Int32Array;
  rface: Int32Array;
  constructor(public mesh: SimMesh, colors: { front: string; back: string }) {
    this.pos = new Float32Array(mesh.n * 3);
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    const key = new Map<number, number>(), rv: number[] = [], rf: number[] = [], idx: number[] = [];
    const nf = Math.max(1, ...Array.from(mesh.triFace)) + 1;
    for (let k = 0; k < mesh.tris.length; k++) {
      const v = mesh.tris[k], f = mesh.triFace[Math.floor(k / 3)], kk = v * nf + f;
      let r = key.get(kk);
      if (r === undefined) { r = rv.length; key.set(kk, r); rv.push(v); rf.push(f); }
      idx.push(r);
    }
    this.rvert = Int32Array.from(rv);
    this.rface = Int32Array.from(rf);
    this.rpos = new Float32Array(rv.length * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.rpos, 3));
    this.geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
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
      g.setAttribute('position', this.posAttr);
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
      return g;
    };
    this.lines = new THREE.LineSegments(pick(1), new THREE.LineBasicMaterial({ color: 0x2b2a28, transparent: true, opacity: 0.22 }));
    this.lines.add(new THREE.LineSegments(pick(2), new THREE.LineBasicMaterial({ color: 0x2b2a28, transparent: true, opacity: 0.55 })));
    // Creases made in this step are drawn dashed in their colour (valley, mountain, or crease-and-unfold)
    // until the next step, where they quickly fade back into plain creases.
    this.fresh = [...CREASE_STYLE, ...CREASE_STYLE].map((st) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: 0.95, depthFunc: THREE.LessEqualDepth }));
      l.renderOrder = 2;
      this.lines.add(l);
      return l;
    });
    this.lines.traverse((o) => (o.frustumCulled = false));
  }
  /** Coloured creases: valley, mountain, crease made this step, then the same made last step (fading). */
  private fresh: THREE.LineSegments[];
  private freshSegs: number[][] = [[], [], [], [], [], []];
  private freshKey = '';
  private shownKey = '';
  /**
   * Shows only the creases that have been made by now: those folded earlier, plus the ones the
   * current phase is folding once it has started. `born` is each hinge's first step * 64 + phase.
   * `kinds` colours the ones made this step (and last step's, fading out as `fadeIn` goes 0 to 1).
   */
  showCreases(born: Int32Array, step: number, phase: number, local: number, kinds?: Int8Array, fadeIn = 1) {
    const now = step * 64 + Math.min(phase, 63);
    const m = this.mesh, out: number[] = [];
    const fresh: number[][] = [[], [], [], [], [], []];
    let key = '';
    for (let k = 0; k < m.lineKind.length; k++) {
      if (m.lineKind[k] !== 1) continue;
      const b = born[m.lineHinge[k]];
      const on = b < now || (b === now && local > 0.04);
      const kind = on && kinds ? kinds[m.lineHinge[k]] : 0;
      let slot = -1;
      if (kind) {
        const bs = Math.floor(b / 64);
        slot = bs === step ? 0 : bs === step - 1 && fadeIn < 0.999 ? 3 : -1;
        if (slot >= 0) slot += kind === 1 ? 0 : kind === -1 ? 1 : 2;
      }
      // This step's creases are drawn only in colour; plain lines show through last step's as they fade.
      const plain = on && !(slot >= 0 && slot < 3);
      key += plain ? '1' : '0';
      if (plain) out.push(m.lines[2 * k], m.lines[2 * k + 1]);
      if (slot >= 0) fresh[slot].push(m.lines[2 * k], m.lines[2 * k + 1]);
    }
    const fk = fresh.map((f) => f.join(',')).join('|');
    if (fk !== this.freshKey) { this.freshKey = fk; this.freshSegs = fresh; }
    for (const i of [3, 4, 5]) {
      const mat = this.fresh[i].material as THREE.LineBasicMaterial;
      mat.userData.base = 0.95 * (1 - fadeIn);
      mat.opacity = mat.userData.base;
    }
    this.fresh.forEach((l, i) => (l.visible = this.freshSegs[i].length > 0 && (i < 3 || fadeIn < 0.999)));
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.lines.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
  }

  /** Lays the coloured creases out as dashes along the paper as it is now (`size`: the model's extent). */
  drawFresh(size: number) {
    const P = this.pos;
    this.fresh.forEach((l, i) => {
      const segs = this.freshSegs[i];
      if (!segs.length) return;
      const pattern = CREASE_STYLE[i % 3].dash;
      const out: number[] = [];
      for (let k = 0; k < segs.length; k += 2) {
        const a = 3 * segs[k], b = 3 * segs[k + 1];
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const len = Math.hypot(dx, dy, dz);
        let pos = 0, j = 0;
        while (pos < len) {
          const seg = pattern[j % pattern.length] * size;
          if (j % 2 === 0) {
            const u = pos / len, v = Math.min(len, pos + seg) / len;
            out.push(P[a] + dx * u, P[a + 1] + dy * u, P[a + 2] + dz * u, P[a] + dx * v, P[a + 1] + dy * v, P[a + 2] + dz * v);
          }
          pos += seg;
          j++;
        }
      }
      const g = l.geometry, attr = g.getAttribute('position') as THREE.BufferAttribute;
      if (attr.array.length !== out.length) g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
      else { (attr.array as Float32Array).set(out); attr.needsUpdate = true; }
      g.computeBoundingSphere();
    });
  }
  /** Fades the sheet (1 = solid). Used to dissolve across a step where paper would pass through paper. */
  setOpacity(o: number) {
    const solid = o >= 0.999;
    for (const m of [this.front.material, this.back.material] as THREE.MeshStandardMaterial[]) {
      if (m.transparent !== !solid) { m.transparent = !solid; m.needsUpdate = true; }
      m.opacity = o;
      m.depthWrite = solid;
    }
    for (const l of [this.lines, ...this.lines.children] as THREE.LineSegments[]) {
      const lm = l.material as THREE.LineBasicMaterial;
      lm.userData.base ??= lm.opacity;
      lm.opacity = lm.userData.base * o;
    }
    this.front.visible = this.back.visible = this.lines.visible = o > 0.001;
    this.front.castShadow = this.back.castShadow = solid;
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

/** Diagram line styles: colour and dash pattern (fractions of the model's size, dash then gap). */
const CREASE_STYLE = [
  { color: 0x2f6fdb, dash: [0.045, 0.03] },             // valley: dashes
  { color: 0xc4540a, dash: [0.06, 0.02, 0.01, 0.02] }, // mountain: dash-dot
  { color: 0x8a4fd1, dash: [0.012, 0.016] },            // crease and unfold: dots
];
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
  /** Use the bar-and-hinge physics simulation for 3D steps instead of exact kinematics. */
  physics?: boolean;
}

export class FoldViewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sim: FoldSim;
  kin: Kinematics;
  sheets: SheetView[];
  /** Second copy of each sheet, shown only while dissolving across a span where paper would cross. */
  ghosts: SheetView[];
  model3d = new THREE.Group();
  overlays = new THREE.Group();
  phases: FlatPhase[] = [];
  step = 0;
  /** 0..1 across all phases of the current step. */
  t = 0;
  playing = false;
  /** When the current step was shown (coloured creases from the step before fade out from here). */
  private shownAt = 0;
  /** Flat circular arrow over the canvas for steps that turn the model round. */
  private spinHint: HTMLDivElement;
  /** Set while a step plays backwards to its start (see `rewind`). */
  rewinding: { from: number; then?: () => void } | null = null;
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
  private floors = new Map<number, number>();
  /** First step that folds each crease, per sheet (creases appear only once they are made). */
  private born: Int32Array[] = [];
  /** Per sheet, per hinge: 1 valley, -1 mountain (as seen in the step that makes it), 0 none. */
  private kinds: Int8Array[] = [];
  /** True when the current step is drawn from the exact flat-fold pose (see exactStep). */
  private exact = false;
  /** Smoothed placement of the simulated paper (rotation as a quaternion, and translation). */
  private place: { q: THREE.Quaternion; t: THREE.Vector3 }[] = [];
  /** True once the person has turned the camera themselves during this step. */
  userCamera = false;
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
    this.spinHint = document.createElement('div');
    this.spinHint.className = 'spin-hint';
    this.spinHint.setAttribute('aria-hidden', 'true');
    this.spinHint.style.cssText = 'position:absolute;left:50%;top:40%;width:min(46vmin,320px);aspect-ratio:1;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .2s;color:#2b2a28';
    this.spinHint.innerHTML = '<svg viewBox="-60 -60 120 120" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M 0 -50 A 50 50 0 1 1 -43.3 -25"/><path d="M -43.3 -25 l 0 14 M -43.3 -25 l -12.1 7"/></svg>';
    if (!opts.thumbnail && !opts.spin) el.appendChild(this.spinHint);
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
    this.born = this.sim.meshes.map((_, i) => this.sim.creaseBorn(i));
    this.kinds = this.sim.meshes.map((_, i) => this.creaseKinds(i));
    this.kin = new Kinematics(model, this.sim.meshes, this.sim.angles, this.born);
    // Simulated steps (collapses, 3D shaping) start from paper folded almost flat, like the exact poses.
    this.sim.setRest([0.98, 1, 1]);
    this.sheets = this.sim.meshes.map((m) => {
      const sh = model.sheets.find((s) => s.id === m.sheet)!;
      const v = new SheetView(m, this.colors[m.sheet] ?? { front: sh.front, back: sh.back });
      this.model3d.add(v.front, v.back, v.lines);
      return v;
    });
    this.ghosts = this.sim.meshes.map((m) => {
      const sh = model.sheets.find((s) => s.id === m.sheet)!;
      const v = new SheetView(m, this.colors[m.sheet] ?? { front: sh.front, back: sh.back });
      this.model3d.add(v.front, v.back, v.lines);
      v.setOpacity(0);
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
    this.rewinding = null;
    this.shownAt = performance.now();
    for (const p of this.phases) { this.overlays.remove(p.overlay); p.dispose(); }
    const finished = this.step === this.stepCount;
    const phases = finished ? [] : this.model.steps[this.step].phases;
    if (phases.length) {
      this.phases = phases.map((ph) => new FlatPhase(ph, this.thick));
      this.faceMatch = this.sim.meshes.map((_, si) => phases.map((__, pi) => this.sim.angles[this.step][pi].match[si]));
      this.vertMatch = this.sim.meshes.map((m, si) => this.faceMatch[si].map((match) => Int32Array.from(m.vertFace, (f) => match[f])));
    } else {
      const faces = stateBefore(this.model, this.step);
      const lastTilt = this.model.steps.slice(0, this.step).reverse().flatMap((st) => st.phases.slice(-1))[0]?.tilt;
      const ph: Phase = { motion: 'none', faces: faces.map((f) => ({ ...f, a: f.b, la: f.lb, d: 0 })), lines: [], arrows: [] };
      if (lastTilt) ph.tilt = { ...lastTilt, a0: lastTilt.a1 };
      this.phases = [new FlatPhase(ph, this.thick)];
      this.faceMatch = this.sim.meshes.map((m) => [matchFaces(m, ph.faces)]);
      this.vertMatch = this.sim.meshes.map((m, si) => [Int32Array.from(m.vertFace, (f) => this.faceMatch[si][0][f])]);
    }
    this.phases.forEach((v, k) => this.buildOverlay(v, k));
    this.exact = this.exactStep();
    if (this.opts.physics) {
      this.sim.ensureStep(this.step);
      this.sim.load(this.sim.stateAt(this.step, 1));
    } else if (!this.exact) this.kin.ensureStep(this.step);
    this.place = [];

    if (camera) this.userCamera = false;
    this.t = play ? 0 : finished || !phases.length ? 1 : 0;
    this.applyT();
    if ((finished || this.opts.thumbnail) && this.opts.physics) this.simBudget = 3000;
    this.updateMesh(0);
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
      // Valley (blue dashes), mountain (orange dash-dot), or a crease made and unfolded (purple dots).
      const st = CREASE_STYLE[v.phase.motion === 'crease' ? 2 : l.kind === 'mountain' ? 1 : 0];
      const mat = new THREE.MeshBasicMaterial({ color: st.color, transparent: true, depthTest: false, side: THREE.DoubleSide });
      const a = toThree(new THREE.Vector3(l.p[0], l.p[1], topZ)), b = toThree(new THREE.Vector3(l.q[0], l.q[1], topZ));
      const len = a.distanceTo(b), dir = b.clone().sub(a).normalize();
      const pattern = st.dash;
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
      if (ar.kind === 'rotate') continue; // shown as a flat arrow on the screen instead
      const a = new THREE.Vector3(ar.from[0], ar.from[1], topZ), b = new THREE.Vector3(ar.to[0], ar.to[1], topZ);
      const d = a.distanceTo(b);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      // Bow the arrow sideways (as on a paper diagram) and lift it off the paper.
      const side = new THREE.Vector3(-(b.y - a.y), b.x - a.x, 0).normalize().multiplyScalar(d * 0.28);
      mid.add(side);
      if (ar.kind !== 'turn-over') mid.z += d * 0.3;
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
    const tm = v.tiltMatrix();
    if (tm) v.overlay.applyMatrix4(tm);
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
    // Turning the model round: a flat circular arrow on the screen (drawn clockwise; mirrored for anticlockwise).
    const spin = this.phases[index]?.phase.motion === 'spin' && !this.rewinding && this.t < 1 ? this.phases[index].phase.angle ?? 0 : 0;
    this.spinHint.style.opacity = spin ? String(1 - smooth(0.7, 1, local)) : '0';
    if (spin) this.spinHint.style.transform = `translate(-50%,-50%)${spin > 0 ? ' scaleX(-1)' : ''}`;
    this.phases.forEach((p, k) => {
      const show = !this.rewinding && (k === index || (k === 0 && index === 0));
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
  /**
   * Rigidly places simulated positions X (paper units) of sheet si onto the exact flat pose of phase
   * `fp` at time `local`, weighting faces by `still`. Returns the placed positions (cm, three.js).
   */
  private fitToPose(si: number, X: Float64Array, fp: FlatPhase, index: number, local: number, still: (fi: number) => number): Float64Array {
    const mesh = this.sim.meshes[si], W = this.weights[si];
    const n = mesh.n, s = mesh.size;
    const match = this.vertMatch[si][Math.min(index, this.vertMatch[si].length - 1)];
    const v = new THREE.Vector3(), w3 = new THREE.Vector3(), vx = new THREE.Vector3(), vy = new THREE.Vector3();
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
      const wt = still(fi);
      ww[i] = wt; W[i] = wt;
    }
    const faceMatch = this.faceMatch[si][Math.min(index, this.faceMatch[si].length - 1)];
    for (let k = 0; k < nt; k++) {
      const a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
      const j = n + k, fi = faceMatch[mesh.triFace[k]];
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
      ww[j] = still(fi);
    }
    const { R, t } = alignRigid(src, dst, ww);
    const out = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
      out[3 * i] = R[0] * x + R[1] * y + R[2] * z + t[0];
      out[3 * i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
      out[3 * i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
    }
    return out;
  }

  /**
   * Whether the current step is drawn from the exact flat-fold pose. Flaps then turn rigidly about
   * their hinges, flat paper stays perfectly flat, and creases not made yet cannot show. Collapses
   * (chain) and 3D shaping are not rigid hinge motions, so those steps, and every step after the
   * paper has been shaped, replay the simulation instead.
   */
  private exactStep(i = this.step): boolean {
    const steps = this.model.steps;
    // Standing a flat-folded model up only tilts it (part of the exact pose); shaping makes it 3D.
    const shaped = (k: number) => steps[k].phases.some((p) => p.motion === 'shape');
    for (let k = 0; k < Math.min(i + 1, steps.length); k++) if (shaped(k)) return false;
    if (i >= steps.length) return true;
    return !steps[i].phases.some((p) => p.motion === 'chain');
  }

  /** Runs the solver a little (or replays the step) and places the meshes. */
  private updateMesh(iters: number) {
    const { index, local } = this.current();
    const fp = this.phases[Math.min(index, this.phases.length - 1)];
    if (this.exact) {
      this.simBudget = 0;
      fp.prepare(local);
      const v = new THREE.Vector3(), w = new THREE.Vector3();
      let minY = Infinity;
      this.sim.meshes.forEach((mesh, si) => {
        const match = this.vertMatch[si][Math.min(index, this.vertMatch[si].length - 1)];
        const P = this.sheets[si].pos;
        for (let i = 0; i < mesh.n; i++) {
          const fi = match[i];
          if (fi < 0) continue;
          toThree(fp.pose(fi, local, [mesh.paper[2 * i], mesh.paper[2 * i + 1]], v), w);
          P[3 * i] = w.x; P[3 * i + 1] = w.y; P[3 * i + 2] = w.z;
        }
        minY = Math.min(minY, this.finishSheet(si, fp, index, local));
      });
      this.placeOnTable(minY);
      return;
    }
    if (!this.opts.physics) {
      // Exact rigid kinematics: the pose for this time, straight from the solved frames.
      this.simBudget = 0;
      fp.prepare(local);
      // Where no rigid motion keeps the paper apart, dissolve from the last clean pose to the next one
      // instead of letting paper pass through paper.
      const span = this.step < this.stepCount && !this.rewinding ? this.kin.spans[this.step]?.find(([a, b]) => this.t > a && this.t < b) : undefined;
      const v = new THREE.Vector3(), w = new THREE.Vector3();
      let minY = Infinity;
      const pose = (t: number, views: SheetView[]) => {
        const X = this.kin.frameAt(this.step, t);
        const lift = this.kin.stackAt(this.step, t);
        X.forEach((Xs, si) => {
          const raw = this.kin.positions(si, Xs);
          const P = views[si].pos;
          for (let i = 0; i < raw.length / 3; i++) {
            fp.tilt(local, v.set(raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]));
            toThree(v, w);
            P[3 * i] = w.x; P[3 * i + 1] = w.y; P[3 * i + 2] = w.z;
          }
          // The lift is a direction in paper-world space: carry it through the same tilt and axes.
          let L = lift?.[si];
          if (L) {
            const o = fp.tilt(local, v.set(0, 0, 0)).clone(), q = new THREE.Vector3(), r = new THREE.Vector3();
            const out = new Float32Array(L.length);
            for (let f = 0; f < L.length / 3; f++) {
              if (!L[3 * f] && !L[3 * f + 1] && !L[3 * f + 2]) continue;
              fp.tilt(local, q.set(L[3 * f], L[3 * f + 1], L[3 * f + 2])).sub(o);
              toThree(q, r);
              out[3 * f] = r.x; out[3 * f + 1] = r.y; out[3 * f + 2] = r.z;
            }
            L = out;
          }
          minY = Math.min(minY, this.finishSheet(si, fp, index, local, views[si], L));
        });
      };
      if (span) {
        const e = smooth(span[0], span[1], this.t);
        pose(span[1], this.sheets);
        pose(span[0], this.ghosts);
        this.sheets.forEach((sv) => sv.setOpacity(e));
        this.ghosts.forEach((sv) => sv.setOpacity(1 - e));
      } else {
        pose(this.t, this.sheets);
        this.sheets.forEach((sv) => sv.setOpacity(1));
        this.ghosts.forEach((sv) => sv.setOpacity(0));
      }
      this.placeOnTable(minY);
      return;
    }
    if (this.step < this.stepCount && this.sim.loadFrame(this.step, this.t)) {
      // Replaying the recorded fold: exact and repeatable, no solver needed.
      iters = 0;
      this.simBudget = 0;
    } else if (this.step >= this.stepCount || !this.model.steps[this.step].phases.length) {
      // At rest: the cached state is already settled.
      iters = 0;
      this.simBudget = 0;
    } else if (iters > 0) {
      const speed = this.sim.iterate(iters);
      this.simBudget -= iters;
      if (speed < 4e-4 && !this.playing) this.simBudget = Math.min(this.simBudget, 0);
    }
    fp.prepare(local);
    // Shaped (3D) models are placed by their anchor faces, so the base stays put while walls rise.
    const anchored = fp.faces.some((f) => f.k);
    const hasStill = !anchored && (fp.phase.motion === 'hinge' || fp.phase.motion === 'crease') && fp.faces.some((f) => f.d === 0) && fp.faces.some((f) => f.d !== 0);
    // Mid-fold, place the paper by the parts that stay still. Blend that in and out at the ends of the
    // phase, where every face is at rest, so the placement never jumps between phases or steps.
    const lowW = 1 - 0.98 * smooth(0, 0.18, local) * (1 - smooth(0.82, 1, local));
    const still = (fi: number) => (anchored ? (fp.faces[fi].k ? 1 : 0.02) : hasStill ? (fp.faces[fi].d === 0 ? 1 : lowW) : 1);
    let minY = Infinity;
    const ends = this.chainEnds();
    const e = ease(this.t);
    this.sim.solvers.forEach((sv, si) => {
      const placed = this.fitToPose(si, sv.x, fp, index, local, still);
      if (ends) {
        // A collapse starts and ends exactly on the flat pose; the simulation only fills in the middle.
        const { c0, c1 } = ends[si];
        for (let k = 0; k < placed.length; k++) placed[k] += c0[k] * (1 - e) + c1[k] * e;
      }
      this.sheets[si].pos.set(placed);
      minY = Math.min(minY, this.finishSheet(si, fp, index, local));
    });
    this.placeOnTable(minY);
  }

  private ends: { step: number; c: { c0: Float64Array; c1: Float64Array }[] } | null = null;
  /**
   * For a simulated step next to exactly drawn ones: per vertex, how far the simulated paper at the
   * start (and end) of the step is from the exact flat pose. Blending these out keeps that end exact,
   * so the simulated step meets the exactly drawn steps before and after it without a jump.
   */
  private chainEnds(): { c0: Float64Array; c1: Float64Array }[] | null {
    if (this.exact || this.step >= this.stepCount || !this.opts.physics) return null;
    const atStart = this.step === 0 || this.exactStep(this.step - 1), atEnd = this.exactStep(this.step + 1);
    if (!atStart && !atEnd) return null;
    const F = this.sim.frames[this.step];
    if (!F || F.length < 2) return null;
    if (this.ends?.step === this.step) return this.ends.c;
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    const corr = (si: number, pi: number, t: number, X: Float64Array) => {
      const fp = this.phases[pi];
      fp.prepare(t);
      const placed = this.fitToPose(si, X, fp, pi, t, () => 1);
      const mesh = this.sim.meshes[si], match = this.vertMatch[si][pi];
      const c = new Float64Array(placed.length);
      for (let i = 0; i < mesh.n; i++) {
        const fi = match[i];
        if (fi < 0) continue;
        toThree(fp.pose(fi, t, [mesh.paper[2 * i], mesh.paper[2 * i + 1]], v), w);
        c[3 * i] = w.x - placed[3 * i]; c[3 * i + 1] = w.y - placed[3 * i + 1]; c[3 * i + 2] = w.z - placed[3 * i + 2];
      }
      return c;
    };
    const last = this.phases.length - 1;
    const zero = (si: number) => new Float64Array(3 * this.sim.meshes[si].n);
    const c = this.sim.meshes.map((_, si) => ({
      c0: atStart ? corr(si, 0, 0, F[0].x[si]) : zero(si),
      c1: atEnd ? corr(si, last, 1, F[F.length - 1].x[si]) : zero(si),
    }));
    this.ends = { step: this.step, c };
    return c;
  }

  /** Adds layer thickness to sheet si's placed positions, updates its creases, and returns its lowest point. */
  private finishSheet(si: number, fp: FlatPhase, index: number, local: number, sh = this.sheets[si], lift?: Float32Array): number {
    const mesh = this.sim.meshes[si], n = mesh.n, T = mesh.tris, nt = T.length / 3;
    const P = sh.pos;
    const faceMatch = this.faceMatch[si][Math.min(index, this.faceMatch[si].length - 1)];
    // Layers that lie flat on each other would z-fight or cross. Lift each crease-pattern face off
    // the layers below it, as one rigid piece, along its own "up" (the side that faced up in the
    // flat diagram).
    const e = ease(local), off = this.layerGap;
    const nf = faceMatch.length;
    const fOff = new Float32Array(3 * nf), fSet = new Uint8Array(nf);
    for (let k = 0; k < nt; k++) {
      const cf = mesh.triFace[k];
      if (fSet[cf]) continue;
      const fi = faceMatch[cf];
      if (fi < 0) continue;
      const f = fp.faces[fi];
      const moving = f.d !== 0 && fp.phase.motion !== 'none';
      // A moving flap turns over as a rigid stack: keep its start order until halfway, then its end order.
      const dep = moving ? (e > 0.5 ? fp.depthB[fi] : fp.depthA[fi]) : fp.depthA[fi] + (fp.depthB[fi] - fp.depthA[fi]) * e;
      // A collapse turns faces over too (each about its own hinges), so its second half uses the end side.
      const det0 = det((moving || fp.phase.motion === 'chain') && e > 0.5 ? f.b : f.a) > 0 ? 1 : -1;
      const a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
      const qx = P[3 * c] - P[3 * a], qy = P[3 * c + 1] - P[3 * a + 1], qz = P[3 * c + 2] - P[3 * a + 2];
      const nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) continue;
      const sc = (det0 * dep * off) / nl;
      fOff[3 * cf] = nx * sc; fOff[3 * cf + 1] = ny * sc; fOff[3 * cf + 2] = nz * sc;
      fSet[cf] = 1;
    }
    // Faces that came to lie on each other in 3D: lift them apart in the order they met.
    if (lift) {
      const g = off * 1.5;
      for (let f = 0; f < nf; f++) { fOff[3 * f] += lift[3 * f] * g; fOff[3 * f + 1] += lift[3 * f + 1] * g; fOff[3 * f + 2] += lift[3 * f + 2] * g; }
    }
    let minY = Infinity;
    const R = sh.rpos, rv = sh.rvert, rf = sh.rface;
    const acc = new Float32Array(3 * n), cnt = new Float32Array(n);
    for (let r = 0; r < rv.length; r++) {
      const v = rv[r], cf = rf[r];
      const x = P[3 * v] + fOff[3 * cf], y = P[3 * v + 1] + fOff[3 * cf + 1], z = P[3 * v + 2] + fOff[3 * cf + 2];
      R[3 * r] = x; R[3 * r + 1] = y; R[3 * r + 2] = z;
      acc[3 * v] += x; acc[3 * v + 1] += y; acc[3 * v + 2] += z; cnt[v]++;
      if (y < minY) minY = y;
    }
    // Crease lines sit where the faces beside them meet.
    for (let i = 0; i < n; i++) if (cnt[i]) { P[3 * i] = acc[3 * i] / cnt[i]; P[3 * i + 1] = acc[3 * i + 1] / cnt[i]; P[3 * i + 2] = acc[3 * i + 2] / cnt[i]; }
    // Coloured creases: none while unfolding back; last step's fade out within 0.1 s of a new step.
    const fadeIn = this.step >= this.stepCount ? 1 : Math.min(1, (performance.now() - this.shownAt) / 100);
    sh.showCreases(this.born[si], this.step, this.step >= this.stepCount ? 0 : index, this.step >= this.stepCount ? 1 : local,
      this.rewinding ? undefined : this.kinds[si], fadeIn);
    sh.drawFresh(this.model.extent);
    sh.geo.attributes.position.needsUpdate = true;
    sh.posAttr.needsUpdate = true;
    sh.geo.computeBoundingSphere();
    return minY;
  }

  /**
   * Valley or mountain for each crease, as the diagram of the step that makes it shows it: the fold's
   * direction seen from the side of the paper facing up on the face that stays still.
   */
  private creaseKinds(si: number): Int8Array {
    const mesh = this.sim.meshes[si], born = this.born[si], nh = mesh.hingeCrease.length;
    const out = new Int8Array(nh);
    for (let h = 0; h < nh; h++) {
      if (!mesh.hingeCrease[h] || born[h] >= 1e9 || born[h] < 0) continue;
      const s = Math.floor(born[h] / 64), p = born[h] % 64;
      const A = this.sim.angles[s]?.[p], ph = this.model.steps[s]?.phases[p];
      if (!A || !ph) continue;
      const end = A.b[si][h], mid = A.mid?.[si][h] ?? 0;
      const ang = Math.abs(mid) > Math.abs(end) ? mid : end;
      if (Math.abs(ang) < 1e-3) continue;
      const fl = mesh.hingeFaces[2 * h], fr = mesh.hingeFaces[2 * h + 1];
      const pl = ph.faces[A.match[si][fl]], pr = ph.faces[A.match[si][fr]];
      const still = pl && (pl.d === 0 || !pr) ? pl : pr ?? pl;
      if (!still) continue;
      const up = det(still.a) > 0 ? 1 : -1;
      out[h] = ph.motion === 'crease' ? 2 : ang * up < 0 ? 1 : -1;
    }
    return out;
  }

  /** Keeps the paper clear of the table. */
  private placeOnTable(minY: number) {
    // The height is a smooth function of the time through the model (each step's need, blended
    // across the step), never below what the paper needs right now, so scrubbing back and forth
    // gives exactly the same picture every time.
    const need = isFinite(minY) ? -minY + this.model.extent * 0.012 : 0;
    const a = this.stepFloor(this.step), b = this.stepFloor(Math.min(this.stepCount, this.step + 1));
    this.lift = Math.max(a + (b - a) * ease(this.t), need);
    this.model3d.position.y = this.lift;
    this.overlays.position.y = this.lift;
    this.dirty = true;
  }

  setT(t: number) {
    this.t = Math.max(0, Math.min(1, t));
    this.playing = false;
    this.rewinding = null;
    this.applyT();
  }

  /** Plays the current step from the start. `speed` 1 is normal; lower is slower. */
  play(speed = 1) {
    this.t = 0;
    this.rewinding = null;
    this.phaseSeconds = 1.6 / speed;
    if (this.step < this.stepCount && this.opts.physics) this.sim.load(this.sim.stateAt(this.step));
    this.playing = true;
    this.applyT();
  }

  /**
   * Plays the current step backwards from where it is to its start (quicker than playing it), then
   * calls `then`. Used for replays and for going back a step, so folds unfold instead of vanishing.
   */
  rewind(then?: () => void) {
    if (this.t <= 0) { then?.(); return; }
    this.rewinding = { from: this.t, then };
    this.playing = false;
  }

  stop() { this.playing = false; this.rewinding = null; }

  setColors(colors: Colors) {
    this.colors = colors;
    [...this.sheets, ...this.ghosts].forEach((s) => { const c = colors[s.mesh.sheet]; if (c) s.setColors(c); });
    this.dirty = true;
  }

  private framing(spec: CameraSpec) {
    const box = new THREE.Box3();
    for (const v of this.phases) box.union(v.bounds());
    // Include the simulated paper as it is now (its folds rest a little open, so it can be bigger).
    for (const sh of this.sheets) {
      const P = sh.pos;
      for (let i = 0; i < P.length; i += 3) box.expandByPoint(new THREE.Vector3(P[i], P[i + 1], P[i + 2]));
    }
    // The simulated paper rests on the table, a little above the flat pose.
    const center = box.getCenter(new THREE.Vector3());
    center.y = Math.max(0, (box.max.y - box.min.y) / 2) + this.model.extent * 0.03;
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, this.model.extent * 0.3);
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.5, Math.min(this.camera.aspect, 1.6));
    // Fit the model's bounding sphere with a comfortable margin (more for the page, which has
    // controls round the edges; less for thumbnails, which have none).
    const margin = this.opts.thumbnail ? 1.08 : this.opts.spin ? 1.2 : 1.45;
    const dist = (radius / Math.sin(fov / 2)) * (aspect < 1 ? margin / aspect : margin) / (spec.zoom ?? 1);
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

  /** Height the paper needs above the table at the start of step i, from the exact pose over the step before it and itself. */
  private stepFloor(i: number): number {
    const hit = this.floors.get(i);
    if (hit !== undefined) return hit;
    let minY = 0;
    for (const k of [i - 1, i]) {
      const st = this.model.steps[k];
      if (!st) continue;
      for (const ph of st.phases) {
        const fp = new FlatPhase(ph, this.thick);
        minY = Math.min(minY, fp.bounds().min.y);
        fp.dispose();
      }
    }
    const v = -minY + this.model.extent * 0.012;
    this.floors.set(i, v);
    return v;
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
    if (this.rewinding) {
      // Unfolding back is quick: a third of the time playing takes, and at most 0.7 seconds. Folds that
      // were made and unfolded (creases) end where they began, so they are skipped, not shown again.
      const n = this.phases.length, real = this.phases.filter((p) => p.phase.motion !== 'crease').length;
      const dur = Math.min(0.7, (this.phaseSeconds * Math.max(1, real)) / 3);
      this.t = Math.max(0, this.t - (dt / dur) * (real / n || 1));
      for (let k = n - 1; k >= 0; k--) {
        if (this.phases[k].phase.motion === 'crease' && this.t > k / n && this.t < (k + 1) / n + 1e-9) this.t = k / n;
      }
      this.applyT();
      if (this.t <= 0) { const then = this.rewinding.then; this.rewinding = null; then?.(); }
    }
    if (this.playing) {
      const dur = this.phaseSeconds * this.phases.length;
      this.t = Math.min(1, this.t + dt / dur);
      this.applyT();
      if (this.t >= 1) { this.playing = false; this.opts.onEnd?.(); }
    }
    // Keep drawing while last step's coloured creases fade out.
    if (time - this.shownAt < 160 && !this.playing && !this.rewinding) this.simBudget = Math.max(this.simBudget, 1);
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
    this.updateMesh(0);
    this.controls.update();
    this.fitDepth();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const p of this.phases) p.dispose();
    for (const s of [...this.sheets, ...this.ghosts]) s.dispose();
    this.table.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.spinHint.remove();
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
