# Higher fidelity: what it would take

Today every step is an exact **flat fold**. Each face of paper is a flat polygon with a
2D position and a layer number, and the viewer animates one hinge (or a chain of hinges)
between flat states. That covers most diagrams, and it keeps scripts short. It does not
cover the last 3D shaping steps (puffing a waterbomb, curling a tail, opening a cup),
paper thickness, or curved folds.

Nothing in the format blocks those. Here is what each would need, roughly in order of value.

## 1. Squash, petal and rabbit-ear folds as single ops

These are compound moves that diagrams treat as one step. Under the hood each is two or
more flat folds that happen together, which the `collapse` op can already express (a set
of creases folded at once, checked with Maekawa's theorem). The work is sugar:

- `squash: { flap: P, line: [...] }` would work out the creases and call `collapse`.
- `petal`, `rabbit-ear` and `sink` would follow the same pattern.

A **closed sink** is the hard one, because layers swap their order. It needs a better
layer solver than today's (see 3).

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

Status: this was built, and then replaced as the default for linked folds by rigid kinematics
(see [3D shaping](3d-shaping.md)). Physics picks a branch at random at flat states, which made
symmetric models lopsided, and it has no collision handling. The viewer no longer uses it; the
bar-and-hinge solver stays in src/engine/sim.ts for a future bending path between two exact states
(a step that can't move rigidly), which would be solved at build time like the rest.

## 5. Paper thickness

Status: built (src/engine/stack.ts). One rule for every pose, flat or 3D: faces that touch are
stacked, and each sits one paper thickness (about 0.15 mm on a 15 cm sheet) above the highest face it
rests on. Two faces that touch the way they lay in the flat diagram keep the diagram's layer order;
faces that meet in 3D keep the side they approached from. Levels are worked out at the rest poses
(the ends of each phase), so the end of one step and the start of the next are the same state with
the same thickness, and a thin strip along each crease joins faces at different levels so the paper
never tears open. `tests/continuity.test.ts` checks every model for jumps between steps.

## Format guarantees

- Scripts stay **declarative**: folds are described by points and lines, not by
  coordinates baked from a render. A smarter engine can recompile old scripts.
- Compiled steps are versioned JSON with optional fields. A new kind of motion adds
  fields, and old viewers ignore steps they can't play.
- Every model also exports a FOLD file, so external tools (such as Origami Simulator or
  Flat-Folder) can already open our crease patterns.
