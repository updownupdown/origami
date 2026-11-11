# Higher fidelity: what it would take

Today every step is an exact **flat fold**. Each face of paper is a flat polygon with a
2D position and a layer number, and the viewer animates one hinge (or a chain of hinges)
between flat states. That covers most diagrams, and it keeps scripts short. It does not
cover the last 3D shaping steps (puffing a waterbomb, curling a tail, opening a cup),
paper thickness, or curved folds.

Nothing in the format blocks those. Here is what each would need, roughly in order of value.

## 1. Squash, petal and rabbit-ear folds as single ops (done)

`refold` changes several creases of a folded model at once and folds it flat again: squash folds,
petal folds, page turns and reverse folds through many layers. Its points are read on the unfolded
sheet, so the creases are easy to name. See [refold.md](refold.md); the traditional lily
(`models/plants/lily.yaml`) is built with it. A **closed sink** is still untested.

## 2. 3D shaping poses (non-flat end states)

The phase format already stores, for chain motion, a parent face, a hinge line and an
angle per face. A shaping step can reuse that and stop at an angle other than 180°:

```yaml
- text: Open the ears.
  shape:
    - { crease: [P, Q], angle: 60 }
```

The viewer already poses faces by composing hinge rotations, so this is mostly compiler
work. One limit: faces can only bend along existing creases. Curved or rounded shaping,
such as puffing out a balloon, would need step 4.

## 3. A proper layer-order solver (done)

Each fold first ranks layers with simple rules (the moving part lands on top; a reverse fold
turns each half of the flap inside out). Then the layer solver in `src/engine/layers.ts`
checks that order with the Flat-Folder rules (Jason Ku et al.): crease order, taco-taco,
taco-tortilla and no cycles. Every crease keeps the side the fold gave it, and every other
overlapping pair keeps its order wherever it can, so a correct order comes back unchanged and
a wrong one is repaired with as few swaps as possible. Collapses are solved the same way.
`tests/layers-valid.test.ts` checks every fold of every model. The one known exception is the
dart's second wing fold, whose script takes only the bottom layer.

## 4. Physics: bending and curved paper

For realistic motion and puffy 3D models, run the folded state through a bar-and-hinge
simulation in the browser, in the style of Amanda Ghassaei's *Origami Simulator*:

- Each face becomes a triangle mesh.
- Creases become hinge springs with a target angle.
- The step's flat state becomes the target.

It costs more CPU and can be unstable at 180°, so it would sit behind a "realistic" toggle
and the exact flat-fold engine would stay the source of truth.

Status: the bar-and-hinge solver (src/engine/sim.ts) runs when the site is built, for steps
marked `soft: true` (see [3D shaping](3d-shaping.md)). It is not used for ordinary folds: physics
picks a branch at random at flat states, which made symmetric models lopsided, so those stay with
the exact flat-fold engine and the rigid solver. A soft step holds part of the model still and
works the named creases firmly, which keeps it symmetric.

Folded sheets can be set in place in space as rigid pieces (`pose`, see [3D shaping](3d-shaping.md)),
which is enough for plants with straight leaves in a faceted pot (the potted agave).

Still missing for models like curled leaves and round pots:

- A finer mesh inside faces, so paper can curl smoothly instead of bending along a few lines.
- Collisions between layers, so paper rests on paper instead of passing through.
- A `curl` step (roll a strip into a tube, curve a leaf) that sets a bend across a whole face.

Reverse folds are the other non-rigid case. They are shown as the flap swinging in the plane of
the model while it turns inside out (`reverseMotion` in src/engine/kinematic.ts).

## 5. Paper thickness

Status: built (src/engine/stack.ts). One rule for every pose, flat or 3D: faces that touch are
stacked, and each sits one paper thickness (about 0.15 mm on a 15 cm sheet) above the highest face it
rests on. Two faces that touch the way they lay in the flat diagram keep the diagram's layer order;
faces that meet in 3D keep the side they approached from. Levels are worked out at the rest poses
(the ends of each phase), so the end of one step and the start of the next are the same state with
the same thickness, and a thin strip along each crease joins faces at different levels so the paper
never tears open. `tests/continuity.test.ts` checks every model for jumps between steps.

## 6. How a step is drawn

Status: built (src/scripts/viewer.ts). Five rules, each there to keep the picture honest:

- **Each face in its own solved place.** While the paper is rigid, every crease-pattern face is
  placed whole from its own transform (`Kinematics.rigidAt`), so paper that a step does not move is
  drawn exactly still. Bent paper follows its solved vertices (`posAt`).
- **Lines belong to the paper.** The paper's own shader draws its edges and creases, a fixed number
  of screen pixels wide: a line is hidden exactly when its paper is, and stacked layers of one colour
  stay apart to the eye. A crease lying flat is a faint mark; folded over, it is an edge of the model
  and is drawn like one. Lines are not separate objects, so they cannot show through a layer above
  or drift off the paper.
- **Diagram marks sit on the paper.** The fold line and arrow of a step are given on the flat
  diagram; each point is carried onto the 3D paper under it (the top layer there) as the paper lies
  at the start of the step, tilt and thickness included.
- **The mat is a drawing, not a table.** The paper that a step does not fold never moves. A flap
  folded behind swings down through the grid and comes to rest under the model. The model rises only
  when it must end the step resting higher, or when the whole of it is picked up (turned over, stood
  up), and then by exactly what it needs at each moment, so its height is a smooth function of time.

- **The camera follows the work.** With several sheets, a step is framed on the sheets it is about;
  the others wait outside the picture or at its edge.

## Format guarantees

- Scripts stay **declarative**: folds are described by points and lines, not by
  coordinates baked from a render. A smarter engine can recompile old scripts.
- Compiled steps are versioned JSON with optional fields. A new kind of motion adds
  fields, and old viewers ignore steps they can't play.
- Every model also exports a FOLD file, so external tools (such as Origami Simulator or
  Flat-Folder) can already open our crease patterns.
