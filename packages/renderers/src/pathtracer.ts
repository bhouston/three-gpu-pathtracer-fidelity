// The legacy renderer and shared geometry/environment utilities come from the pinned fidelity-kit integration.
import { bakeEnvironment, createRenderer } from 'fidelity-kit-three-gpu-pathtracer';
import { SRGBColorSpace } from 'three';
import type { DataTexture, WebGLRenderer } from 'three';
import type { SceneSetup } from '@pathtracer-fidelity/scenes';
import type { LiveRenderer, RendererOptions } from './types.js';

export { assertNotAllBlack, dequantizeAttributes } from 'fidelity-kit-three-gpu-pathtracer';

export const PATHTRACER_BOUNCES = 8;

/** Bake procedural lighting to a readable texture shared with the Blender integration. Caller owns the result. */
export function environmentEquirect(renderer: WebGLRenderer, setup: SceneSetup): DataTexture | null {
  return setup.environment ? bakeEnvironment(renderer, setup.environment.scene) : null;
}

export async function createPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height }: RendererOptions,
): Promise<LiveRenderer> {
  const handle = await createRenderer({
    canvas,
    scene: setup.scene,
    camera: setup.camera,
    width,
    height,
    toneMapping: setup.toneMapping,
    toneMappingExposure: setup.toneMappingExposure,
    outputColorSpace: SRGBColorSpace,
    bounces: PATHTRACER_BOUNCES,
    environment: setup.environment,
    gradientBackground: setup.gradientBackground,
  });
  return {
    name: 'webgl-legacy',
    renderer: handle.renderer,
    get frames() {
      return handle.frames;
    },
    render: () => handle.render(),
    setSize: (w, h) => handle.setSize(w, h),
    setCamera: (camera) => handle.setCamera(camera),
    dispose: () => handle.dispose(),
  };
}
