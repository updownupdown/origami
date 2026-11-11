// Three.js renderer for compiled fold steps.
//
// Every step is posed the same way: rigid-origami kinematics (engine/kinematic.ts) turn the fold
// angles of the step's stored states into face positions (a plain fold is a hinge turning to 180°,
// a box wall one held at 90°), and engine/stack.ts gives each face its layer of paper thickness.
// The end of one step and the start of the next are the same state, so they look the same.
// Models built for the site carry their solved steps (CompiledModel.kin), so the browser only
// replays them; the editor solves live.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { CameraSpec, CompiledModel, Phase, PhaseFace } from '../engine/types';
import { stateBefore } from '../engine/svg';
import { FoldSim, type SimMesh } from '../engine/sim';
import { Kinematics } from '../engine/kinematic';

type V2 = [number, number];
const apply = (m: number[], p: V2): V2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const det = (m: number[]) => m[0] * m[3] - m[1] * m[2];
const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface Colors { [sheet: string]: { front: string; back: string } }

/** The diagram of one phase: its flat pose (for the arrows and lines drawn over the paper) and the model's tilt. */
class FlatPhase {
  faces: PhaseFace[];
  zPivot = 0;
  chain: THREE.Matrix4[] = [];
  overlay = new THREE.Group();

  constructor(public phase: Phase, public thick: number) {
    this.faces = phase.faces;
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

/** Line segments with a width in screen pixels (plain GL lines are one pixel wide: too faint to read). */
class FatLines {
  obj: LineSegments2;
  mat: LineMaterial;
  count = 0;
  private cap = 0;
  constructor(color: number, width: number, public base: number, depthTest = true) {
    this.mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity: base, depthTest, depthWrite: false });
    this.obj = new LineSegments2(new LineSegmentsGeometry(), this.mat);
    this.obj.frustumCulled = false;
    this.obj.visible = false;
  }
  /** Sets the segments: six numbers each (start x y z, end x y z). */
  set(data: ArrayLike<number>) {
    const n = Math.floor(data.length / 6), g = this.obj.geometry;
    if (n > this.cap) {
      this.cap = Math.max(n, this.cap * 2, 16);
      const arr = new Float32Array(this.cap * 6);
      arr.set(data);
      g.setPositions(arr);
    } else if (n) {
      const buf = (g.attributes.instanceStart as THREE.InterleavedBufferAttribute).data;
      (buf.array as Float32Array).set(data);
      buf.needsUpdate = true;
    }
    g.instanceCount = n;
    this.count = n;
    this.obj.visible = n > 0;
  }
  dispose() { this.obj.geometry.dispose(); this.mat.dispose(); }
}

/**
 * Edges drawn by the paper's own shader: a dark line just inside every paper edge and along every
 * crease, a fixed number of screen pixels wide whatever the angle. Being part of the surface, a line
 * is hidden exactly when its paper is, and layers of the same colour stay apart to the eye.
 */
const EDGE_PARS = `
uniform vec3 uInk;
uniform float uPx;
varying vec3 vBary; varying vec3 vEdge; varying vec3 vRayA; varying vec3 vRayB; varying vec3 vRayEA; varying vec3 vRayEB;
// f: three functions that fall to 0 on a line each; e: how strongly each line is drawn (-1: not at all).
float inkOf(vec3 f, vec3 e) {
  vec3 px = f / max(sqrt(dFdx(f) * dFdx(f) + dFdy(f) * dFdy(f)), vec3(1e-6)) / uPx;
  vec3 wd = 0.7 + 0.95 * e;
  vec3 ln = (1.0 - smoothstep(wd - 0.55, wd + 0.55, px)) * step(-0.5, e) * (0.26 + 0.6 * e);
  return max(ln.x, max(ln.y, ln.z));
}
`;
const EDGE_GLSL = `outgoingLight = mix(outgoingLight, uInk, max(inkOf(vBary, vEdge), max(inkOf(vRayA, vRayEA), inkOf(vRayB, vRayEB))));`;
const INK_DARK = new THREE.Color(0x2b2a28), INK_LIGHT = new THREE.Color(0xf6f1e7);
/** Ink that shows on a paper colour: dark, or light on very dark paper. */
const inkFor = (c: THREE.Color) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.035 ? INK_LIGHT : INK_DARK);

/** One sheet's simulated mesh in the scene. */
class SheetView {
  geo = new THREE.BufferGeometry();
  front: THREE.Mesh;
  back: THREE.Mesh;
  /** Coloured creases (the folds of this step). */
  lines = new THREE.Group();
  /** Positions of the mesh vertices (used for the crease lines and framing). */
  pos: Float32Array;
  /**
   * The drawn surface has its own copy of each vertex per triangle, so every face can be lifted off
   * the layers below it as one rigid piece (no kinks inside a face) and each triangle knows which of
   * its sides are edges of the paper.
   */
  rpos: Float32Array;
  /** For each drawn vertex: its mesh vertex, and its crease-pattern face. */
  rvert: Int32Array;
  rface: Int32Array;
  /** Per triangle side (opposite each corner): -2 nothing to draw, -1 an edge of the paper, else the crease's hinge. */
  private triEdge: Int32Array;
  private edge: Float32Array;
  private edgeAttr: THREE.BufferAttribute;
  /** Creases made so far (and not being shown in colour), per hinge; and all made so far. */
  private creaseOn: Uint8Array;
  private bornNow: Uint8Array;
  private around: { ang: number; code: number }[][];
  /**
   * Lines that end at a corner of a triangle without being one of its sides (see `aimRays`): per
   * triangle, six of them (two per corner): which line, then per drawn vertex how far it is from each
   * line, and how strongly each is drawn.
   */
  private rayCode: Int32Array;
  private ray: Float32Array;
  private rayE: Float32Array;
  private rayBuf!: THREE.InterleavedBuffer;
  private rayEBuf!: THREE.InterleavedBuffer;
  private rayKey = '';
  private inks = [{ value: INK_DARK.clone() }, { value: INK_DARK.clone() }];
  /** Device pixels per CSS pixel, so lines are as wide on every screen. */
  px = { value: 1 };
  constructor(public mesh: SimMesh, colors: { front: string; back: string }) {
    this.pos = new Float32Array(mesh.n * 3);
    const key = new Map<number, number>(), rv: number[] = [], rf: number[] = [], idx: number[] = [];
    const nf = Math.max(1, ...Array.from(mesh.triFace)) + 1, nt = mesh.tris.length / 3;
    for (let k = 0; k < mesh.tris.length; k++) {
      const v = mesh.tris[k], f = mesh.triFace[Math.floor(k / 3)], kk = v * nf + f;
      if (!key.has(kk)) key.set(kk, k);
      rv.push(v); rf.push(f); idx.push(k);
    }
    // Paper is continuous: where the faces either side of a crease sit at different layers, a thin
    // strip joins them (the rounded edge of a fold in real paper). It is wound like the face on its
    // left continued across the crease, so its front and back colours are the paper's own.
    for (let h = 0; h < mesh.hingeCrease.length; h++) {
      if (!mesh.hingeCrease[h]) continue;
      const a = mesh.hinges[4 * h], b = mesh.hinges[4 * h + 1], fl = mesh.hingeFaces[2 * h], fr = mesh.hingeFaces[2 * h + 1];
      if (fl < 0 || fr < 0 || fl === fr) continue;
      if (![a * nf + fl, b * nf + fl, a * nf + fr, b * nf + fr].every((q) => key.has(q))) continue;
      const o = rv.length;
      rv.push(a, b, a, b); rf.push(fl, fl, fr, fr);
      idx.push(o + 1, o, o + 2, o + 1, o + 2, o + 3);
    }
    this.rvert = Int32Array.from(rv);
    this.rface = Int32Array.from(rf);
    this.rpos = new Float32Array(rv.length * 3);
    // Which sides of each triangle are lines of the paper.
    const kind = new Map<number, number>();
    for (let k = 0; k < mesh.lineKind.length; k++) {
      const a = mesh.lines[2 * k], b = mesh.lines[2 * k + 1];
      kind.set(Math.min(a, b) * mesh.n + Math.max(a, b), mesh.lineKind[k] === 2 ? -1 : mesh.lineKind[k] === 1 ? mesh.lineHinge[k] : -2);
    }
    this.triEdge = new Int32Array(3 * nt);
    for (let k = 0; k < nt; k++) for (let j = 0; j < 3; j++) {
      const a = mesh.tris[3 * k + (j + 1) % 3], b = mesh.tris[3 * k + (j + 2) % 3];
      this.triEdge[3 * k + j] = kind.get(Math.min(a, b) * mesh.n + Math.max(a, b)) ?? -2;
    }
    // The lines of the paper that meet at each vertex, by direction on the flat sheet.
    this.around = Array.from({ length: mesh.n }, () => []);
    for (let k = 0; k < mesh.lineKind.length; k++) {
      const a = mesh.lines[2 * k], b = mesh.lines[2 * k + 1], code = mesh.lineKind[k] === 2 ? -1 : mesh.lineHinge[k];
      const dx = mesh.paper[2 * b] - mesh.paper[2 * a], dy = mesh.paper[2 * b + 1] - mesh.paper[2 * a + 1];
      this.around[a].push({ ang: Math.atan2(dy, dx), code });
      this.around[b].push({ ang: Math.atan2(-dy, -dx), code });
    }
    this.rayCode = new Int32Array(6 * nt).fill(-2);
    this.ray = new Float32Array(rv.length * 6).fill(1);
    this.rayE = new Float32Array(rv.length * 6).fill(-1);
    this.bornNow = new Uint8Array(mesh.hingeCrease.length);
    this.creaseOn = new Uint8Array(mesh.hingeCrease.length);
    // Each corner of a triangle is 1 on its own coordinate and 0 on the others, so a coordinate
    // falls to 0 on the side opposite its corner. (Strips have no lines: they stay at 1.)
    const bary = new Float32Array(rv.length * 3).fill(1);
    for (let k = 0; k < 3 * nt; k++) for (let j = 0; j < 3; j++) bary[3 * k + j] = k % 3 === j ? 1 : 0;
    this.edge = new Float32Array(rv.length * 3).fill(-1);
    this.edgeAttr = new THREE.BufferAttribute(this.edge, 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.rpos, 3));
    this.geo.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
    this.geo.setAttribute('aEdge', this.edgeAttr);
    const ray = new THREE.InterleavedBuffer(this.ray, 6), rayE = new THREE.InterleavedBuffer(this.rayE, 6);
    this.geo.setAttribute('aRayA', new THREE.InterleavedBufferAttribute(ray, 3, 0));
    this.geo.setAttribute('aRayB', new THREE.InterleavedBufferAttribute(ray, 3, 3));
    this.geo.setAttribute('aRayEA', new THREE.InterleavedBufferAttribute(rayE, 3, 0));
    this.geo.setAttribute('aRayEB', new THREE.InterleavedBufferAttribute(rayE, 3, 3));
    this.rayBuf = ray; this.rayEBuf = rayE;
    this.geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const mk = (color: string, side: THREE.Side, ink: { value: THREE.Color }) => {
      const m = new THREE.MeshStandardMaterial({
        color, side, flatShading: true, roughness: 0.92, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      ink.value = inkFor(m.color);
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uInk = ink;
        sh.uniforms.uPx = this.px;
        sh.vertexShader = 'attribute vec3 aBary; attribute vec3 aEdge; attribute vec3 aRayA; attribute vec3 aRayB; attribute vec3 aRayEA; attribute vec3 aRayEB;\n' +
          'varying vec3 vBary; varying vec3 vEdge; varying vec3 vRayA; varying vec3 vRayB; varying vec3 vRayEA; varying vec3 vRayEB;\n' +
          sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBary = aBary; vEdge = aEdge; vRayA = aRayA; vRayB = aRayB; vRayEA = aRayEA; vRayEB = aRayEB;');
        sh.fragmentShader = EDGE_PARS + sh.fragmentShader.replace('#include <opaque_fragment>', EDGE_GLSL + '\n#include <opaque_fragment>');
      };
      return m;
    };
    this.front = new THREE.Mesh(this.geo, mk(colors.front, THREE.FrontSide, this.inks[0]));
    this.back = new THREE.Mesh(this.geo, mk(colors.back, THREE.BackSide, this.inks[1]));
    // Paper casts onto the table only: self-shadowing between layers a hair apart shows as acne.
    for (const m of [this.front, this.back]) { m.castShadow = true; m.receiveShadow = false; }
    // Creases made in this step are drawn dashed in their colour (valley, mountain, or crease-and-unfold)
    // until the next step, where they quickly fade back into plain creases.
    this.fresh = [...CREASE_STYLE, ...CREASE_STYLE].map((st) => {
      const l = new FatLines(st.color, 2.6, 0.95);
      l.mat.depthFunc = THREE.LessEqualDepth;
      l.obj.renderOrder = 2;
      this.lines.add(l.obj);
      return l;
    });
  }
  /** Coloured creases: valley, mountain, crease made this step, then the same made last step (fading). */
  private fresh: FatLines[];
  private freshSegs: number[][] = [[], [], [], [], [], []];
  private freshKey = '';
  private freshFade = 1;
  private opacity = 1;
  /**
   * Shows only the creases that have been made by now: those folded earlier, plus the ones the
   * current phase is folding once it has started. `born` is each hinge's first step * 64 + phase.
   * `kinds` colours the ones made this step (and last step's, fading out as `fadeIn` goes 0 to 1).
   */
  showCreases(born: Int32Array, step: number, phase: number, local: number, kinds?: Int8Array, fadeIn = 1) {
    const now = step * 64 + Math.min(phase, 63);
    const m = this.mesh;
    const fresh: number[][] = [[], [], [], [], [], []];
    this.creaseOn.fill(0);
    this.bornNow.fill(0);
    for (let k = 0; k < m.lineKind.length; k++) {
      if (m.lineKind[k] !== 1) continue;
      const b = born[m.lineHinge[k]];
      const on = b < now || (b === now && local > 0.04);
      if (on) this.bornNow[m.lineHinge[k]] = 1;
      const kind = on && kinds ? kinds[m.lineHinge[k]] : 0;
      let slot = -1;
      if (kind) {
        const bs = Math.floor(b / 64);
        slot = bs === step ? 0 : bs === step - 1 && fadeIn < 0.999 ? 3 : -1;
        if (slot >= 0) slot += kind === 1 ? 0 : kind === -1 ? 1 : 2;
      }
      // This step's creases are drawn only in colour; plain lines show through last step's as they fade.
      if (on && !(slot >= 0 && slot < 3)) this.creaseOn[m.lineHinge[k]] = 1;
      if (slot >= 0) fresh[slot].push(m.lines[2 * k], m.lines[2 * k + 1]);
    }
    const fk = fresh.map((f) => f.join(',')).join('|');
    if (fk !== this.freshKey) { this.freshKey = fk; this.freshSegs = fresh; }
    this.freshFade = fadeIn;
    const rk = this.creaseOn.join('') + this.bornNow.join('');
    if (rk !== this.rayKey) { this.rayKey = rk; this.aimRays(); }
  }

  /**
   * A line of the paper is drawn by the triangles it is a side of. A triangle that only touches the
   * line's end with a corner would leave a nick in it, so each corner also looks along the sheet
   * either way, across creases not made yet (the paper is still flat there), for the first line that
   * is drawn. How far a point is from that line is then known all over the triangle.
   */
  private aimRays() {
    const m = this.mesh, T = m.tris, P = m.paper, nt = T.length / 3, TAU = 2 * Math.PI;
    const norm = (a: number) => ((a % TAU) + TAU) % TAU;
    this.rayCode.fill(-2);
    for (let k = 0; k < nt; k++) for (let j = 0; j < 3; j++) {
      const J = T[3 * k + j], N = T[3 * k + (j + 1) % 3], Q = T[3 * k + (j + 2) % 3], L = this.around[J];
      const a0 = Math.atan2(P[2 * N + 1] - P[2 * J + 1], P[2 * N] - P[2 * J]), a1 = Math.atan2(P[2 * Q + 1] - P[2 * J + 1], P[2 * Q] - P[2 * J]);
      const reach = Math.PI - norm(a1 - a0) + 1e-6;
      for (const turn of [0, 1]) {
        // Clockwise from the triangle's first side, then anticlockwise from its second.
        let best = -1, bestD = Infinity, stop = Infinity;
        for (let i = 0; i < L.length; i++) {
          let d = turn ? norm(L[i].ang - a1) : norm(a0 - L[i].ang);
          if (d > TAU - 1e-6) d = 0;
          if (d > reach) continue;
          const c = L[i].code, made = c === -1 || !!this.bornNow[c], drawn = c === -1 || !!this.creaseOn[c];
          // The triangle's own side, or a fold in the way, ends the search; a drawn line is the find.
          if (made && (d < 1e-6 || !drawn)) stop = Math.min(stop, d);
          else if (drawn && d < bestD) { best = i; bestD = d; }
        }
        const s = 2 * j + turn;
        if (best < 0 || bestD >= stop) { for (let c = 0; c < 3; c++) this.ray[(3 * k + c) * 6 + s] = 1; continue; }
        this.rayCode[6 * k + s] = L[best].code;
        const ux = Math.cos(L[best].ang), uy = Math.sin(L[best].ang), sg = turn ? -1 : 1;
        for (let c = 0; c < 3; c++) {
          const V = T[3 * k + c];
          this.ray[(3 * k + c) * 6 + s] = Math.max(0, sg * (ux * (P[2 * V + 1] - P[2 * J + 1]) - uy * (P[2 * V] - P[2 * J])));
        }
      }
    }
    this.rayBuf.needsUpdate = true;
  }

  /**
   * Sets how strongly each line of the paper is drawn, from the faces' normals `fN` (three numbers per
   * crease-pattern face): edges of the paper at full strength, creases from faint (lying flat, a mark
   * on the paper) to full (folded right over, where the fold is an edge of the model).
   */
  drawEdges(fN: Float32Array) {
    const m = this.mesh, nh = m.hingeCrease.length, E = this.edge, te = this.triEdge;
    const hs = new Float32Array(nh).fill(-1);
    for (let h = 0; h < nh; h++) {
      if (!this.creaseOn[h]) continue;
      const a = 3 * m.hingeFaces[2 * h], b = 3 * m.hingeFaces[2 * h + 1];
      const cos = a < 0 || b < 0 ? 1 : fN[a] * fN[b] + fN[a + 1] * fN[b + 1] + fN[a + 2] * fN[b + 2];
      hs[h] = smooth(0, 0.7, (1 - cos) / 2);
    }
    for (let k = 0; k < te.length; k += 3) {
      for (let j = 0; j < 3; j++) {
        const c = te[k + j], v = c === -2 ? -1 : c === -1 ? 1 : hs[c];
        E[3 * k + j] = v; E[3 * (k + 1) + j] = v; E[3 * (k + 2) + j] = v;
      }
    }
    this.edgeAttr.needsUpdate = true;
    const R = this.rayE, rc = this.rayCode;
    for (let q = 0; q < rc.length; q++) {
      const c = rc[q], v = c === -2 ? -1 : c === -1 ? 1 : hs[c], k = Math.floor(q / 6), s = q % 6;
      R[(3 * k) * 6 + s] = v; R[(3 * k + 1) * 6 + s] = v; R[(3 * k + 2) * 6 + s] = v;
    }
    this.rayEBuf.needsUpdate = true;
  }

  /** Lays the coloured creases out as dashes along the paper as it is now (`size`: the model's extent). */
  drawFresh(size: number) {
    const P = this.pos;
    this.fresh.forEach((l, i) => {
      const segs = this.freshSegs[i];
      l.base = i < 3 ? 0.95 : 0.95 * (1 - this.freshFade);
      l.mat.opacity = l.base * this.opacity;
      if (!segs.length || (i >= 3 && this.freshFade >= 0.999)) { if (l.count) l.set([]); return; }
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
      l.set(out);
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
    this.opacity = o;
    for (const l of this.fresh) l.mat.opacity = l.base * o;
    this.front.visible = this.back.visible = this.lines.visible = o > 0.001;
    this.front.castShadow = this.back.castShadow = solid;
  }
  setColors(c: { front: string; back: string }) {
    [this.front, this.back].forEach((m, i) => {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.color.set(i ? c.back : c.front);
      this.inks[i].value = inkFor(mat.color);
    });
  }
  dispose() {
    this.geo.dispose();
    for (const l of this.fresh) l.dispose();
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
  /** Per sheet, the faces that stay where they are for the whole of this step (null: the whole model moves). */
  private still: Uint8Array[] | null = null;
  /** How far the resting model reaches below its own zero at the start and the end of this step. */
  private rest: [number, number] = [0, 0];
  /** First step that folds each crease, per sheet (creases appear only once they are made). */
  private born: Int32Array[] = [];
  /** Per sheet, per hinge: 1 valley, -1 mountain (as seen in the step that makes it), 0 none. */
  private kinds: Int8Array[] = [];
  /** True once the person has turned the camera themselves during this step. */
  userCamera = false;

  constructor(public el: HTMLElement, public model: CompiledModel, public opts: ViewerOptions) {
    this.colors = opts.colors;
    this.thick = model.extent * 0.0016;
    // Paper thickness: about 0.15 mm on a 15 cm sheet (real paper is about 0.1 mm), so stacked layers
    // read as separate sheets without the model looking like a block from the side.
    this.layerGap = model.extent * 0.001;
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
    this.kin.load(model.kin);
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
    for (const sv of [...(this.sheets ?? []), ...(this.ghosts ?? [])]) sv.px.value = this.renderer.getPixelRatio();
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
    } else {
      const faces = stateBefore(this.model, this.step);
      const lastTilt = this.model.steps.slice(0, this.step).reverse().flatMap((st) => st.phases.slice(-1))[0]?.tilt;
      const ph: Phase = { motion: 'none', faces: faces.map((f) => ({ ...f, a: f.b, la: f.lb, d: 0 })), lines: [], arrows: [] };
      if (lastTilt) ph.tilt = { ...lastTilt, a0: lastTilt.a1 };
      this.phases = [new FlatPhase(ph, this.thick)];
    }
    this.kin.ensureStep(this.step);
    this.phases.forEach((v, k) => this.buildOverlay(v, k));
    this.still = this.findStill();
    this.rest = [-Math.min(0, this.lowestAt(0)), -Math.min(0, this.lowestAt(1))];

    if (camera) this.userCamera = false;
    this.t = play ? 0 : finished || !phases.length ? 1 : 0;
    this.applyT();
    this.updateMesh(0);
    if (camera) this.bestAngle(!this.opts.thumbnail);
    this.playing = play && phases.length > 0;
    this.dirty = true;
  }

  /**
   * The diagram marks of a phase (fold lines and arrows), drawn on the paper as it really lies at the
   * start of the phase: each point of the flat diagram is carried onto the 3D paper under it.
   */
  private buildOverlay(v: FlatPhase, k: number) {
    const ph = v.phase, A = this.sim.angles[this.step]?.[k];
    if ((!ph.lines.length && !ph.arrows.length) || !A) return;
    const S = this.model.extent, t = k / this.phases.length;
    const pos = this.kin.posAt(this.step, t), levels = this.kin.levelsAt(this.step, t);
    // Every triangle of the paper where the diagram shows it.
    interface Tri { si: number; cf: number; v: number[]; la: number; up: number; d: number[] }
    const tris: Tri[] = [];
    this.sim.meshes.forEach((mesh, si) => {
      for (let q = 0; q < mesh.tris.length; q += 3) {
        const cf = mesh.triFace[q / 3], pf = ph.faces[A.match[si][cf]];
        if (!pf) continue;
        const vs = [mesh.tris[q], mesh.tris[q + 1], mesh.tris[q + 2]];
        const d = vs.flatMap((i) => apply(pf.a, [mesh.paper[2 * i], mesh.paper[2 * i + 1]]));
        tris.push({ si, cf, v: vs, la: pf.la, up: det(pf.a) > 0 ? 1 : -1, d });
      }
    });
    if (!tris.length) return;
    const bary = (T: Tri, p: V2): [number, number, number] => {
      const [x0, y0, x1, y1, x2, y2] = T.d;
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2) || 1e-12;
      const a = ((y1 - y2) * (p[0] - x2) + (x2 - x1) * (p[1] - y2)) / den;
      const b = ((y2 - y0) * (p[0] - x2) + (x0 - x2) * (p[1] - y2)) / den;
      return [a, b, 1 - a - b];
    };
    /** The top layer of paper under a point of the diagram (the nearest paper for a point off it). */
    const locate = (p: V2): Tri => {
      let best = tris[0], score = -Infinity;
      for (const T of tris) {
        const w = bary(T, p), m = Math.min(w[0], w[1], w[2]);
        const sc = m >= -1e-6 ? 1e6 + T.la : m;
        if (sc > score) { score = sc; best = T; }
      }
      return best;
    };
    const A3 = new THREE.Vector3(), B3 = new THREE.Vector3(), C3 = new THREE.Vector3();
    /** Where a point of the diagram is on triangle T, `raise` clear of the paper on the side the diagram shows; and that side's normal. */
    const place = (p: V2, T: Tri, raise: number): { at: THREE.Vector3; up: THREE.Vector3 } => {
      const P = pos[T.si], w = bary(T, p);
      A3.fromArray(P, 3 * T.v[0]); B3.fromArray(P, 3 * T.v[1]); C3.fromArray(P, 3 * T.v[2]);
      const n = B3.clone().sub(A3).cross(C3.clone().sub(A3)).normalize();
      const at = new THREE.Vector3().addScaledVector(A3, w[0]).addScaledVector(B3, w[1]).addScaledVector(C3, w[2]);
      at.addScaledVector(n, levels[T.si][T.cf] * this.layerGap + T.up * raise);
      // Tilt (a standing model) as at the start of the phase, then into the scene's axes.
      const tip = v.tilt(0, at.clone().addScaledVector(n, T.up));
      v.tilt(0, at);
      return { at: toThree(at), up: toThree(tip).sub(toThree(at.clone())).normalize() };
    };
    const group = v.overlay;
    for (const l of ph.lines) {
      // Valley (blue dashes), mountain (orange dash-dot), or a crease made and unfolded (purple dots).
      const st = CREASE_STYLE[ph.motion === 'crease' ? 2 : l.kind === 'mountain' ? 1 : 0];
      const len = Math.hypot(l.q[0] - l.p[0], l.q[1] - l.p[1]);
      if (len < 1e-6) continue;
      const at = (u: number): V2 => [l.p[0] + (l.q[0] - l.p[0]) * u, l.p[1] + (l.q[1] - l.p[1]) * u];
      const out: number[] = [];
      let d = 0, i = 0;
      while (d < len) {
        const seg = st.dash[i % st.dash.length] * S;
        if (i % 2 === 0) {
          const u0 = d / len, u1 = Math.min(len, d + seg) / len;
          // Both ends on the paper under the middle of the dash, so a dash never bridges a gap.
          const T = locate(at((u0 + u1) / 2));
          const a = place(at(u0), T, S * 0.001).at, b = place(at(u1), T, S * 0.001).at;
          out.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        d += seg;
        i++;
      }
      const fl = new FatLines(st.color, 3.2, 1, false);
      fl.set(out);
      fl.obj.renderOrder = 10;
      group.add(fl.obj);
    }
    for (const ar of ph.arrows) {
      if (ar.kind === 'rotate') continue; // shown as a flat arrow on the screen instead
      const a = place(ar.from, locate(ar.from), S * 0.004), b = place(ar.to, locate(ar.to), S * 0.004);
      const d = a.at.distanceTo(b.at);
      if (d < 1e-6) continue;
      const up = a.up.clone().add(b.up);
      if (up.lengthSq() < 1e-6) up.copy(a.up);
      up.normalize();
      // Bow the arrow sideways (as on a paper diagram) and lift it off the paper.
      const mid = a.at.clone().add(b.at).multiplyScalar(0.5);
      mid.addScaledVector(up.clone().cross(b.at.clone().sub(a.at)).normalize(), d * 0.28);
      if (ar.kind !== 'turn-over') mid.addScaledVector(up, d * 0.3);
      const curve = new THREE.QuadraticBezierCurve3(a.at, mid, b.at);
      const mat = new THREE.MeshBasicMaterial({ color: 0x2b2a28, transparent: true, depthTest: false });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, S * 0.0045, 6), mat);
      tube.renderOrder = 11;
      group.add(tube);
      const head = new THREE.Mesh(new THREE.ConeGeometry(S * 0.018, S * 0.045, 14), mat);
      head.position.copy(curve.getPoint(1));
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(1).normalize());
      head.renderOrder = 11;
      group.add(head);
    }
    this.overlays.add(group);
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

  /** Places the meshes for the current time, from the solved frames of the step. */
  private updateMesh(_iters = 0) {
    const { index, local } = this.current();
    const fp = this.phases[Math.min(index, this.phases.length - 1)];
    this.simBudget = 0;
    fp.prepare(local);
    // Where no rigid motion keeps the paper apart, dissolve from the last clean pose to the next one
    // instead of letting paper pass through paper.
    const span = this.step < this.stepCount && !this.rewinding ? this.kin.spans[this.step]?.find(([a, b]) => this.t > a && this.t < b) : undefined;
    const low: [number, number] = [Infinity, Infinity];
    const pose = (t: number, views: SheetView[]) => {
      const lay = this.layout(fp, local, t, views.map((sv) => sv.rpos));
      views.forEach((sv, si) => {
        const l = this.finishSheet(si, sv, lay[si]);
        low[0] = Math.min(low[0], l[0]); low[1] = Math.min(low[1], l[1]);
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
    this.placeOnMat(low[0], low[1]);
  }

  /**
   * Where every drawn vertex of every sheet is at time t of this step (`local`: the time through its
   * phase fp), written to R per sheet; returns each sheet's face normals. Each crease-pattern face is
   * placed whole by its own solved position, so a face that does not move is drawn exactly still
   * whatever its neighbours do (bent paper has no such position: it follows its solved vertices).
   * The model's tilt is applied, and each face sits its level of paper thicknesses off the paper along
   * its own front normal (stack.ts); the strips along the creases (SheetView) keep the paper joined.
   */
  private layout(fp: FlatPhase, local: number, t: number, R: Float32Array[]): Float32Array[] {
    const X = this.kin.rigidAt(this.step, t), raw = X ? null : this.kin.posAt(this.step, t);
    const levels = this.kin.levelsAt(this.step, t), off = this.layerGap;
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    return this.sheets.map((sh, si) => {
      const mesh = this.sim.meshes[si], rv = sh.rvert, rf = sh.rface, out = R[si], nf = mesh.faces.length;
      for (let r = 0; r < rv.length; r++) {
        const i = rv[r], x = mesh.paper[2 * i], y = mesh.paper[2 * i + 1];
        if (X) {
          const T = X[si], o = 12 * rf[r];
          v.set(T[o] * x + T[o + 1] * y + T[o + 9], T[o + 3] * x + T[o + 4] * y + T[o + 10], T[o + 6] * x + T[o + 7] * y + T[o + 11]);
        } else v.fromArray(raw![si], 3 * i);
        toThree(fp.tilt(local, v), w).toArray(out, 3 * r);
      }
      // Front normal of each face, from its first triangle (drawn vertices come three to a triangle).
      const N = new Float32Array(3 * nf), set = new Uint8Array(nf);
      for (let k = 0; k < mesh.triFace.length; k++) {
        const cf = mesh.triFace[k], a = 9 * k;
        if (set[cf]) continue;
        const ux = out[a + 3] - out[a], uy = out[a + 4] - out[a + 1], uz = out[a + 5] - out[a + 2];
        const qx = out[a + 6] - out[a], qy = out[a + 7] - out[a + 1], qz = out[a + 8] - out[a + 2];
        const nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx, nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) continue;
        N[3 * cf] = nx / nl; N[3 * cf + 1] = ny / nl; N[3 * cf + 2] = nz / nl;
        set[cf] = 1;
      }
      for (let r = 0; r < rv.length; r++) {
        const cf = rf[r], d = levels[si][cf] * off;
        out[3 * r] += N[3 * cf] * d; out[3 * r + 1] += N[3 * cf + 1] * d; out[3 * r + 2] += N[3 * cf + 2] * d;
      }
      return N;
    });
  }

  /**
   * Finishes sheet si once it is laid out: where its creases run, which lines are drawn and how
   * strongly. Returns the lowest point of the paper that stays still in this step, and of all of it
   * (see `placeOnMat`).
   */
  private finishSheet(si: number, sh: SheetView, N: Float32Array): [number, number] {
    const n = this.sim.meshes[si].n, P = sh.pos, R = sh.rpos, rv = sh.rvert, rf = sh.rface;
    const { index, local } = this.current();
    const still = this.still?.[si];
    let low = Infinity, lowAll = Infinity;
    // Crease lines sit where the faces beside them meet.
    const cnt = new Float32Array(n);
    P.fill(0);
    for (let r = 0; r < rv.length; r++) {
      const v = rv[r], y = R[3 * r + 1];
      P[3 * v] += R[3 * r]; P[3 * v + 1] += y; P[3 * v + 2] += R[3 * r + 2]; cnt[v]++;
      if (y < lowAll) lowAll = y;
      if (y < low && (!still || still[rf[r]])) low = y;
    }
    for (let i = 0; i < n; i++) if (cnt[i]) { P[3 * i] /= cnt[i]; P[3 * i + 1] /= cnt[i]; P[3 * i + 2] /= cnt[i]; }
    // Coloured creases: none while unfolding back; last step's fade out within 0.1 s of a new step.
    const fadeIn = this.step >= this.stepCount ? 1 : Math.min(1, (performance.now() - this.shownAt) / 100);
    sh.showCreases(this.born[si], this.step, this.step >= this.stepCount ? 0 : index, this.step >= this.stepCount ? 1 : local,
      this.rewinding ? undefined : this.kinds[si], fadeIn);
    sh.drawEdges(N);
    sh.drawFresh(this.model.extent);
    sh.geo.attributes.position.needsUpdate = true;
    sh.geo.computeBoundingSphere();
    return [low, lowAll];
  }

  /** Lowest point of the whole model, with its thickness, as it is drawn at time t of this step (before any lift). */
  private lowestAt(t: number): number {
    const n = this.phases.length, x = Math.min(t * n, n - 1e-9), index = Math.floor(x), local = t >= 1 ? 1 : x - index;
    const R = this.sheets.map((sh) => new Float32Array(sh.rpos.length));
    this.layout(this.phases[index], local, t, R);
    let low = Infinity;
    for (const A of R) for (let i = 1; i < A.length; i += 3) low = Math.min(low, A[i]);
    return isFinite(low) ? low : 0;
  }

  /**
   * The faces that do not move at all during this step, per sheet: the paper a folder would leave
   * lying on the table while folding the rest. Null when the whole model is picked up (turned over,
   * turned round, stood up) or when nothing stays still.
   */
  private findStill(): Uint8Array[] | null {
    if (this.step >= this.stepCount) return null;
    const phases = this.model.steps[this.step].phases, F = this.kin.frames[this.step];
    if (!phases.length || !F?.length) return null;
    if (phases.some((p) => p.motion === 'spin' || (p.tilt && Math.abs(p.tilt.a1 - p.tilt.a0) > 1e-6))) return null;
    const tol = 1e-4 * Math.max(1, this.model.extent);
    let any = false;
    const out = F[0].X.map((X0, si) => {
      const nf = X0.length / 12, st = new Uint8Array(nf).fill(1);
      for (const fr of F) {
        const X = fr.X[si];
        for (let f = 0; f < nf; f++) {
          if (!st[f]) continue;
          for (let k = 12 * f; k < 12 * f + 12; k++) if (Math.abs(X[k] - X0[k]) > tol) { st[f] = 0; break; }
        }
      }
      if (st.some((x) => x)) any = true;
      return st;
    });
    return any ? out : null;
  }

  /**
   * Rests the model on the mat. The paper that is not being folded never moves: a flap folded behind
   * swings down through the mat (it is a drawn grid, not a solid table) and comes to rest under the
   * model, as it would if you held the paper up to fold it. The model rises only when it has to end
   * up higher anyway (a wing opened downwards, the model stood up) or when the whole of it is picked
   * up (turned over): then by exactly what it needs at each moment. `still` is the lowest point of the
   * paper that stays still, `all` of the whole model.
   */
  private placeOnMat(still: number, all: number) {
    const [r0, r1] = this.rest, rest = r0 + (r1 - r0) * ease(this.t);
    const need = isFinite(all) ? -all : 0;
    const held = this.still ? Math.max(isFinite(still) ? -still : 0, Math.min(need, Math.max(r0, r1))) : need;
    this.lift = Math.max(rest, held) + this.model.extent * 0.012;
    this.model3d.position.y = this.lift;
    this.overlays.position.y = this.lift;
    this.dirty = true;
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

/**
 * The mat: a faint grid that fades out with distance and catches the model's shadow. It is a drawing,
 * not a solid: paper folded behind the model passes down through it and is seen under the grid.
 */
function makeTable(S: number, el: HTMLElement): THREE.Group {
  const g = new THREE.Group();
  const size = S * 8;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity: 0.16, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.receiveShadow = true;
  shadow.renderOrder = -2;
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
  grid.renderOrder = -3;
  grid.onBeforeRender = () => {
    const p = new THREE.Vector3();
    g.getWorldPosition(p);
    (gridMat.uniforms.uCenter.value as THREE.Vector2).set(p.x, p.z);
  };
  g.add(grid);
  return g;
}
