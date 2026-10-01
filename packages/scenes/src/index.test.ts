import { describe, expect, it } from 'vitest';
import { getScene, listSceneNames } from './index.js';
import { createNodeSceneContext } from './node.js';

describe('scene registry', () => {
  it('has unique names', () => {
    const names = listSceneNames();
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9]+([-_][A-Za-z0-9]+)*$/);
  });

  it('throws on unknown scenes', () => {
    expect(() => getScene('nope')).toThrow(/Unknown scene/);
  });

  it.each(listSceneNames())('creates %s', async (name) => {
    const definition = getScene(name);
    const { scene, camera } = await definition.create(createNodeSceneContext());
    expect(camera.aspect).toBeCloseTo(definition.width / definition.height);
    let meshes = 0;
    scene.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh) meshes++;
    });
    expect(meshes).toBeGreaterThan(0);
  });
});
