import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listSceneNames } from '../packages/scenes/dist/index.js';
import { batchTasks } from './dockergrid-batch.mjs';

test('full sweep covers every example once per engine and uses native resolution', () => {
  const tasks = batchTasks();
  assert.equal(tasks.length, listSceneNames().length * 3);
  assert.equal(new Set(tasks.map((t) => `${t.scene}/${t.renderer}`)).size, tasks.length);
  assert.deepEqual(new Set(tasks.map((t) => t.renderer)), new Set(['webgpu-new', 'webgl-legacy', 'blender']));
  for (const task of tasks) {
    assert.ok(listSceneNames().includes(task.scene));
    assert.ok(!('width' in task) && !('height' in task) && !('renderers' in task));
    assert.equal(task.samples, 4096);
    assert.equal(task.minSamples, 128);
    assert.equal(task.noiseThreshold, 0.005);
    assert.equal(task.cyclesNoiseThreshold, 0.005);
  }
});

test('CLI glob selection and sampling overrides produce one task per selected pair', () => {
  const tasks = batchTasks({
    scenes: 'gi-room-*',
    renderers: 'blender',
    samples: '2',
    'min-samples': '1',
    'noise-threshold': '0',
    'cycles-noise-threshold': '0',
  });
  assert.equal(tasks.length, 2);
  assert.ok(
    tasks.every(
      (t) =>
        t.renderer === 'blender' &&
        t.samples === 2 &&
        t.minSamples === 1 &&
        t.noiseThreshold === 0 &&
        t.cyclesNoiseThreshold === 0,
    ),
  );
});

test('bad selections and sampling values fail before submission', () => {
  for (const options of [
    { scenes: 'missing' },
    { renderers: 'missing' },
    { samples: '0' },
    { samples: '4097' },
    { samples: '1.5' },
    { 'min-samples': '-1' },
    { 'noise-threshold': 'NaN' },
    { 'cycles-noise-threshold': '2' },
  ]) {
    assert.throws(() => batchTasks(options));
  }
});

test('command stdout is directly usable as farm --params JSON', () => {
  const stdout = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./dockergrid-batch.mjs', import.meta.url)),
      '--scenes',
      'gi-basic',
      '--renderers',
      'webgpu-new',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const tasks = JSON.parse(stdout.toString());
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].scene, 'gi-basic');
  assert.equal(tasks[0].renderer, 'webgpu-new');
});
