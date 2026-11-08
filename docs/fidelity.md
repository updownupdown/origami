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

## 3. A proper layer-order solver

Layers are currently ranked with simple rules, such as the moving part landing on top.
That's right for the folds we write by hand, but it can be wrong after collapses and
reverse folds. The standard approach would be a full solver, such as the Flat-Folder
algorithm by Jason Ku et al. It finds every valid stacking for a crease pattern and lets
the script pick one. It runs offline at build time, so the viewer doesn't change.

## 4. Physics: bending and curved paper

For realistic motion and puffy 3D models, run the folded state through a bar-and-hinge
simulation in the browser, in the style of Amanda Ghassaei's *Origami Simulator*:

- Each face becomes a triangle mesh.
- Creases become hinge springs with a target angle.
- The step's flat state becomes the target.

It costs more CPU and can be unstable at 180°, so it would sit behind a "realistic" toggle
and the exact flat-fold engine would stay the source of truth.

## 5. Paper thickness

Today layers are drawn a fixed tiny distance apart. Better thickness means offsetting each
face by its layer and bending creases around the stack. That matters most for
tessellations and big multi-layer models. It's a viewer change only.

## Format guarantees

- Scripts stay **declarative**: folds are described by points and lines, not by
  coordinates baked from a render. A smarter engine can recompile old scripts.
- Compiled steps are versioned JSON with optional fields. A new kind of motion adds
  fields, and old viewers ignore steps they can't play.
- Every model also exports a FOLD file, so external tools (such as Origami Simulator or
  Flat-Folder) can already open our crease patterns.
