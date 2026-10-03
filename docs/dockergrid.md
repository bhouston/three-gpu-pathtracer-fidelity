# A guide to CPU rendering with Docker and DockerGrid

## Purpose

This container makes the fidelity suite runnable on a Linux machine or a render farm without a physical GPU. Each DockerGrid task renders exactly one example with one engine: the new WebGPU three-gpu-pathtracer, the legacy WebGL three-gpu-pathtracer, or Blender Cycles. It uploads one primary AVIF at the example's native dimensions. A complete suite is a batch of examples × three engines; comparisons remain a separate local step.

Docker packages the Linux runtime, native Node modules, graphics drivers, Blender, and pinned renderer sources together. DockerGrid supplies the surrounding job system: it builds or registers the image, generates an input form from its schema, runs tasks on Cloud Run Jobs, and collects logs and artifacts. You can also run the image directly with Docker to debug rendering without a farm account.

Use this setup for small integration checks, repeatable reference generation, and comparing renderer changes on machines without GPU access. CPU software path tracing is slower than hardware GPU rendering. A small successful render proves that the pipeline works; a fidelity baseline needs sufficient samples, matching settings, and investigation of adapter diagnostics.

## How rendering works

The JavaScript renderers still use their graphics APIs. Mesa implements those APIs in software on the CPU; Blender uses its own CPU rendering backend.

| Engine         | API and backend                          | Runs on |
| -------------- | ---------------------------------------- | ------- |
| `webgpu-new`   | Dawn WebGPU → Vulkan → Mesa Lavapipe     | CPU     |
| `webgl-legacy` | node-webgl → Mesa llvmpipe               | CPU     |
| `blender`      | Blender Cycles, explicitly selecting CPU | CPU     |

Each renderer runs in a separate child process so Dawn and WebGL native contexts have separate lifecycles. The CLI's CPU and GPU work lanes still exist, but both consume CPU resources in this image. Allocate **8 CPUs and 8 GiB per task**. Parallel tasks each receive that allocation.

The image sets `FIDELITY_SOFTWARE_RENDERING=1` to select Dawn's Vulkan backend, discovers Mesa's Lavapipe ICD, and exports its path as `VK_ICD_FILENAMES`. `LIBGL_ALWAYS_SOFTWARE=1` and `GALLIUM_DRIVER=llvmpipe` select software WebGL. `LP_NUM_THREADS=8` and `OMP_NUM_THREADS=8` configure eight-thread work where supported; Docker or Cloud Run supplies the actual resource limits.

The tested base is Node 26 on Debian Trixie. Dawn's Linux prebuilt binary requires newer glibc and C++ runtimes than Bookworm provides. Mesa libraries supply Vulkan, EGL, GLES, and OpenGL; additional Linux libraries support Blender. Blender 4.5.3 is downloaded from its official release archive and checked against a pinned SHA-256 digest. Native Node dependencies are installed inside Linux, so a macOS `node_modules` directory must not be copied into the image.

The pinned pathtracer fork contains both commits from [upstream PR #862](https://github.com/gkjohnson/three-gpu-pathtracer/pull/862), which use core `r32float` for the Turquin lookup texture and fix WGSL bindings. The Docker build does not patch renderer source files. WebGPU sampling waits for completed paths and caps each checkpoint; a wavefront update is not counted as a completed sample.

## Files to read or reuse

| File                                                              | Responsibility                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`docker/Dockerfile`](../docker/Dockerfile)                       | Install Linux dependencies and Blender, build the suite, generate the scene catalog. |
| [`docker/entrypoint.sh`](../docker/entrypoint.sh)                 | Select Lavapipe, then run the farm wrapper or an explicitly supplied command.        |
| [`docker/check-software.mjs`](../docker/check-software.mjs)       | Verify that Dawn and WebGL report software adapters.                                 |
| [`docker/dockergrid.py`](../docker/dockergrid.py)                 | Declare inputs, fetch task parameters, run one render, validate and upload its AVIF. |
| [`docker/farm.py`](../docker/farm.py)                             | Exchange farm credentials and upload artifacts through the task API.                 |
| [`scripts/dockergrid-batch.mjs`](../scripts/dockergrid-batch.mjs) | Generate one task per selected example and engine using CLI defaults.                |
| [`scripts/docker-context.py`](../scripts/docker-context.py)       | Package tracked sources and initialized submodules into a build context.             |
| [`results/fidelity.json`](../results/fidelity.json)               | Declare the renderers, references, and comparison configuration.                     |

To adapt this pattern for another project, keep the two container entry modes: `--describe` prints a JSON schema without starting rendering, while default mode runs one farm task and reports its outputs. Replace the scene catalog and rendering commands with your own workload. DockerGrid reads the schema rather than relying on renderer-specific frontend code.

## Prepare the build context

Start from a checkout of this repository. You need Python 3 and `git-dedup` on the machine preparing the context; building and rendering happen inside Linux. Local rendering additionally needs Docker. Remote rendering needs a built DockerGrid CLI and an account.

Initialize the code submodules at the repository's pinned commits:

```sh
git-dedup submodule update --init submodules/three-gpu-pathtracer submodules/fidelity-kit-blender submodules/fidelity-kit-three-gpu-pathtracer
python3 scripts/docker-context.py /tmp/fidelity-context.tar.gz
```

The archive includes tracked project sources, repository assets, and the exact checked-out code submodules. It excludes Git metadata, local dependencies, and previous render results, retaining the comparison configuration. `Dockerfile` is placed at the archive root for DockerGrid's remote build. Commit new files before packaging: the script reads tracked paths.

By default, the context omits the multi-gigabyte model datasets and the image advertises only the `gi-*` scenes. To include the complete scene registry:

```sh
git-dedup submodule update --init submodules/glTF-Sample-Assets submodules/3d-demo-data submodules/ldraw-parts-library
python3 scripts/docker-context.py /tmp/fidelity-context-full.tar.gz --include-model-assets
```

The full context is much larger. Start with the smaller GI context when checking a new machine or deployment.

## Build and run locally

The Blender download is Linux x86-64, so build and run this image as `linux/amd64`. On an ARM machine this uses Docker's architecture emulation and may be slower. Ensure the Docker VM, if present, has enough CPU and memory available for the requested limits.

Extract the source archive into a dedicated directory and build it:

```sh
fidelity_build_dir=$(mktemp -d)
tar -xzf /tmp/fidelity-context.tar.gz -C "$fidelity_build_dir"
docker build --platform linux/amd64 -t pathtracer-fidelity:cpu "$fidelity_build_dir"
```

Inspect the input schema and check the actual software adapter identities:

```sh
docker run --rm --platform linux/amd64 --cpus 8 --memory 8g pathtracer-fidelity:cpu --describe
docker run --rm --platform linux/amd64 --cpus 8 --memory 8g pathtracer-fidelity:cpu node docker/check-software.mjs
```

The adapter check must report Mesa software rendering such as llvmpipe/Lavapipe for both APIs. Keep the image's entrypoint: it sets the Vulkan ICD environment before executing the supplied command.

For one render retained on the host, at the scene's native dimensions:

```sh
fidelity_results_dir=$(mktemp -d)
docker run --rm --platform linux/amd64 --cpus 8 --memory 8g \
  -v "$fidelity_results_dir:/results" pathtracer-fidelity:cpu \
  node packages/cli/dist/bin.js render \
    --scenes gi-basic --renderers webgpu-new --blender-device cpu --output /results
```

The normal CLI `render` workflow selects all examples and all three engines by default. To run the complete suite directly in Docker, use an image built with the model assets and omit the scene and renderer selectors:

```sh
docker run --rm --platform linux/amd64 --cpus 8 --memory 8g \
  -v "$fidelity_results_dir:/results" pathtracer-fidelity:cpu sh -c '
    /opt/blender/blender --version &&
    node packages/cli/dist/bin.js render --blender-device cpu --output /results
  '
```

These direct commands keep the CLI's results hierarchy and sidecars without contacting DockerGrid. The farm wrapper uploads only its selected AVIF. Running the image with no command starts farm task mode and requires credentials supplied by DockerGrid.

## Register and submit through DockerGrid

In a built DockerGrid checkout, log in and register the source archive. DockerGrid builds it remotely, so you do not need Docker on the submitting machine:

```sh
export DOCKERGRID_API_URL=https://dockergrid-api-50046401737.us-central1.run.app
pnpm farm auth login
pnpm farm images register --label pathtracer-fidelity-single --context /tmp/fidelity-context.tar.gz
```

That URL is the tested preview environment; replace it for your own deployment. Registration runs the image with `--describe` and stores its schema. Wait until the image is ready before submitting. Choose a different label if your account already owns an image with that label, or use the existing registered image. Image visibility defaults to private; the preview's shared `pathtracer-fidelity-cpu` image is public.

Submit one example and engine with the normal CLI sampling defaults:

```sh
pnpm farm submit pathtracer-fidelity-single --scene gi-basic --renderer webgpu-new \
  --cpu 8 --memory-gib 8 --max-retries 0
```

For a quick execution check at the same native dimensions, override sampling explicitly:

```sh
pnpm farm submit pathtracer-fidelity-single --scene gi-basic --renderer blender \
  --samples 2 --min-samples 1 --noise-threshold 0 --cycles-noise-threshold 0 \
  --cpu 8 --memory-gib 8 --max-retries 0
```

The dashboard offers the same schema-generated scene, singular renderer, and sampling controls. Select **8 CPUs / 8 GiB** in its execution settings. There are no resolution controls or multi-engine selections in the container schema. Register a new image version for this schema; older registered images retain their older input contract.

A full cloud batch contains one task for every example × engine pair. Each task has independent resources, logs, and output. Build the host CLI, then generate the manifest in this repository:

```sh
pnpm build
node scripts/dockergrid-batch.mjs > /tmp/fidelity-tasks.json
```

The complete catalog contains 200 examples, producing 600 tasks across three engines. The helper uses the CLI's scene selection and sampling defaults. Optional `--scenes`, `--renderers`, and sampling flags narrow a batch or change its sampling settings.

Register the full context with `--include-model-assets` so every manifest scene is available. From a built DockerGrid checkout, submit the manifest:

```sh
pnpm farm submit pathtracer-fidelity-single --params /tmp/fidelity-tasks.json \
  --cpu 8 --memory-gib 8 --parallelism 20 --max-retries 0
```

Twenty simultaneous tasks request 160 vCPUs, within the tested preview project's 200-vCPU quota. Each also requests 8 GiB of memory; adjust parallelism to your deployment's available resources. This is the full-suite submission workflow, not a claim that the complete batch has finished. Comparison metrics are computed separately after collecting the images. The zero retry setting above keeps a diagnostic failure to one attempt; other jobs may use the farm's default three retries or choose their own limit. Outputs remain private to the submitting account.

## Inputs and task lifecycle

| Input                  | Meaning                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `scene`                | One scene advertised by this image; default `gi-basic`.                                |
| `renderer`             | `webgpu-new`, `webgl-legacy`, or `blender`; default `webgpu-new`.                      |
| `samples`              | Maximum samples per pixel, 1–4096; default 4096.                                       |
| `minSamples`           | Path tracer minimum before adaptive stopping, 0–4096; default 128.                     |
| `noiseThreshold`       | Path tracer tile noise threshold, 0–1; default 0.005. Zero disables adaptive stopping. |
| `cyclesNoiseThreshold` | Blender Cycles adaptive threshold, 0–1; default 0.005. Zero requests fixed samples.    |

Sampling defaults match the CLI. `minSamples` and `noiseThreshold` apply to the path tracers; Blender uses `cyclesNoiseThreshold`. Dimensions come from the selected scene and are never overridden by the wrapper.

The wrapper exchanges the execution bootstrap credential for one task-attempt token and its parameters. It validates those parameters and, only for Blender, runs Blender's version command with a 60-second cold-start allowance. This loads native libraries before the adapter's five-second discovery probe.

Each task renders one scene and engine into a fresh temporary directory. Existing committed references are not overwritten. The wrapper never invokes comparison processing. The CLI rejects black frames; a failed render, missing or empty AVIF, or failed upload fails the attempt. Logs record the selected scene, engine, sampling settings, and output name. Outputs are uploaded before completion is reported.

## Understand the output

Every successful task uploads exactly one `<scene>.<renderer>.avif`, with MIME type `image/avif` and role `primary`, including WebGL and Blender renders. Its name preserves scene and engine identity when downloading a batch into one directory. The task does not upload sidecars, configuration, metrics, deltas, or archives.

To compare a completed batch locally, place the downloaded AVIFs into `results/<scene>/beauty/<renderer>.avif`, add the repository's `results/fidelity.json`, and run `pnpm exec fidelity-kit process results`. Comparison processing is separate from cloud rendering. Use matching settings and enough samples before interpreting PSNR or difference images as regression evidence.

## Troubleshooting

| Symptom                                       | Check                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A scene is absent from the form               | The default image includes GI scenes only. Initialize model submodules, package with `--include-model-assets`, and register the resulting image. |
| Dawn fails to load a shared library           | Use the documented Trixie image and build native dependencies inside Linux. Do not copy host `node_modules`.                                     |
| Adapter check fails or Vulkan ICD is missing  | Keep `entrypoint.sh` and verify Mesa's Lavapipe driver is installed. Do not bypass the software-adapter check.                                   |
| Blender discovery times out on a cold task    | Use the wrapper's preload step before graphics work; direct Docker commands should also run Blender's version command first.                     |
| GPU validation errors mention storage formats | Confirm the pathtracer submodule matches the recorded pin containing PR #862. Inspect the task logs before treating an image as a result.        |
| Black render or missing output                | The task should fail. Inspect renderer logs and verify the selected AVIF instead of reusing old results.                                         |
| Local default mode fails to contact the farm  | Supply an explicit rendering command for standalone Docker use; default mode expects farm credentials.                                           |

## Historical preview run before the single-render contract

The previous multi-engine wrapper in public preview image `pathtracer-fidelity-cpu` completed [job c64ad9fb-630c-4373-a33e-d426faa15a57](https://dockergrid-dashboard-50046401737.us-central1.run.app/jobs/c64ad9fb-630c-4373-a33e-d426faa15a57) on October 2, 2026, with 4 CPUs / 8 GiB, `gi-basic`, 64×64 pixels, and two completed samples per engine. The task produced 18 artifacts: three AVIF renders, four PSNR metric files, four difference images, metadata, and the complete archive. Every artifact downloaded successfully; all seven image previews loaded in the dashboard. Cloud Run reported the requested CPU and memory limits.

This historical job used the older dimensions and comparison inputs, which the current wrapper no longer accepts. Dawn and WebGL software adapter checks passed in Linux Cloud Build. The final Cloud Run task rendered WebGPU in 15.4 seconds, WebGL in 3.6 seconds, and Blender CPU in 5.4 seconds, excluding setup and provisioning. This is an execution smoke test, not a converged fidelity baseline.
