import type { PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/** webgl-legacy: WebGL Legacy (the established three-gpu-pathtracer); webgpu-new: WebGPU New (the WebGPU port). */
export const rendererNames = ['webgl-legacy', 'webgpu-new'] as const;
export type RendererName = (typeof rendererNames)[number];

export interface RendererOptions {
  width: number;
  height: number;
}

/** Incremental renderer over one scene: call render() once per animation frame (browser) or in a loop (node). */
export interface LiveRenderer {
  readonly name: RendererName;
  readonly renderer: WebGPURenderer | WebGLRenderer;
  /** Accumulated path-traced samples. */
  readonly frames: number;
  /** Renders one frame / one full-frame sample to the canvas. */
  render(): void;
  /** Resizes the drawing buffer and the camera aspect. */
  setSize(width: number, height: number): void;
  /** Adopts a new camera pose (pass the scene camera after moving it, e.g. from OrbitControls); restarts path tracing. */
  setCamera(camera: PerspectiveCamera): void;
  dispose(): void;
}
