# 3D shaping: boxes, standing models and tessellations

Most steps are flat folds. Three ops take a model into 3D. The flat-fold engine keeps the
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
- Name the folds you want to shape later with `name:` on the fold (`fold: valley, name: walls, ...`).
  Creases made with `crease:` (fold and unfold) can be named too; they keep their direction.
- A list without `fixed` is fine too: `shape: [ { creases: walls, angle: 90 } ]`.
- The angle holds for the rest of the model until a later fold changes that crease.

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
