# `refold`: squash, petal and reverse folds

A plain `fold` turns part of the model over one line. A squash fold, a petal fold, turning a page of
a layered base, a sink or a reverse fold change several creases at once: some new ones are made,
some folded ones open flat, and the model is flat again afterwards. `refold` does that in one step.

```yaml
- text: Squash fold. Lift the right-hand flap, open it, and press it flat.
  points:
    P1: bisect(O mid(B C) C)
    P2: bisect(O mid(B C) B)
  refold:
    valley: [[O, C]]            # new creases, as seen from above on the model as it lies now
    mountain: [[O, P1]]
    fold: [[O, P2]]             # new creases whose direction follows from the rest
    flatten: [[O, mid(B C)]]    # folded creases that open flat
    flip: []                    # folded creases that turn the other way
    fixed: lerp(O A 0.5)        # optional: a point of the paper on the face that stays still
    arrow: [P, Q]               # optional: an arrow for the picture (ordinary points, as the model lies)
```

**Every point in a `refold` is read on the unfolded sheet.** `O`, `mid(B C)` or `bisect(...)` mean
that point of the paper, wherever it has ended up. This is what makes these folds easy to write: the
creases of a squash or a petal fold are simple lines on the crease pattern, but hard to name on the
folded model, where many layers share one spot. `points:` names such points for later steps (it
takes `mid`, `lerp`, `intersect`, `reflect`, `project`, `paper(x y)` and `bisect`).

- `bisect(V P Q)` is where the line that halves the angle P-V-Q meets the segment P–Q. Folding an
  edge to a centre line always makes such a crease.
- Each segment must lie on a crease or cross faces from edge to edge. A crease that ends in the
  middle of a face is an error, as it is for `collapse`.
- What stays still: the face under `fixed`, or else whichever choice leaves the most paper where
  it is.
- The compiler works out the folded shape by reflecting across every folded crease, out from the
  still face. If the creases can't fold flat it says where they disagree. The layer solver then
  finds the order of the layers; paper that moves lands on top of paper that stays unless the
  creases say otherwise.
- The motion is solved like a `collapse`, with the creases you did not list held firmly folded, as
  fingers hold them. Squashes, petal folds and page turns move as stiff paper. A reverse fold can't
  (the flap has to open to let the tip through), so the viewer shows the start of the move and
  dissolves into the exact folded result.
- `name:` on the step names its creases for a later `shape`.

## The patterns

With `K1`, `K2` the corners either side of a flap, `M` the middle of the edge between them, and
`P`, `Q` as in `models/plants/lily.yaml`:

| Fold | Creases |
| --- | --- |
| Squash | `valley: [[O, K1]]`, `mountain: [[O, P1]]`, `fold: [[O, P2]]`, `flatten: [[O, M]]` |
| Petal | `valley: [[Q1, Q2]]`, `fold: [[Q1, M], [Q2, M], [K1, Q1], [K2, Q2]]`, `flatten: [[Q1, P1], [Q2, P2]]` |
| Turn a page | `valley: [[O, X]]`, `flatten: [[O, Y]]` |
| Inside reverse fold | `flip: [[X, K]]`, `fold: [[X, H1], [H1, Y1], [X, H2], [H2, Y2]]` |

A reverse fold through a point with two layers each side needs the crease on every layer: `H` is
where it meets the folded edge, and `Y` is `X` mirrored in that edge (`reflect(X K Q)`).

## Opening the result in 3D

A model made of layers folded flat can be opened with `shape`, naming creases on the unfolded sheet:

```yaml
- text: Open the flower.
  shape:
    creases:
      - { creases: tips, angle: 126.87 }       # the reverse folds, half open
      - { paper: [O, A], angle: 90 }           # creases on this segment of the unfolded sheet
      - { paper: [O, mid(A B)], angle: 180 }   # an open crease folds the way it was last folded
```

The angles have to agree with each other, as they must on real paper: around a reverse fold whose
creases make the angle α with the flap's centre line, a centre crease opened to ρ puts the two
slanted creases at 2·atan(tan(ρ/2) / cos α). If a shape step lets layers slip through each other
while it moves, the solver tries again with all flat-folded layers held together.
