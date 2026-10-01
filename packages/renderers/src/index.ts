import type { SceneSetup } from '@pathtracer-fidelity/scenes';
import { createPathTracerRenderer } from './pathtracer.js';
import { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';
import type { LiveRenderer, RendererName, RendererOptions } from './types.js';

export * from './types.js';
export { createPathTracerRenderer, environmentEquirect, PATHTRACER_BOUNCES } from './pathtracer.js';
export { createWebGPUPathTracerRenderer } from './pathtracer-webgpu.js';

export function createRenderer(
  name: RendererName,
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  options: RendererOptions,
): Promise<LiveRenderer> {
  switch (name) {
    case 'webgl-legacy':
      return createPathTracerRenderer(canvas, setup, options);
    case 'webgpu-new':
      return createWebGPUPathTracerRenderer(canvas, setup, options);
    default:
      throw new Error(`Unknown renderer "${name}"`);
  }
}
