# 3D shaping: boxes, standing models and tessellations

Most steps are flat folds. Four ops take a model into 3D. The flat-fold engine keeps the
flat state as the source of truth. Steps with linked folds are posed by rigid-origami kinematics
(`src/engine/kinematic.ts`): every crease-pattern face stays flat and rigid, loops of creases stay
closed, and the solver gets as close to the angles asked for as rigid paper allows. Mirror-symmetric
models stay exactly symmetric. Each step is checked for paper passing through paper. Where staggering
the folds (one flap after another) can't avoid it, the viewer dissolves from the last clean pose to
the next one instead of showing the crossing. All of this is solved when the site is built
(`npm run compile` stores it in each model's JSON), so the browser only replays it; the editor at
/author/ solves live.

## `shape`: hold creases at an in-between angle

```yaml
- text: Open the walls so they stand straight up.
  shape:
    fixed: O                  # optional: faces under this point stay put (they anchor the model)
    creases:
      - { creases: walls, angle: 90 }                  # every crease made by folds named "walls"
      - { line: [P, Q], angle: 90 }                     # creases on this segment (world, now)
      - { line: [P, Q], kind: valley, angle: 120 }      # an open (flat) crease needs a direction
```

- `angle` is how far the crease is folded: 0 is flat open, 180 is folded flat.
- `line:` takes every crease lying on that segment as the paper lies now, including creases of
  layers folded onto it. To shape one crease of a folded-up sheet, name it when it is made and use
  `creases:`. Add `kind: valley` or `kind: mountain` to bend a named crease the other way.
- Name the folds you want to shape later with `name:` on the fold (`fold: valley, name: walls, ...`).
  Creases made with `crease:` (fold and unfold) can be named too; they keep their direction.
- A list without `fixed` is fine too: `shape: [ { creases: walls, angle: 90 } ]`.
- The angle holds for the rest of the model until a later fold changes that crease.

### Soft shapes: when the paper has to bend

Some shapes can't be reached with stiff faces. Pulling a crane's wings apart puffs out its body,
and the layers inside have to give. Add `soft: true` and the paper is allowed to bend:

```yaml
- text: Hold the wings and pull them gently apart until they stand out level.
  shape:
    creases:
      - { creases: wings, angle: 90 }
    soft: true
```

A soft step is solved when the site is built. The sheet becomes a mesh of stiff bars with springy
hinges (`src/engine/sim.ts`). The creases the step names are worked firmly to their angles, and
the rest of the paper follows as it must. The viewer replays the solved shape, vertex by vertex.

- The paper that stayed still when the named folds were made stays still now. Give `fixed:` to
  hold another part instead.
- Once a model has a soft step, every later step carries on from the bent shape. Later steps can
  stand the model up or bend it again, but they can't fold it flat.
- Faces bend only along their mesh lines, so a soft shape is a faceted bend, not a smooth curl.
- `fold: both` folds the front layers towards you and the back layers away in one step (both
  wings of a bird), which is the usual fold before such a step.

## `stand`: tip the model up so it stands

```yaml
- text: Stand the penguin up.
  stand: [lerp(BOT T 0.02), shift(...)]        # or { on: [P, Q], angle: 80 }
  camera: { azimuth: -25, elevation: 15, zoom: 1.1 }
```

The model turns about the base line P–Q (on the table) until it stands on that line, default 90°.
The side the model is on rises. The front that faced up now faces the default camera. Stand once,
near the end; later folds still work but the overlay is drawn tilted.

To make a flat (two-layer) animal actually stand, open its body a little before or after standing:
`shape: [ { line: [spine start, spine end], angle: 150 } ]`.

## `pose`: set a folded sheet in place in space

Models made of several sheets are put together in 3D: leaves stood in a pot, a lid set on a box.
`pose` picks one sheet up, as folded and shaped as it is, and sets it down as one rigid piece.

```yaml
- text: Stand the pot upright.
  pose: { sheet: pot, point: HB, along: HT, to: HB }
- text: Stand a leaf in the pot, leaning out a little.
  pose: { sheet: leaf1, point: leaf1.C, along: leaf1.A, to: CEN, height: 2.2, lean: 14, toward: 90, turn: 180 }
```

- `point` is a point of the sheet as it lies now; it ends above the table point `to`, `height` cm up.
- `along` is a second point of the sheet. The direction from `point` to `along` is the sheet's "up".
- `lean` is how far that "up" leans from straight up (0 upright, 90 lying level), and `toward` is the
  compass direction it leans in, in degrees anticlockwise from the diagram's right.
- With `turn: 0` the side of the sheet now facing you ends facing the middle and the sky. `turn` rolls
  the sheet about its own "up": 180 shows its other side. For a sheet folded into a V, add half the
  V's angle so it sits square.
- `to` is best given as a pin (`pin:` on an earlier step), so it stays put whatever moves later.
- Several `pose` ops in one step (under `ops:`) set several pieces, one after another.
- From its first `pose` on, a sheet cannot be folded flat again. Fold and shape it first.

A strip becomes a ring with `shape` (every crease to the same angle: 360 / sides) and stands up with
`pose`. `tests/pose.test.ts` checks on the potted agave that the ring closes, that every piece lands
where its step puts it, and that no sheet passes through another in the finished model. Nothing
stops a script from posing one sheet through another, so check new models the same way.

In the viewer, a step of a model with several sheets is framed on the sheets it is about: the sheet
being folded, or, for a `pose`, the piece where it lands with the pieces already standing.

## `pattern`: crease a crease pattern, optionally fold it all at once

```yaml
- text: Crease the pattern, then fold every crease part way.
  pattern:
    fixed: paper(8 8)
    angle: 100                 # all creases to 100°; omit to only crease
    name: miura                # later: shape: [ { creases: miura, angle: 160 } ]
    valley:
      - [paper(0 4), paper(4 5)]
      - [paper(4 5), paper(8 4), 60]     # a third number gives this segment its own angle
    mountain:
      - [paper(4 0), paper(4 16)]
```

The sheet must be flat (unfolded). Each segment must end on the paper's edge or on another crease
(the same rule as `collapse`). Use it for tessellations that are not flat-foldable (Resch, Yoshimura),
for rigid-foldable ones shown part-folded (Miura-ori), and for boxes whose final shape is easiest to
give as angles on the unfolded crease pattern. Give true angles: 90 for a wall that stands up, 180 for a flap
folded flat. The solver keeps layers apart, so there's no need to under-fold (the old 170–176 advice
was a workaround for the physics). Patterns that aren't rigid-foldable with the angles given (for
example a waterbomb tessellation at a uniform angle) will miss their targets; the step
still looks clean, it just stops short of the target.

## Checking

`node scripts/shot-sheet.mjs out.png <id> <id>:<step>` renders four views per model into one image
(needs `npx astro dev` running; set `PORT` for another port).
