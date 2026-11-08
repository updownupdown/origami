# Origami

A searchable library of origami models with step-by-step 3D folding instructions.

**Live site: https://updownupdown.github.io/origami/**

- Browse and search models by category and difficulty.
- Follow each model step by step in 3D. Rotate, zoom and pan, or jump back to the best angle.
- Valley folds are blue dashed lines; mountain folds are orange dash-dot lines.
- Pick your own paper colours. Works offline once visited.

## How models are made

Each model is a YAML file in `models/` that describes its folds (fold lines are built from points such as corners and midpoints). A build step turns these into the 3D steps, thumbnails and search index. Shared bases live in `models/bases/`.

Every model lists its designer and sources in `credits`.

## Develop

```sh
npm install
npm run dev      # local site at http://localhost:4321/origami/
npm test         # engine tests, compiles every model
npm run build    # full build with rendered thumbnails
```

Pushing to `main` deploys to GitHub Pages.
