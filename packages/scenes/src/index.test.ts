import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getScene, listSceneNames } from './index.js';
import { createNodeSceneContext } from './node.js';

/** The model submodules are large; CI checks out only the code submodules and skips loading every scene. */
const assetSubmodules = ['glTF-Sample-Assets', '3d-demo-data', 'ldraw-parts-library'];
const assetsAvailable = assetSubmodules.every((name) => {
  try {
    return readdirSync(fileURLToPath(new URL(`../../../submodules/${name}`, import.meta.url))).length > 0;
  } catch {
    return false;
  }
});

describe('scene registry', () => {
  it('has unique names', () => {
    const names = listSceneNames();
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9]+([-_][A-Za-z0-9]+)*$/);
  });

  it('throws on unknown scenes', () => {
    expect(() => getScene('nope')).toThrow(/Unknown scene/);
  });

  it.skipIf(!assetsAvailable).each(listSceneNames())(
    'creates %s',
    async (name) => {
      const definition = getScene(name);
      const { scene, camera } = await definition.create(createNodeSceneContext());
      expect(camera.aspect).toBeCloseTo(definition.width / definition.height);
      let meshes = 0;
      scene.traverse((object) => {
        if ((object as { isMesh?: boolean }).isMesh) meshes++;
      });
      expect(meshes).toBeGreaterThan(0);
    },
    300_000,
  );
});
