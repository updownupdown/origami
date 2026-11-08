import type { Mat, V2 } from './geometry.ts';

// ---------- Authored model script (YAML) ----------

export type PointExpr = string | [number, number];

export interface LineSpec {
  /** Axiom 1: line through two points. */
  through?: PointExpr | [PointExpr, PointExpr];
  /** Axiom 2: bring one point onto another (perpendicular bisector). */
  bring?: PointExpr | [PointExpr, PointExpr];
  to?: PointExpr;
  /** Axiom 3: bring line `bring` onto line `onto` (angle bisector). Axiom 5/7: bring point onto line. */
  onto?: [PointExpr, PointExpr];
  /** Axiom 4 / 7: perpendicular to this line. */
  perpendicular?: [PointExpr, PointExpr];
  /** Pick between two solutions (axioms 3 and 5). */
  pick?: number;
}

/** Which layers at the move point start the fold. 'outer' takes the top and bottom layers (a neck pulled out between the body layers). */
export type LayerChoice = 'all' | 'top' | 'bottom' | 'outer';

export interface FoldOp {
  fold?: 'valley' | 'mountain';
  crease?: 'valley' | 'mountain';
  unfold?: true;
  reverse?: 'inside' | 'outside';
  line?: LineSpec | [PointExpr, PointExpr];
  /** A point on the side that moves. */
  move?: PointExpr;
  layers?: LayerChoice;
  sheet?: string;
}

export interface TurnOverOp {
  'turn-over': 'vertical' | 'horizontal' | true;
}
export interface RotateOp {
  rotate: number;
}
export interface GridOp {
  /** Pre-crease a grid of n×n divisions (valley from the side facing up), optional diagonals. */
  grid: { n: number; m?: number; kind?: 'valley' | 'mountain'; diagonals?: 'none' | 'one' | 'both' };
  sheet?: string;
}
export interface CollapseOp {
  /** Fold several creases at once. Each crease is a segment in paper coordinates of the sheet. */
  collapse: {
    valley?: [PointExpr, PointExpr][];
    mountain?: [PointExpr, PointExpr][];
    /** A paper point on the face that stays still. */
    fixed?: PointExpr;
  };
  sheet?: string;
}
export interface PlaceOp {
  /** Move a whole sheet: translate / rotate / flip, and stack it above or below another sheet. */
  place: {
    sheet: string;
    /** Bring this point of the sheet (world, before moving) ... */
    point?: PointExpr;
    /** ... onto this point (world). */
    to?: PointExpr;
    rotate?: number;
    flip?: boolean;
    layer?: 'above' | 'below';
  };
}
export interface MarkOp {
  /** Name a point (evaluated in world space, stored on the paper) for later steps. */
  mark: Record<string, PointExpr>;
}

export type Op = FoldOp | TurnOverOp | RotateOp | GridOp | CollapseOp | PlaceOp | MarkOp;

export type CameraPreset = 'top' | 'three-quarter' | 'front' | 'side' | 'bottom' | 'hero';
export interface CameraSpec {
  preset?: CameraPreset;
  azimuth?: number;
  elevation?: number;
  zoom?: number;
}

export interface StepSpec extends Partial<FoldOp> {
  text?: string;
  camera?: CameraPreset | CameraSpec;
  ops?: Op[];
  use?: string;
  /** Repeat a referenced step group with these extra ops. */
  'turn-over'?: TurnOverOp['turn-over'];
  rotate?: number;
  grid?: GridOp['grid'];
  collapse?: CollapseOp['collapse'];
  place?: PlaceOp['place'];
  mark?: MarkOp['mark'];
  /** Name fixed points in space (they stay put when the paper moves). */
  pin?: Record<string, PointExpr>;
  /** Tip shown under the step text. */
  tip?: string;
}

export interface MaterialSpec {
  id: string;
  name?: string;
  shape?: 'square' | 'rectangle';
  /** Size in cm: "15" for a square, "15x7.5" for a rectangle (width x height). */
  size: string | number;
  colors?: { front?: string; back?: string };
  /** Which side faces up at the start. Most models start with the coloured (front) side down. */
  start?: 'front-up' | 'back-up';
  /** Start turned 45° as a diamond: A is the top corner, then B, C, D clockwise. */
  diamond?: boolean;
  /** Where the sheet sits before it is placed (cm, world). */
  at?: [number, number];
  count?: number;
  note?: string;
}

export interface Credit {
  designer: string;
  designerUrl?: string;
  /** Where the design or instructions come from. */
  sources?: { label: string; url: string }[];
  /** Who wrote the fold script for this site. */
  script?: string;
  license?: string;
  note?: string;
}

export interface ModelScript {
  id: string;
  title: string;
  /** Group of related variants, e.g. "rabbit". */
  family?: string;
  variant?: string;
  aliases?: string[];
  categories: string[];
  tags?: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  description?: string;
  credits: Credit;
  materials: MaterialSpec[];
  tools?: string[];
  steps: StepSpec[];
  /** Camera for the finished model and thumbnail. */
  finish?: { camera?: CameraPreset | CameraSpec; text?: string };
  /** Bases are reusable step groups, not listed as models. */
  kind?: 'model' | 'base';
}

// ---------- Compiled output ----------

export interface Face {
  id: number;
  sheet: string;
  /** Polygon in paper coordinates (cm), counter-clockwise. */
  poly: V2[];
  m: Mat;
  layer: number;
}

export interface SheetInfo {
  id: string;
  name: string;
  w: number;
  h: number;
  front: string;
  back: string;
  count: number;
  note?: string;
}

export type MotionKind = 'hinge' | 'crease' | 'spin' | 'chain' | 'move' | 'none';

export interface PhaseFace {
  id: number;
  s: string;
  /** Paper polygon, flat [x0, y0, x1, y1, ...]. */
  p: number[];
  a: Mat;
  b: Mat;
  la: number;
  lb: number;
  /** Hinge direction: +1 rotates up (towards +z), -1 down, 0 static. */
  d: number;
  /** For chain motion: index of parent face in this phase, crease (paper coords) and signed angle. */
  parent?: number;
  hinge?: [number, number, number, number];
  ang?: number;
}

export interface DiagramLine {
  kind: 'valley' | 'mountain' | 'crease';
  p: V2;
  q: V2;
}

export interface DiagramArrow {
  kind: 'valley' | 'mountain' | 'turn-over' | 'rotate' | 'reverse';
  from: V2;
  to: V2;
}

export interface Phase {
  motion: MotionKind;
  axis?: [V2, V2];
  center?: V2;
  angle?: number;
  faces: PhaseFace[];
  lines: DiagramLine[];
  arrows: DiagramArrow[];
}

export interface CompiledStep {
  text: string;
  tip?: string;
  group?: string;
  camera: CameraSpec;
  phases: Phase[];
}

export interface CompiledModel {
  id: string;
  title: string;
  family?: string;
  variant?: string;
  aliases: string[];
  categories: string[];
  tags: string[];
  difficulty: number;
  description: string;
  credits: Credit;
  sheets: SheetInfo[];
  tools: string[];
  steps: CompiledStep[];
  finish: { camera: CameraSpec; text: string };
  /** Overall extents over all steps, for camera framing. */
  extent: number;
}
