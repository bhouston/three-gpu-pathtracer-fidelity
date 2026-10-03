# A guide to CPU rendering with Docker and DockerGrid

## Purpose

This container makes the fidelity suite runnable on a Linux machine or a render farm without a physical GPU. It renders the same scene with the new WebGPU three-gpu-pathtracer, the legacy WebGL three-gpu-pathtracer, and Blender Cycles, then produces images and comparisons that help investigate rendering differences.

Docker packages the Linux runtime, native Node modules, graphics drivers, Blender, and pinned renderer sources together. DockerGrid supplies the surrounding job system: it builds or registers the image, generates an input form from its schema, runs tasks on Cloud Run Jobs, and collects logs and artifacts. You can also run the image directly with Docker to debug rendering without a farm account.

Use this setup for small integration checks, repeatable reference generation, and comparing renderer changes on machines without GPU access. CPU software path tracing is slower than hardware GPU rendering. A small successful render proves that the pipeline works; a fidelity baseline needs sufficient samples, matching settings, and investigation of adapter diagnostics.

## How rendering works

The JavaScript renderers still use their graphics APIs. Mesa implements those APIs in software on the CPU; Blender uses its own CPU rendering backend.

| Engine         | API and backend                          | Runs on |
| -------------- | ---------------------------------------- | ------- |
| `webgpu-new`   | Dawn WebGPU → Vulkan → Mesa Lavapipe     | CPU     |
| `webgl-legacy` | node-webgl → Mesa llvmpipe               | CPU     |
| `blender`      | Blender Cycles, explicitly selecting CPU | CPU     |

Each renderer runs in a separate child process so Dawn and WebGL native contexts have separate lifecycles. The CLI's CPU and GPU work lanes still exist, but both consume CPU resources in this image. Allocate **4 CPUs and 8 GiB per task**. Parallel tasks each receive that allocation.

The image sets `FIDELITY_SOFTWARE_RENDERING=1` to select Dawn's Vulkan backend, discovers Mesa's Lavapipe ICD, and exports its path as `VK_ICD_FILENAMES`. `LIBGL_ALWAYS_SOFTWARE=1` and `GALLIUM_DRIVER=llvmpipe` select software WebGL. `LP_NUM_THREADS=4` and `OMP_NUM_THREADS=4` configure four-thread work where supported; Docker or Cloud Run supplies the actual resource limits.

The tested base is Node 26 on Debian Trixie. Dawn's Linux prebuilt binary requires newer glibc and C++ runtimes than Bookworm provides. Mesa libraries supply Vulkan, EGL, GLES, and OpenGL; additional Linux libraries support Blender. Blender 4.5.3 is downloaded from its official release archive and checked against a pinned SHA-256 digest. Native Node dependencies are installed inside Linux, so a macOS `node_modules` directory must not be copied into the image.

The pinned pathtracer fork contains both commits from [upstream PR #862](https://github.com/gkjohnson/three-gpu-pathtracer/pull/862), which use core `r32float` for the Turquin lookup texture and fix WGSL bindings. The Docker build does not patch renderer source files. WebGPU sampling waits for completed paths and caps each checkpoint; a wavefront update is not counted as a completed sample.

## Files to read or reuse

| File                                                        | Responsibility                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`docker/Dockerfile`](../docker/Dockerfile)                 | Install Linux dependencies and Blender, build the suite, generate the scene catalog.         |
| [`docker/entrypoint.sh`](../docker/entrypoint.sh)           | Select Lavapipe, then run the farm wrapper or an explicitly supplied command.                |
| [`docker/check-software.mjs`](../docker/check-software.mjs) | Verify that Dawn and WebGL report software adapters.                                         |
| [`docker/dockergrid.py`](../docker/dockergrid.py)           | Declare inputs, fetch task parameters, run renders/comparisons, validate and upload outputs. |
| [`docker/farm.py`](../docker/farm.py)                       | Exchange farm credentials and upload artifacts through the task API.                         |
| [`scripts/docker-context.py`](../scripts/docker-context.py) | Package tracked sources and initialized submodules into a build context.                     |
| [`results/fidelity.json`](../results/fidelity.json)         | Declare the renderers, references, and comparison configuration.                             |

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
docker run --rm --platform linux/amd64 --cpus 4 --memory 8g pathtracer-fidelity:cpu --describe
docker run --rm --platform linux/amd64 --cpus 4 --memory 8g pathtracer-fidelity:cpu node docker/check-software.mjs
```

The adapter check must report Mesa software rendering such as llvmpipe/Lavapipe for both APIs. Keep the image's entrypoint: it sets the Vulkan ICD environment before executing the supplied command.

For a small three-engine render with comparisons and results retained on the host:

```sh
fidelity_results_dir=$(mktemp -d)
docker run --rm --platform linux/amd64 --cpus 4 --memory 8g \
  -v "$fidelity_results_dir:/results" pathtracer-fidelity:cpu sh -c '
    /opt/blender/blender --version &&
    cp /app/results/fidelity.json /results/fidelity.json &&
    node packages/cli/dist/bin.js render \
      --scenes gi-basic --renderers webgpu-new,webgl-legacy,blender \
      --samples 2 --min-samples 1 --noise-threshold 0 \
      --cycles-noise-threshold 0 --blender-device cpu \
      --width 64 --height 64 --output /results &&
    pnpm exec fidelity-kit process /results
  '
printf 'Results: %s\n' "$fidelity_results_dir"
```

This direct command produces the results directory without contacting DockerGrid. It preloads Blender before rendering, copies the comparison configuration, and disables adaptive thresholds to render the requested sample count. It does not create the farm wrapper's upload archive. Running the image with no command starts farm task mode and requires credentials supplied by DockerGrid.

## Register and submit through DockerGrid

In a built DockerGrid checkout, log in and register the source archive. DockerGrid builds it remotely, so you do not need Docker on the submitting machine:

```sh
export DOCKERGRID_API_URL=https://dockergrid-api-50046401737.us-central1.run.app
pnpm farm auth login
pnpm farm images register --label pathtracer-fidelity-cpu --context /tmp/fidelity-context.tar.gz
```

That URL is the tested preview environment; replace it for your own deployment. Registration runs the image with `--describe` and stores its schema. Wait until the image is ready before submitting. Choose a different label if your account already owns an image with that label, or use the existing registered image. Image visibility defaults to private; the preview's shared `pathtracer-fidelity-cpu` image is public.

Submit a bounded smoke task:

```sh
pnpm farm submit pathtracer-fidelity-cpu --scene gi-basic --samples 2 \
  --width 64 --height 64 --renderers all --cpu 4 --memory-gib 8 --max-retries 0
```

The dashboard offers the same schema-generated scene, sample, renderer, width, and height controls. Select **4 CPUs / 8 GiB** in its execution settings. The zero retry setting above keeps a diagnostic failure to one attempt; other jobs may use the farm's default three retries or choose their own limit. Logs and outputs remain separate for every task and attempt, and private to the submitting account.

For higher-quality comparisons, increase resolution and sample count after the smoke task passes. Provisioning and shader compilation add startup time, and large scenes or high sample counts can take substantially longer.

## Inputs and task lifecycle

| Input             | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `scene`           | One scene advertised by this image; default `gi-basic`.                                    |
| `samples`         | Exact samples per pixel with adaptive thresholds disabled; 1–4096, default 4.              |
| `renderers`       | `all`, `webgpu-new`, `webgl-legacy`, or `blender`; default `all`.                          |
| `width`, `height` | Optional resolution overrides, each 16–1024; omitted dimensions retain the scene defaults. |

The wrapper exchanges the execution bootstrap credential for one task-attempt token and its parameters. It validates those parameters and, when Blender is selected, runs Blender's version command with a 60-second cold-start allowance. This loads native libraries before the adapter's five-second discovery probe and concurrent software graphics work.

Each task uses a fresh temporary results directory and copies `fidelity.json` into it. Existing committed references are not overwritten. Resolution overrides apply equally to the selected engines, including camera aspect ratio. `all` runs all three engines and then `fidelity-kit process`; an individual renderer produces its render without pairwise comparisons.

Missing or empty required artifacts and failed render/process commands fail the attempt. Outputs are uploaded before the wrapper reports completion, and renderer stdout/stderr is available through Cloud Logging and the job page.

## Understand the outputs

For `all`, the current configuration uses Blender and legacy WebGL as references. Comparing each reference against the other two engines produces four metric files and four difference images.

| Artifact                            | Use                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `webgpu-new.avif`                   | New WebGPU render, tagged `primary` for the preview.                     |
| `webgl-legacy.avif`, `blender.avif` | Reference renders.                                                       |
| `*.metrics.json`                    | Comparison metrics, currently PSNR, with dimensions and source metadata. |
| `*.delta.webp`                      | Visual difference images.                                                |
| JSON configuration and metadata     | Inputs to the results viewer and comparison bookkeeping.                 |
| `outputs.tar.gz`                    | Complete results directory with its scene/beauty hierarchy preserved.    |

Download and extract the archive into a fresh directory to inspect results locally with fidelity-kit. Individual output cards provide quick previews and downloads. Use matching settings and enough samples before interpreting PSNR or difference images as regression evidence: at two samples, sampling noise is a large part of the difference. A successful job means the required rendering and comparison steps completed, not that the engines produce equivalent images.

## Troubleshooting

| Symptom                                       | Check                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A scene is absent from the form               | The default image includes GI scenes only. Initialize model submodules, package with `--include-model-assets`, and register the resulting image. |
| Dawn fails to load a shared library           | Use the documented Trixie image and build native dependencies inside Linux. Do not copy host `node_modules`.                                     |
| Adapter check fails or Vulkan ICD is missing  | Keep `entrypoint.sh` and verify Mesa's Lavapipe driver is installed. Do not bypass the software-adapter check.                                   |
| Blender discovery times out on a cold task    | Use the wrapper's preload step before graphics work; direct Docker commands should also run Blender's version command first.                     |
| GPU validation errors mention storage formats | Confirm the pathtracer submodule matches the recorded pin containing PR #862. Inspect the task logs before treating an image as a result.        |
| Black render or missing comparisons           | The task should fail. Inspect renderer/process logs and verify all required artifacts, rather than reusing old results.                          |
| Local default mode fails to contact the farm  | Supply an explicit rendering command for standalone Docker use; default mode expects farm credentials.                                           |

## Verified preview run

The public preview image `pathtracer-fidelity-cpu` completed [job c64ad9fb-630c-4373-a33e-d426faa15a57](https://dockergrid-dashboard-50046401737.us-central1.run.app/jobs/c64ad9fb-630c-4373-a33e-d426faa15a57) on October 2, 2026, with 4 CPUs / 8 GiB, `gi-basic`, 64×64 pixels, and two completed samples per engine. The task produced 18 artifacts: three AVIF renders, four PSNR metric files, four difference images, metadata, and the complete archive. Every artifact downloaded successfully; all seven image previews loaded in the dashboard. Cloud Run reported the requested CPU and memory limits.

Dawn and WebGL software adapter checks passed in Linux Cloud Build. The final Cloud Run task rendered WebGPU in 15.4 seconds, WebGL in 3.6 seconds, and Blender CPU in 5.4 seconds, excluding setup and provisioning. This is an execution smoke test, not a converged fidelity baseline.
