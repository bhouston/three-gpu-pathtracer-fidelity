# three-gpu-pathtracer-fidelity

three-gpu-pathtracer-fidelity validates the new WebGPU-based
[three-gpu-pathtracer](https://github.com/bhouston/three-gpu-pathtracer) against two references: **Blender Cycles**
and the established **WebGL** path tracer. Each scene is rendered by all three, the images are diffed and scored, and
the results can be browsed in a web viewer: <https://three-gpu-pathtracer-fidelity.ben3d.ca>.

| Renderer (id)  | Name           | Role       | What it is                                                    |
| -------------- | -------------- | ---------- | ------------------------------------------------------------- |
| `blender`      | Blender Cycles | reference  | Independent production path tracer (default 4096 spp).        |
| `webgl-legacy` | WebGL Legacy   | reference  | The established `WebGLPathTracer` (default 4096 spp, seeded). |
| `webgpu-new`   | WebGPU New     | under test | The new `WebGPUPathTracer` (default 4096 spp, seeded).        |

The suite follows the design of the sibling [material-fidelity](https://github.com/bhouston/mtlx-fidelity) project: a
scene registry, a renderer package, a CLI that renders, and [fidelity-kit](https://github.com/bhouston/fidelity-kit)
for scoring, diffing, and viewing the committed results. It was split off from
[three-ss-fidelity](https://github.com/bhouston/three-ss-fidelity).

Workflow rules (issues, branches, Conventional Commits, PRs, required checks) are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## How the work is done

1. Change the WebGPU path tracer in `submodules/three-gpu-pathtracer`.
2. Re-render the affected scenes: `pnpm cli render --scenes 'gi-*' --renderers webgpu-new`.
3. Score them against the references: `pnpm exec fidelity-kit process results`.
4. Check for regressions: `pnpm cli quality-gate <baseline> <candidate>` (mean-RMSE threshold, default 1 %) on results
   rendered before and after a change into another `--results`.
5. Commit the updated `results/`.

## Repository layout

```
submodules/three-gpu-pathtracer  bhouston/three-gpu-pathtracer: both path tracers (WebGL and WebGPU)
submodules/three.js              bhouston/three.js: the single three.js build everything uses
submodules/glTF-Sample-Assets    KhronosGroup/glTF-Sample-Assets: the models of the khronos-* / x-* scenes
submodules/3d-demo-data          gkjohnson/3d-demo-data: the models and HDRs of the model-* scenes
assets/environments/             HDR lighting of those scenes (from KhronosGroup/glTF-Render-Fidelity-Generator)
packages/scenes     @pathtracer-fidelity/scenes     renderer-agnostic scene definitions + registry (browser and node)
packages/renderers  @pathtracer-fidelity/renderers  WebGL Legacy and WebGPU New adapters behind one LiveRenderer API
packages/cli        @pathtracer-fidelity/cli        headless render / quality-gate (+ the Blender runner)
results/<scene>/beauty/                              committed render output; scored/viewed with fidelity-kit
```

The workspace overrides `three` with `workspace:*`, so every package, and three-gpu-pathtracer itself, uses the build in
`submodules/three.js`. There is only ever one copy of three.

### `packages/scenes`

- `src/types.ts` holds the contract. A `SceneDefinition` has a `name`, `description`, `width`/`height` and an async
  `create(ctx)`, which returns a `SceneSetup`: the scene, camera, orbit `target`, and tone mapping.
- `src/index.ts` is the registry (`listSceneNames`, `getScene`). Scene families each live in their own file.
- Assets (glTF, HDR) are loaded from paths relative to `submodules/three.js/examples/`, or the repository root with a `@/` prefix.
- `src/khronos.ts` builds the `khronos-*` and `x-*` scenes from `src/khronos-scenarios.json`: the scenarios of
  three-gpu-pathtracer's `example/viewerTest.js` (Khronos glTF-Render-Fidelity-Generator `config.json` @ `deaaba0`, plus the
  example's `extraScenarios.json`), camera and size included. The Khronos golden images are not used: every reference is
  rendered here with Blender.
- `src/model-list.ts` builds the `model-*` scenes from the model list of three-gpu-pathtracer's `example/index.js`: glTF
  models normalized to a unit sphere on its stage (`src/model-stage.ts`: floor / pedestal / backdrop, rect-area light rigs,
  gradient background). The LEGO models (LDraw, Collada) are not ported yet.
- **To add a scene:** add a `SceneDefinition` to a family file (or a new one), spread it into the registry in
  `index.ts`, extend the family's `*.test.ts`, then render all three renderers.

### `packages/renderers`

`src/types.ts` defines `rendererNames` (`webgl-legacy`, `webgpu-new`), and the
`LiveRenderer` interface. `src/pathtracer.ts` adapts the WebGL path tracer, `src/pathtracer-webgpu.ts` the WebGPU one,
and `createRenderer` in `src/index.ts` dispatches by name.

### `packages/cli`

Each render runs in its **own child process** (`render-process.ts`), because dawn and ANGLE don't share a process
reliably. Headless GPU comes from `src/headless/webgpu.ts` (dawn) and `src/headless/webgl.ts` (ANGLE). `Math.random`
is seeded, so renders are reproducible. Blender runs through `src/blender.ts` and `blender/render.py`.

| Command                               | Does                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cli list [--verbose]`                | List scene names.                                                                                               |
| `cli render`                          | Write `results/<scene>/beauty/<renderer>.avif`. `--scenes/--renderers` take comma-separated globs; `--samples`. |
| `cli quality-gate <base> <candidate>` | Fail if the candidate's mean RMSE vs `webgl-legacy` regresses by more than `--threshold`.                       |

Run `pnpm cli <command> --help` for all flags. `pnpm cli` runs the built `dist/`, so run `pnpm build` after changing sources.

### Viewer

`results/fidelity.json` declares the renderers (`blender` and `webgl-legacy` are references) and one output (`beauty`, the only thing rendered: fidelity-kit wants an output folder per scene); `results/README.md` is the viewer's introduction (keep it in sync with `fidelity.json`).

- `pnpm fidelity:dev` serves the results grid and scene detail views at `localhost:3000`.
- `pnpm fidelity:build` exports a static site to `site/`.

Merging to `main` deploys `site/` to GitHub Pages at <https://three-gpu-pathtracer-fidelity.ben3d.ca>.

## Results

`results/<scene>/beauty/` holds `blender.avif`, `webgl-legacy.avif` and `webgpu-new.avif` (AVIF q90 4:4:4), plus the
`<renderer>.vs-<reference>.*` metrics and deltas written by `fidelity-kit process` (gitignored, regenerated on demand).
Not every renderer is rendered for every scene.

## Setup and checks

```bash
git clone --recurse-submodules <repo>   # or: git submodule update --init
pnpm install --frozen-lockfile          # Node 26 (.nvmrc), pnpm pinned in package.json
pnpm build                              # tsc -b, builds submodules/three.js, then the packages
pnpm tsc && pnpm lint && pnpm test --coverage
pnpm exec oxfmt <changed files>
```

Submodules are marked `ignore = dirty`: commit inside the submodule, push it, then commit the updated pointer here.
