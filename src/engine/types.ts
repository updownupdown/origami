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
  /** 'both': the front layers fold towards you and the back layers away (both wings of a bird at once). */
  fold?: 'valley' | 'mountain' | 'both';
  crease?: 'valley' | 'mountain';
  unfold?: true;
  reverse?: 'inside' | 'outside';
  line?: LineSpec | [PointExpr, PointExpr];
  /** A point on the side that moves. */
  move?: PointExpr;
  layers?: LayerChoice;
  sheet?: string;
  /** Names the creases this fold makes, so a later `shape` step can open them to a 3D angle. */
  name?: string;
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
export interface RefoldOp {
  /**
   * Change several creases of an already folded sheet at once and fold it flat again: a squash fold,
   * a petal fold, a sink. Every point here is read on the unfolded sheet (the crease pattern), so a
   * named point means that point of the paper wherever it lies now.
   */
  refold: {
    /** New creases, valley or mountain as seen on the paper as it lies now, from above. */
    valley?: [PointExpr, PointExpr][];
    mountain?: [PointExpr, PointExpr][];
    /** New creases whose direction follows from the rest (the layer solver picks it). */
    fold?: [PointExpr, PointExpr][];
    /** Folded creases that open flat. */
    flatten?: [PointExpr, PointExpr][];
    /** Folded creases that turn the other way (a valley becomes a mountain). */
    flip?: [PointExpr, PointExpr][];
    /** A point of the paper on the face that stays still (default: the lowest face). */
    fixed?: PointExpr;
    /** An arrow for the diagram, from and to, as ordinary points of the model as it lies now. */
    arrow?: [PointExpr, PointExpr];
  };
  sheet?: string;
  /** Name for a later `shape: [{ creases: <name>, angle }]`. */
  name?: string;
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
export interface PoseOp {
  /**
   * Pick a folded sheet up and set it down in 3D, as one rigid piece: standing in a pot, leaning
   * against another sheet. The sheet must be lying flat where `point` is.
   */
  pose: {
    sheet: string;
    /** This point of the sheet (world, before moving) ... */
    point: PointExpr;
    /** ... goes above this point of the table (world), `height` cm up. */
    to: PointExpr;
    height?: number;
    /** A second point of the sheet: the direction from `point` to it is the sheet's "up". */
    along: PointExpr;
    /** Degrees the sheet's "up" leans away from straight up (0 upright, 90 lying level). */
    lean?: number;
    /** Compass direction it leans towards, degrees anticlockwise from the diagram's right. */
    toward?: number;
    /** Extra turn about its own "up", degrees (0: the side now facing up ends facing the middle and the sky). */
    turn?: number;
  };
}
export interface MarkOp {
  /** Name a point (evaluated in world space, stored on the paper) for later steps. */
  mark: Record<string, PointExpr>;
}

/** One crease set to a 3D (non-flat) fold angle. */
export interface ShapeCrease {
  /** Creases made by the folds with this `name`. */
  creases?: string;
  /** Or: creases lying on this segment (world, current state), with their fold direction... */
  line?: [PointExpr, PointExpr];
  /** Or: creases lying on this segment of the unfolded sheet (points read on the paper, as in `refold`). */
  paper?: [PointExpr, PointExpr];
  /** Direction, needed when the crease is open (flat) at this point. Seen from above. */
  kind?: 'valley' | 'mountain';
  /** How far the crease is folded, in degrees: 0 is flat open, 180 is folded flat. */
  angle: number;
}
export interface ShapeOp {
  /** Open or close creases to 3D angles (walls of a box, a body opened to stand, a puffed wing). */
  shape: ShapeCrease[] | {
    creases?: ShapeCrease[];
    fixed?: PointExpr;
    /**
     * The paper may bend to reach the shape (wings pulled apart so the body puffs out, a curled
     * leaf). Solved as bending paper when the site is built. Every later step is soft too.
     */
    soft?: boolean;
  };
}
export interface PatternOp {
  /** Crease a crease pattern (segments in world space on a flat sheet), and optionally fold it all to `angle`. */
  pattern: {
    /** Segments [P, Q], or [P, Q, angle] to give one crease its own angle. */
    valley?: ([PointExpr, PointExpr] | [PointExpr, PointExpr, number])[];
    mountain?: ([PointExpr, PointExpr] | [PointExpr, PointExpr, number])[];
    /** Fold every crease of the pattern to this many degrees at once (0 flat, 180 folded flat). */
    angle?: number;
    /** A point on the face that stays still while it folds. */
    fixed?: PointExpr;
    /** Name for a later `shape: [{ creases: <name>, angle }]`. */
    name?: string;
  };
  sheet?: string;
}
export interface StandOp {
  /** Stand the model up: tip it about a base line until it rests on that line (default 90°). */
  stand: { on: [PointExpr, PointExpr]; angle?: number } | [PointExpr, PointExpr];
}

export type Op = FoldOp | TurnOverOp | RotateOp | GridOp | CollapseOp | RefoldOp | PlaceOp | PoseOp | MarkOp | ShapeOp | StandOp | PatternOp;

export type CameraPreset = 'top' | 'three-quarter' | 'front' | 'side' | 'bottom' | 'hero';
export interface CameraSpec {
  preset?: CameraPreset;
  azimuth?: number;
  elevation?: number;
  zoom?: number;
  /** Set by the compiler when the author gave no camera: the viewer picks one for the fold. */
  auto?: boolean;
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
  refold?: RefoldOp['refold'];
  place?: PlaceOp['place'];
  pose?: PoseOp['pose'];
  mark?: MarkOp['mark'];
  shape?: ShapeOp['shape'];
  pattern?: PatternOp['pattern'];
  stand?: StandOp['stand'];
  /** Name points of the paper, each read on the unfolded sheet (see `refold`). */
  points?: Record<string, PointExpr>;
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
  /** Stays put while the model is shaped in 3D. */
  anchor?: boolean;
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

export type MotionKind = 'hinge' | 'crease' | 'spin' | 'chain' | 'refold' | 'move' | 'none' | 'shape' | 'stand' | 'pose';

/** A 3D fold angle for a set of creases, resolved by the simulation. */
export interface PhaseShape {
  /** Creases made by phases with this name... */
  name?: string;
  /** ...or creases on this world segment (in the phase's flat state)... */
  p?: V2;
  q?: V2;
  /** ...or, when set, on this segment of that sheet's unfolded paper. */
  paper?: string;
  /** Direction for open creases: valley or mountain seen from above. */
  kind?: 'valley' | 'mountain';
  /** Degrees: 0 flat open, 180 folded flat. */
  angle: number;
}

/** Whole-model tilt about a line on the table (world), in degrees by the right-hand rule along p→q. */
export interface Tilt { p: V2; q: V2; a0: number; a1: number }

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
  /** 1 on faces that stay put when the model is shaped in 3D (they anchor its placement). */
  k?: 1;
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
  /** A shape the paper bends to reach (see ShapeOp.soft). */
  soft?: boolean;
  axis?: [V2, V2];
  /**
   * A reverse fold: the point where the fold line meets the flap's folded edge (its spine), and a
   * point further along the spine on the moving side. The flap swings about the first point in the
   * plane of the model while it turns inside out.
   */
  spine?: [V2, V2];
  center?: V2;
  angle?: number;
  faces: PhaseFace[];
  lines: DiagramLine[];
  arrows: DiagramArrow[];
  /** Fold name (see FoldOp.name). */
  name?: string;
  /** For 'shape' phases: the creases and angles. */
  shape?: PhaseShape[];
  /** The model's tilt through this phase (absent when upright on the table, i.e. lying flat). */
  tilt?: Tilt;
  /**
   * For 'pose' phases: sheet `sheet` moves as one rigid piece, v -> R (v - from) + to (paper world,
   * cm; R row-major). From then on that sheet is no longer where the flat diagram shows it.
   */
  pose?: { sheet: string; from: [number, number, number]; to: [number, number, number]; R: number[] };
}

export interface CompiledStep {
  text: string;
  tip?: string;
  group?: string;
  /** Sheets this step works on (ids). Several, or none, for assembly and whole-model moves. */
  sheets?: string[];
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
  /** Steps solved when the site was built (engine/kinematic.ts); absent in the editor, which solves live. */
  kin?: import('./kinematic.ts').KinRecord;
}
