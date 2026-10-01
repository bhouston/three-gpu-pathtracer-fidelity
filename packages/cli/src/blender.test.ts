import { ACESFilmicToneMapping, Color, Group, LinearToneMapping, NoToneMapping, RectAreaLight, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { encodeLinear, extractAreaLights } from './blender.js';

describe('extractAreaLights', () => {
  it('removes area lights and keeps world pose, unscaled size and radiance', () => {
    const scene = new Scene();
    const group = new Group();
    group.scale.setScalar(0.5); // like the model list's normalization: size is in world units already
    group.position.set(1, 0, 0);
    group.rotation.y = Math.PI / 2;
    const light = new RectAreaLight(0xffffff, 3, 2, 4);
    light.position.set(0, 2, 0);
    (light as unknown as { isCircular: boolean }).isCircular = true;
    group.add(light);
    scene.add(group);

    const [area] = extractAreaLights(scene);
    expect(light.parent).toBeNull();
    expect(area!.position.map((v) => +v.toFixed(6))).toEqual([1, 1, 0]);
    expect(area!.quaternion.map((v) => +v.toFixed(6))).toEqual([
      0,
      +Math.SQRT1_2.toFixed(6),
      0,
      +Math.SQRT1_2.toFixed(6),
    ]);
    expect(area).toMatchObject({ width: 2, height: 4, circular: true, color: [1, 1, 1], intensity: 3 });
  });
});

describe('encodeLinear', () => {
  it('flips EXR rows to top-first and encodes sRGB', () => {
    // 1x2, bottom row first: bottom 0.5 opaque, top 0 opaque
    const linear = new Float32Array([0.5, 0.5, 0.5, 1, 0, 0, 0, 1]);
    const out = encodeLinear(linear, 1, 2, 'environment', NoToneMapping, 1);
    expect([...out]).toEqual([0, 0, 0, 255, 188, 188, 188, 255]);
  });

  it('composites the background under transparent pixels', () => {
    const grey = new Color(0x808080); // linear internally, like the scenes' colors
    const out = encodeLinear(new Float32Array(4), 1, 1, { center: grey, edge: grey }, NoToneMapping, 1);
    expect([...out]).toEqual([128, 128, 128, 255]);
  });

  it('applies ACES filmic like three.js and clamps', () => {
    const black = encodeLinear(new Float32Array([0, 0, 0, 1]), 1, 1, 'environment', ACESFilmicToneMapping, 1);
    const bright = encodeLinear(new Float32Array([100, 100, 100, 1]), 1, 1, 'environment', ACESFilmicToneMapping, 1);
    expect([...black]).toEqual([0, 0, 0, 255]);
    expect([...bright]).toEqual([255, 255, 255, 255]);
  });

  it('rejects tone mappings it does not implement', () => {
    expect(() => encodeLinear(new Float32Array(4), 1, 1, 'environment', LinearToneMapping, 1)).toThrow('unsupported');
  });
});
