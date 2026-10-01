import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rendererNames } from '@pathtracer-fidelity/renderers';
import { listSceneNames } from '@pathtracer-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';
import { renderPath, resultsDir } from '../paths.js';
import type { RenderJob } from '../render-process.js';
import { selectNames } from '../select.js';

const renderProcess = fileURLToPath(new URL('../render-process.js', import.meta.url));

// Blender Cycles: a second ground-truth reference renderer, alongside webgl-legacy. It isn't a `LiveRenderer`
// built by `createRenderer()` (one batch call, not incremental frames), so it's a CLI-layer renderer name, not part
// of `@pathtracer-fidelity/renderers`' `RendererName`.
const cliRendererNames = [...rendererNames, 'blender'] as const;

/** Runs one render-process job; resolves with its exit code. */
export function run(job: RenderJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [renderProcess, JSON.stringify(job)], { stdio: 'inherit' })
      .on('error', reject)
      .on('exit', resolve);
  });
}

export const command = defineCommand({
  command: 'render',
  describe: 'Render scenes with renderers into results/<scene>/beauty/<renderer>.avif',
  builder: (yargs) =>
    yargs
      .option('scenes', { type: 'string', default: '*', describe: 'Scene name glob(s), comma separated' })
      .option('renderers', { type: 'string', default: '*', describe: 'Renderer name glob(s), comma separated' })
      .option('samples', {
        type: 'number',
        default: 4096,
        describe: 'Samples per pixel',
      })
      .option('output', { type: 'string', default: resultsDir, describe: 'Results directory' })
      .option('missing-only', {
        type: 'boolean',
        default: false,
        describe: 'Skip scene/renderer pairs whose render already exists',
      }),
  handler: async (argv) => {
    const scenes = selectNames(listSceneNames(), argv.scenes, 'scene');
    const renderers = selectNames(cliRendererNames, argv.renderers, 'renderer') as RenderJob['renderer'][];
    let failed = false;
    // one child process per renderer and scene: dawn and ANGLE don't share a process reliably, and GPU state leaked
    // from one scene's renderer into the next scene's so no
    // result may depend on what rendered before it
    for (const renderer of renderers) {
      for (const scene of scenes) {
        if (argv.missingOnly && existsSync(renderPath(scene, renderer, argv.output))) continue;
        const code = await run({ renderer, scenes: [scene], outDir: argv.output, samples: argv.samples });
        if (code !== 0) {
          console.error(`${scene} | ${renderer} failed (exit code ${code})`);
          failed = true;
        }
      }
    }
    if (failed) process.exitCode = 1;
  },
});
