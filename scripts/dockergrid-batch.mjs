#!/usr/bin/env node
/** Generate the normal CLI scene/renderer sweep as independent DockerGrid tasks. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { listSceneNames } from '../packages/scenes/dist/index.js';
import { rendererNames } from '../packages/renderers/dist/index.js';
import { selectNames } from '../packages/cli/dist/select.js';
import {
  DEFAULT_MAX_SAMPLES,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_NOISE_THRESHOLD,
  DEFAULT_CYCLES_NOISE_THRESHOLD,
} from '../packages/cli/dist/commands/render.js';

function number(value, fallback, name, max, integer = false) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < 0 || result > max || (integer && !Number.isInteger(result))) {
    throw new Error(`Invalid ${name}`);
  }
  return result;
}

export function batchTasks(options = {}) {
  const scenes = selectNames(listSceneNames(), options.scenes ?? '*', 'scene');
  const renderers = selectNames([...rendererNames, 'blender'], options.renderers ?? '*', 'renderer');
  const samples = number(options.samples, DEFAULT_MAX_SAMPLES, 'samples', 4096, true);
  if (samples < 1) throw new Error('Invalid samples');
  const minSamples = number(options['min-samples'], DEFAULT_MIN_SAMPLES, 'min-samples', 4096, true);
  const noiseThreshold = number(options['noise-threshold'], DEFAULT_NOISE_THRESHOLD, 'noise-threshold', 1);
  const cyclesNoiseThreshold = number(
    options['cycles-noise-threshold'],
    DEFAULT_CYCLES_NOISE_THRESHOLD,
    'cycles-noise-threshold',
    1,
  );
  return renderers.flatMap((renderer) =>
    scenes.map((scene) => ({
      scene,
      renderer,
      samples,
      minSamples,
      noiseThreshold,
      cyclesNoiseThreshold,
    })),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['scenes', 'renderers', 'samples', 'min-samples', 'noise-threshold', 'cycles-noise-threshold'].map((name) => [
        name,
        { type: 'string' },
      ]),
    ),
  });
  const tasks = batchTasks(values);
  console.error(
    `${tasks.length} tasks: ${new Set(tasks.map((t) => t.scene)).size} examples × ${new Set(tasks.map((t) => t.renderer)).size} renderers; native resolution`,
  );
  console.log(JSON.stringify(tasks, null, 2));
}
