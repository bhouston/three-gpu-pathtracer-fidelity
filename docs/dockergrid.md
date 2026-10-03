# CPU rendering on DockerGrid

The container runs the existing fidelity CLI with Dawn WebGPU on Mesa Lavapipe, WebGL on Mesa llvmpipe, and Blender Cycles on CPU. Each renderer retains its separate child process. When Blender is selected, the wrapper first runs its version command with a 60-second cold-start allowance to load native libraries before the adapter's five-second probe and concurrent software graphics work. Native Node dependencies are installed inside Linux; copying a macOS `node_modules` directory will not work.

The base is Node 26 on Debian Trixie. Dawn's prebuilt Linux binary needs a newer glibc and C++ runtime than Debian Bookworm. Blender 4.5.3 is downloaded from the official release archive and verified against its SHA-256 digest. Mesa's Vulkan ICD is discovered in the image, and both graphics backends are explicitly configured for software rendering, matching the sibling vitest-gpu CI setup. The pinned pathtracer fork includes both commits from [upstream PR #862](https://github.com/gkjohnson/three-gpu-pathtracer/pull/862), which use core `r32float` for the Turquin lookup texture and fix its WGSL bindings. No Docker-only source patch is needed.

## Build and register

Initialize the code submodules, install dependencies, and create a source-only build context:

```sh
git-dedup submodule update --init submodules/three-gpu-pathtracer submodules/fidelity-kit-blender submodules/fidelity-kit-three-gpu-pathtracer
python3 scripts/docker-context.py /tmp/fidelity-context.tar.gz
```

The context includes the exact checked-out code submodules and repository assets, and excludes local dependencies, previous render results, and Git metadata. By default it omits the multi-gigabyte model datasets; the resulting image advertises only `gi-*` scenes. Use `--include-model-assets` after initializing all submodules to include the complete scene registry. Commit new files before packaging because the script reads tracked paths.

From a built DockerGrid checkout:

```sh
export DOCKERGRID_API_URL=https://dockergrid-api-50046401737.us-central1.run.app
pnpm farm auth login
pnpm farm images register --label pathtracer-fidelity-cpu --context /tmp/fidelity-context.tar.gz
pnpm farm submit pathtracer-fidelity-cpu --scene gi-basic --samples 4 --width 128 --height 128 --renderers all --cpu 4 --memory-gib 8 --max-retries 0
```

Registration builds the image remotely and discovers its input schema with `--describe`. The CLI and generated web form use that schema. Use **4 CPUs / 8 GiB per task**, and start with a small scene and sample count. Multiple tasks multiply that allocation; software path tracing can be slow.

## Outputs and comparisons

Each task renders into a fresh temporary directory. Existing committed references are not overwritten. Sample thresholds are disabled so the requested sample count is honored. WebGPU waits for completed GPU sample counts and caps each checkpoint; wavefront update counts are not treated as completed samples. Optional width and height overrides apply equally to all three engines, including the camera aspect ratio.

`renderers=all` renders all three engines and runs `fidelity-kit process` to generate comparison metrics and difference images. Selected individual engines produce only their render. Every result file is uploaded with its MIME type, and `outputs.tar.gz` contains the complete results directory for local inspection with fidelity-kit. The WebGPU AVIF carries the `primary` role for preview presentation. Failed processes and missing renders fail the DockerGrid attempt and retain its logs.

For an independent Linux smoke check, run the image's `node docker/check-software.mjs` command; it verifies both adapter identities before rendering. This command needs the image's entrypoint to set its Vulkan ICD environment.

Small sample counts verify execution and integration, not convergence or fidelity equivalence. Use sufficient samples and matching settings before treating RMSE and delta images as regression evidence.

## Verified preview run

The public preview image `pathtracer-fidelity-cpu` completed [job c64ad9fb-630c-4373-a33e-d426faa15a57](https://dockergrid-dashboard-50046401737.us-central1.run.app/jobs/c64ad9fb-630c-4373-a33e-d426faa15a57) on October 2, 2026, with 4 CPUs / 8 GiB, `gi-basic`, 64×64 pixels, and two completed samples per engine. The task produced 18 artifacts: three AVIF renders, four PSNR metric files, four difference images, metadata, and the complete archive. Every artifact downloaded successfully; all seven image previews loaded in the dashboard. Cloud Run reported the requested CPU and memory limits.

Dawn and WebGL software adapter checks passed in Linux Cloud Build. The final Cloud Run task rendered WebGPU in 15.4 seconds, WebGL in 3.6 seconds, and Blender CPU in 5.4 seconds, excluding setup and provisioning. This is an execution smoke test, not a converged fidelity baseline.
