import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const threeBuild = realpathSync(path.join(repoRoot, 'submodules/three.js/build'));

// `three` must be the submodule fork for every importer, or core classes (and WebGL/WebGPU state) get duplicated
it('resolves one copy of three (the submodule) everywhere', () => {
  const pathtracerEntry = path.join(repoRoot, 'submodules/three-gpu-pathtracer/src/index.js'); // its ESM source entry
  const fromPathtracer = createRequire(pathtracerEntry);
  const importers = {
    renderers: import.meta.url,
    scenes: path.join(repoRoot, 'packages/scenes/package.json'),
    cli: path.join(repoRoot, 'packages/cli/package.json'),
    'three-gpu-pathtracer': pathtracerEntry,
    'three-mesh-bvh': fromPathtracer.resolve('three-mesh-bvh'),
  };
  for (const [name, importer] of Object.entries(importers)) {
    // The fork's build/dev scripts produce ESM bundles, not its historical three.cjs entry.
    // This condition-independent export checks package identity without requiring a stale CJS build.
    const resolved = realpathSync(createRequire(importer).resolve('three/webgpu'));
    expect(path.dirname(resolved), name).toBe(threeBuild);
  }
});
