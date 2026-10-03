# three-gpu-pathtracer-fidelity

three-gpu-pathtracer-fidelity validates the new WebGPU-based
[three-gpu-pathtracer](https://github.com/bhouston/three-gpu-pathtracer) against two references: **Blender Cycles**
and the established **WebGL** path tracer. Each scene is rendered by all three, the images are diffed and scored, and
the results can be browsed in a web viewer: <https://three-gpu-pathtracer-fidelity.ben3d.ca>.

| Renderer (id)  | Name           | Role       | What it is                                  |
| -------------- | -------------- | ---------- | ------------------------------------------- |
| `blender`      | Blender Cycles | reference  | Independent production path tracer.         |
| `webgl-legacy` | WebGL Legacy   | reference  | The established `WebGLPathTracer` (seeded). |
| `webgpu-new`   | WebGPU New     | under test | The new `WebGPUPathTracer` (seeded).        |

Every renderer samples until its image is converged, up to 4096 spp; see [Sampling](#sampling).

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
submodules/fidelity-kit-blender  bhouston/fidelity-kit-blender: Blender scene export and Cycles rendering
submodules/fidelity-kit-three-gpu-pathtracer  bhouston/fidelity-kit-three-gpu-pathtracer: legacy WebGL rendering
submodules/glTF-Sample-Assets    KhronosGroup/glTF-Sample-Assets: the models of the khronos-* / x-* scenes
submodules/3d-demo-data          gkjohnson/3d-demo-data: the models and HDRs of the model-* scenes
submodules/ldraw-parts-library   gkjohnson/ldraw-parts-library: LDraw parts and the LEGO models
assets/environments/             HDR lighting of those scenes (from KhronosGroup/glTF-Render-Fidelity-Generator)
assets/models/                   glTF/LDraw models used directly by scenes (Michelle.glb, two LEGO LDraw models)
packages/scenes     @pathtracer-fidelity/scenes     renderer-agnostic scene definitions + registry (browser and node)
packages/renderers  @pathtracer-fidelity/renderers  WebGL Legacy and WebGPU New adapters behind one LiveRenderer API
packages/cli        @pathtracer-fidelity/cli        headless render / quality-gate (+ the Blender runner)
results/<scene>/beauty/                              committed render output; scored/viewed with fidelity-kit
```

The workspace overrides `three` to a single pinned npm version, so every package, and three-gpu-pathtracer itself, uses
the same install. There is only ever one copy of three.

### `packages/scenes`

- `src/types.ts` holds the contract. A `SceneDefinition` has a `name`, `description`, `width`/`height` and an async
  `create(ctx)`, which returns a `SceneSetup`: the scene, camera, orbit `target`, and tone mapping.
- `src/index.ts` is the registry (`listSceneNames`, `getScene`). Scene families each live in their own file.
- Assets (glTF, HDR) are loaded from paths relative to the installed `three` package's `examples/`, or the repository root with a `@/` prefix.
- `src/khronos.ts` builds the `khronos-*` and `x-*` scenes from `src/khronos-scenarios.json`: the scenarios of
  three-gpu-pathtracer's `example/viewerTest.js` (Khronos glTF-Render-Fidelity-Generator `config.json` @ `deaaba0`, plus the
  example's `extraScenarios.json`), camera and size included. The Khronos golden images are not used: every reference is
  rendered here with Blender.
- `src/model-list.ts` builds the `model-*` scenes from the model list of three-gpu-pathtracer's `example/index.js`: glTF
  models normalized to a unit sphere on its stage (`src/model-stage.ts`: floor / pedestal / backdrop, rect-area light rigs,
  gradient background). The LEGO models are LDraw (parts from `submodules/ldraw-parts-library`) or Collada.
- **To add a scene:** add a `SceneDefinition` to a family file (or a new one), spread it into the registry in
  `index.ts`, extend the family's `*.test.ts`, then render all three renderers.

### `packages/renderers`

`src/types.ts` defines `rendererNames` (`webgl-legacy`, `webgpu-new`), and the
`LiveRenderer` interface. `src/pathtracer.ts` adapts the WebGL path tracer, `src/pathtracer-webgpu.ts` the WebGPU one,
and `createRenderer` in `src/index.ts` dispatches by name.

### `packages/cli`

Each render runs in its **own child process** (`render-process.ts`), because dawn and ANGLE don't share a process
reliably. Headless GPU comes from `src/headless/webgpu.ts` (dawn) and `src/headless/webgl.ts` (ANGLE). `Math.random`
is seeded, so renders are reproducible. Blender runs through `src/blender.ts` and the pinned `fidelity-kit-blender/three` integration.
The legacy WebGL renderer uses the pinned `fidelity-kit-three-gpu-pathtracer` integration.
Both adapters build before the suite and use the shared Three.js install and pathtracer fork;
the adapter's nested development submodule is not part of this workspace.

| Command                               | Does                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cli list [--verbose]`                | List scene names.                                                                                  |
| `cli render`                          | Write `results/<scene>/beauty/<renderer>.avif`. `--scenes/--renderers` take comma-separated globs. |
| `cli quality-gate <base> <candidate>` | Fail if the candidate's mean RMSE vs `webgl-legacy` regresses by more than `--threshold`.          |

Run `pnpm cli <command> --help` for all flags. `pnpm cli` runs the built `dist/`, so run `pnpm build` after changing sources.

#### Sampling

Renders stop at a noise target rather than a fixed sample count, with `--samples` (default 4096) as the cap:

- **Path tracers** have no per-pixel adaptive sampling, so `render-process.ts` checks convergence itself
  (`src/convergence.ts`). At checkpoints four per doubling of the sample count, it reads the image back and compares
  it with the snapshot at half the samples: for a Monte Carlo estimate, that difference's RMS equals the remaining noise.
  The noise is measured per 16 px tile, and the render stops once the 99th-percentile tile is at or below
  `--noise-threshold` (default 0.5 % of the sRGB range), but never before `--min-samples` (default 128). Small noisy
  regions such as caustics therefore keep sampling even when the rest of the image is clean.
- **Blender Cycles** uses its own per-pixel adaptive sampling with `--cycles-noise-threshold` (default 0.005).

Pass `--noise-threshold 0 --cycles-noise-threshold 0` for exact, fixed sample counts. Each render logs the samples it
stopped at and its final noise estimate. Calibration against 4096 spp renders is recorded in
[adaptive sampling](docs/adaptive-sampling.md).

#### Work queues

Jobs run on two concurrent lanes, each one job at a time: a **GPU lane** (WebGL, WebGPU, and Blender on the GPU) and
a **CPU lane** (Blender on the CPU). With `--blender-device auto` (the default), a Blender job runs on whichever lane is
free first, on that lane's device: Cycles uses the GPU on the GPU lane (failing if there is none, rather than falling
back to the CPU and competing with the CPU lane) and the CPU on the CPU lane. The GPU lane takes the path-tracer jobs first and Blender jobs after them. CPU-lane renders run at low
priority, so they never starve the GPU lane's driver threads. `--blender-device cpu` or `gpu` pins Blender to one lane.

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
git-dedup clone --recurse-submodules <repo>   # or: git-dedup submodule update --init
pnpm install --frozen-lockfile          # Node 26 (.nvmrc), pnpm pinned in package.json
pnpm build                              # tsc -b, then the packages
pnpm tsc && pnpm lint && pnpm test --coverage
pnpm exec oxfmt <changed files>
```

Submodules are marked `ignore = dirty`: commit inside the submodule, push it, then commit the updated pointer here.

Blender Cycles renders need Blender 4.0+ installed separately. Discovery tries `BLENDER_EXECUTABLE`, then `blender` on
PATH, then the standard install locations (macOS `/Applications`, Windows `%ProgramFiles%\Blender Foundation`).

**Windows:** install the official build (`winget install BlenderFoundation.Blender`). The Microsoft Store build can't
run headless. Enable long paths before cloning (`git config --global core.longpaths true`), because the asset submodules
have deep paths. Headless WebGL runs on ANGLE's Direct3D backend, and its HLSL `X4000` compiler warnings are harmless.

## Rendering integration migration

Blender and legacy WebGL now use the fidelity-kit integrations. Output remains explicit sRGB with each scene's
tone mapping and exposure, eight bounces and no denoising. Blender uses seed 1 and Cycles adaptive sampling
(see [Sampling](#sampling)). Procedural environments are baked with the shared adapter utility.

The suite always enables the Blender adapter's optional area-light, physical-camera depth-of-field and independent
equirectangular background translations. These features are optional upstream; adapter adoption itself is the
default rendering path here. Area lights retain radiance and unscaled dimensions, and camera apertures use millimeters.
Ambient lights and finite punctual-light cutoffs are deliberately ignored with warnings, matching the reference
pathtracer. Other unsupported features fail, including custom shaders, nonphysical light decay, blurred/GPU-only
backgrounds and anamorphic depth of field. Animated skin/morph pose matching and advanced glTF extensions still
need visual validation.

Cycles defaults to `auto`, which lets either work queue render it. Use `--blender-device cpu` when GPU memory is
occupied by other renders, or select `gpu` explicitly.

Actual smoke-render results and known blockers are recorded in
[rendering integration validation](docs/rendering-integration-validation.md).

For remote CPU rendering with Dawn, WebGL and Blender, see [Docker and DockerGrid guide](docs/dockergrid.md), which explains the software backends, container layout, local rendering, remote submission, and how to interpret outputs.

The committed images still belong to the previous rendering pipeline. After merging this migration, regenerate
all renderer/scene pairs, investigate any adapter diagnostics, then run `pnpm exec fidelity-kit process results`
and commit the regenerated images together. Do not use `--missing-only`: existing images need replacement.
Do not mix old references with new renders when evaluating regressions.
