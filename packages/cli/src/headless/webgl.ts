// Headless WebGL2 (ANGLE via @onirenaud/node-webgl).
import { createCanvas as createWebGLCanvas, installDOM } from '@onirenaud/node-webgl';

/** Installs the DOM shims (window, document, Image, ...); must run before three is imported. */
export function install(): void {
  installDOM();
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  return createWebGLCanvas(width, height) as unknown as HTMLCanvasElement;
}

/** RGBA8, top row first. */
export async function readPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const { data } = (canvas as unknown as ReturnType<typeof createWebGLCanvas>).getImageData();
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** WebGL renderers here don't use the animation loop. */
export function animationFrame(): void {}
