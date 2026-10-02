import { ACESFilmicToneMapping, Color, DataTexture, Group, PerspectiveCamera, Scene, Vector3 } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneSetup } from '@pathtracer-fidelity/scenes';

const adapter = vi.hoisted(() => ({ renderScene: vi.fn(), outputSettings: vi.fn() }));
vi.mock('fidelity-kit-blender/three', () => adapter);
import { renderBlender } from './blender.js';

const options = { width: 4, height: 2, samples: 16, canvas: {} as HTMLCanvasElement };
function setup(): SceneSetup {
  return {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    target: new Vector3(),
    toneMapping: ACESFilmicToneMapping,
    toneMappingExposure: 1.5,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  adapter.outputSettings.mockReturnValue({
    toneMapping: 'aces-filmic',
    toneMappingExposure: 1.5,
    outputColorSpace: 'srgb',
  });
});

describe('Blender integration', () => {
  it('passes explicit reference settings and keeps the source camera unchanged', async () => {
    const source = setup();
    const pixels = new Uint8Array(32);
    adapter.renderScene.mockResolvedValue({ pixels });
    expect(await renderBlender(source, options)).toBe(pixels);
    expect(source.camera.aspect).toBe(1);
    const call = adapter.renderScene.mock.calls[0]![0];
    expect(call.scene).not.toBe(source.scene);
    expect(call.camera).not.toBe(source.camera);
    expect(call.camera.aspect).toBe(2);
    expect(call).toMatchObject({
      width: 4,
      height: 2,
      samples: 16,
      bounces: 8,
      seed: 1,
      denoise: false,
      adaptiveThreshold: 0,
      unsupported: 'warn',
      features: { areaLights: true, depthOfField: true, textureBackground: true },
      outputColorSpace: 'srgb',
      background: { type: 'color', color: [0, 0, 0] },
    });
  });

  it('passes the noise threshold to Cycles adaptive sampling', async () => {
    adapter.renderScene.mockResolvedValue({ pixels: new Uint8Array(32) });
    await renderBlender(setup(), { ...options, noiseThreshold: 0.005 });
    expect(adapter.renderScene.mock.calls[0]![0]).toMatchObject({ samples: 16, adaptiveThreshold: 0.005 });
  });

  it('preserves matching environment/background identity and parented camera world pose', async () => {
    const source = setup();
    const texture = new DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1);
    source.scene.environment = source.scene.background = texture;
    const parent = new Group();
    parent.position.set(2, 3, 4);
    parent.add(source.camera);
    adapter.renderScene.mockResolvedValue({ pixels: new Uint8Array(32) });
    await renderBlender(source, options);
    const call = adapter.renderScene.mock.calls[0]![0];
    expect(call.scene.background).toBe(call.scene.environment);
    expect(call.scene.environment).toBe(texture);
    expect(call.camera.position.toArray()).toEqual([2, 3, 4]);
    expect(source.camera.position.toArray()).toEqual([0, 0, 0]);
  });

  it('passes gradient colors in linear space', async () => {
    const source = setup();
    source.gradientBackground = { center: new Color(0x808080), edge: new Color(0xffffff) };
    adapter.renderScene.mockResolvedValue({ pixels: new Uint8Array(32) });
    await renderBlender(source, options);
    expect(adapter.renderScene.mock.calls[0]![0].background).toEqual({
      type: 'gradient',
      center: source.gradientBackground.center.toArray(),
      edge: [1, 1, 1],
    });
  });

  it('propagates adapter failures and enables texture background extraction', async () => {
    adapter.renderScene.mockRejectedValue(new Error('Unsupported light type: RectAreaLight'));
    await expect(renderBlender(setup(), options)).rejects.toThrow('RectAreaLight');
    adapter.renderScene.mockClear();
    const source = setup();
    adapter.renderScene.mockResolvedValue({ pixels: new Uint8Array(32) });
    await renderBlender(source, options);
    expect(adapter.renderScene.mock.calls[0]![0].features.textureBackground).toBe(true);
  });
});

it('permits only the explicit approximations shared with the reference pathtracer', async () => {
  adapter.renderScene.mockResolvedValue({ pixels: new Uint8Array(32) });
  await renderBlender(setup(), options);
  const diagnostic = adapter.renderScene.mock.calls[0]![0].onDiagnostic;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    diagnostic('Unsupported light AmbientLight: supply IBL or supported punctual lights');
    diagnostic('Light PointLight distance cutoff is unsupported; set distance=0 or choose warn');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(() => diagnostic('Unsupported material ShaderMaterial')).toThrow('ShaderMaterial');
    expect(() => diagnostic('Light decay=1')).toThrow('decay');
  } finally {
    warn.mockRestore();
  }
});
