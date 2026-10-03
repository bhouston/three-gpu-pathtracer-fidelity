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
  /** Render updates; wavefront updates advance bounces. Query completed samples when available. */
  readonly frames: number;
  /** Advances and presents the renderer. Wavefront paths need several updates to complete. */
  render(): void;
  /** Wavefront backends complete paths over multiple updates; cap and measure actual samples. */
  setSampleLimit?(samples: number): void;
  getCompletedSamples?(): Promise<number>;
  /** Resizes the drawing buffer and the camera aspect. */
  setSize(width: number, height: number): void;
  /** Adopts a new camera pose (pass the scene camera after moving it, e.g. from OrbitControls); restarts path tracing. */
  setCamera(camera: PerspectiveCamera): void;
  dispose(): void;
}
