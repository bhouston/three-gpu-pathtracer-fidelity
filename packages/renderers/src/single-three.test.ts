import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// `three` must resolve to the same npm install for every importer, or core classes (and WebGL/WebGPU state) get
// duplicated
it('resolves one copy of three everywhere', () => {
  const pathtracerEntry = path.join(repoRoot, 'submodules/three-gpu-pathtracer/src/index.js'); // its ESM source entry
  const fromPathtracer = createRequire(pathtracerEntry);
  const importers = {
    renderers: import.meta.url,
    scenes: path.join(repoRoot, 'packages/scenes/package.json'),
    cli: path.join(repoRoot, 'packages/cli/package.json'),
    'three-gpu-pathtracer': pathtracerEntry,
    'three-mesh-bvh': fromPathtracer.resolve('three-mesh-bvh'),
  };
  const threeDir = path.dirname(realpathSync(createRequire(import.meta.url).resolve('three/webgpu')));
  for (const [name, importer] of Object.entries(importers)) {
    const resolved = realpathSync(createRequire(importer).resolve('three/webgpu'));
    expect(path.dirname(resolved), name).toBe(threeDir);
  }
});
