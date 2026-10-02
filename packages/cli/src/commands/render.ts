import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { rendererNames } from '@pathtracer-fidelity/renderers';
import { listSceneNames } from '@pathtracer-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { renderPath, resultsDir } from '../paths.js';
import { jobLanes, runOnLanes } from '../queues.js';
import type { RenderJob } from '../render-process.js';
import { selectNames } from '../select.js';

const renderProcess = fileURLToPath(new URL('../render-process.js', import.meta.url));

// Blender Cycles: a second ground-truth reference renderer, alongside webgl-legacy. It isn't a `LiveRenderer`
// built by `createRenderer()` (one batch call, not incremental frames), so it's a CLI-layer renderer name, not part
// of `@pathtracer-fidelity/renderers`' `RendererName`.
const cliRendererNames = [...rendererNames, 'blender'] as const;

/** Defaults calibrated against 4096 spp renders: see docs/adaptive-sampling.md. */
export const DEFAULT_MAX_SAMPLES = 4096;
export const DEFAULT_MIN_SAMPLES = 128;
export const DEFAULT_NOISE_THRESHOLD = 0.005;
export const DEFAULT_CYCLES_NOISE_THRESHOLD = 0.005;

/** Runs one render-process job; resolves with its exit code. */
export function run(job: RenderJob, { priority }: { priority?: number } = {}): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [renderProcess, JSON.stringify(job)], { stdio: 'inherit' });
    if (priority !== undefined && child.pid !== undefined) {
      try {
        os.setPriority(child.pid, priority); // inherited by the Blender process it starts
      } catch {
        // Unsupported platform or insufficient rights: keep the inherited priority.
      }
    }
    child.on('error', reject).on('exit', resolve);
  });
}

export const command = defineCommand({
  command: 'render',
  describe: 'Render scenes with renderers into results/<scene>/beauty/<renderer>.avif',
  builder: (yargs) =>
    yargs
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('renderers', { type: 'string', default: '*', describe: 'Renderer name glob(s), comma separated' })
      .option('width', { type: 'number', describe: 'Override scene width in pixels' })
      .option('height', { type: 'number', describe: 'Override scene height in pixels' })
      .option('samples', {
        type: 'number',
        default: DEFAULT_MAX_SAMPLES,
        describe: 'Maximum samples per pixel (the exact count when the noise thresholds are 0)',
      })
      .option('min-samples', {
        type: 'number',
        default: DEFAULT_MIN_SAMPLES,
        describe: 'Path tracers never stop before this many samples per pixel',
      })
      .option('noise-threshold', {
        type: 'number',
        default: DEFAULT_NOISE_THRESHOLD,
        describe: 'Path tracers stop once the 99th-percentile 16 px tile RMS noise (sRGB, 0-1) reaches this; 0 = fixed',
      })
      .option('cycles-noise-threshold', {
        type: 'number',
        default: DEFAULT_CYCLES_NOISE_THRESHOLD,
        describe: "Blender Cycles' per-pixel adaptive sampling noise threshold; 0 = fixed samples",
      })
      .option('blender-device', {
        choices: ['auto', 'cpu', 'gpu'] as const,
        default: 'auto' as const,
        describe: "Cycles device: auto renders on whichever lane is free, on that lane's device",
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' })
      .option('missing-only', {
        type: 'boolean',
        default: false,
        describe: 'Skip scene/renderer pairs whose render already exists',
      }),
  handler: async (argv) => {
    for (const dimension of [argv.width, argv.height]) {
      if (dimension !== undefined && (!Number.isInteger(dimension) || dimension < 16 || dimension > 8192)) {
        throw new Error('Render dimensions must be integers between 16 and 8192');
      }
    }
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const renderers = selectNames(cliRendererNames, argv.renderers, 'renderer') as RenderJob['renderer'][];
    // one child process per renderer and scene: dawn and ANGLE don't share a process reliably, and GPU state leaked
    // from one scene's renderer into the next scene's so no result may depend on what rendered before it
    const jobs: RenderJob[] = [];
    for (const renderer of renderers) {
      for (const scene of scenes) {
        if (argv.missingOnly && existsSync(renderPath(scene, renderer, argv.output))) continue;
        jobs.push({
          renderer,
          scenes: [scene],
          outDir: argv.output,
          samples: argv.samples,
          width: argv.width,
          height: argv.height,
          minSamples: argv.minSamples,
          noiseThreshold: argv.noiseThreshold,
          cyclesNoiseThreshold: argv.cyclesNoiseThreshold,
          blenderDevice: argv.blenderDevice,
        });
      }
    }
    let failed = false;
    await runOnLanes(
      jobs,
      (job) => jobLanes(job.renderer, argv.blenderDevice),
      async (job, lane) => {
        const name = `${job.scenes.join(',')} | ${job.renderer}`;
        try {
          // Blender renders on its lane's device: never a silent CPU fallback that would compete with the CPU lane.
          // CPU renders yield to the GPU lane, whose renderers need a core to drive the GPU.
          const code = await run(job.renderer === 'blender' ? { ...job, blenderDevice: lane } : job, {
            priority: lane === 'cpu' ? os.constants.priority.PRIORITY_LOW : undefined,
          });
          if (code !== 0) throw new Error(`exit code ${code}`);
        } catch (error) {
          console.error(`${name} failed (${error instanceof Error ? error.message : String(error)})`);
          failed = true;
        }
      },
    );
    if (failed) process.exitCode = 1;
  },
});
