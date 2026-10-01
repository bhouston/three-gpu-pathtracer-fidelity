import { describe, expect, it } from 'vitest';
import { getScene, listSceneNames } from './index.js';
import { createNodeSceneContext } from './node.js';

describe('scene registry', () => {
  it('has unique kebab/snake-case names', () => {
    const names = listSceneNames();
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+([-_][a-z0-9]+)*$/);
  });

  it('throws on unknown scenes', () => {
    expect(() => getScene('nope')).toThrow(/Unknown scene/);
  });

  it.each(listSceneNames())('creates %s', async (name) => {
    const definition = getScene(name);
    const { scene, camera, effects } = await definition.create(createNodeSceneContext());
    expect(camera.aspect).toBeCloseTo(definition.width / definition.height);
    expect(effects.frames).toBeGreaterThan(0);
    let meshes = 0;
    scene.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh) meshes++;
    });
    expect(meshes).toBeGreaterThan(1);
  });
});
