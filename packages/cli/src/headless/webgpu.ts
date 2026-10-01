// Headless WebGPU (dawn `webgpu` package) with a minimal canvas, ported from vitest-environment-webgpu-node.
import { create, globals } from 'webgpu';

const COPY_SRC = 0x01;
const RENDER_ATTACHMENT = 0x10;
const MAP_READ = 0x01;
const COPY_DST = 0x08;

/** Minimal GPUCanvasContext: getCurrentTexture() is a COPY_SRC texture the size of the canvas, kept until resized. */
class HeadlessCanvasContext {
  private config: GPUCanvasConfiguration | undefined;
  private texture: GPUTexture | undefined;

  constructor(readonly canvas: HeadlessCanvas) {}

  configure(config: GPUCanvasConfiguration): void {
    this.config = config;
    this.drop();
  }

  unconfigure(): void {
    this.config = undefined;
    this.drop();
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    return this.config ?? null;
  }

  getCurrentTexture(): GPUTexture {
    const config = this.config;
    if (!config) throw new Error('getCurrentTexture() called before configure()');
    const { width, height } = this.canvas;
    if (this.texture && (this.texture.width !== width || this.texture.height !== height)) this.drop();
    this.texture ??= config.device.createTexture({
      size: [width, height],
      format: config.format,
      usage: (config.usage ?? RENDER_ATTACHMENT) | RENDER_ATTACHMENT | COPY_SRC,
      viewFormats: config.viewFormats,
    });
    return this.texture;
  }

  /** RGBA8, top row first (BGRA canvases are swizzled). */
  async readPixels(): Promise<Uint8Array> {
    const config = this.config;
    if (!config) throw new Error('readPixels() called before configure()');
    const { device, format } = config;
    const texture = this.getCurrentTexture();
    const { width, height } = texture;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: MAP_READ | COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      data.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    buffer.destroy();
    if (format.startsWith('bgra')) {
      for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2]!, data[i]!];
    }
    return data;
  }

  private drop(): void {
    this.texture?.destroy();
    this.texture = undefined;
  }
}

/** Enough of HTMLCanvasElement for WebGPURenderer. */
class HeadlessCanvas {
  readonly context = new HeadlessCanvasContext(this);
  readonly style: Record<string, string> = {};

  constructor(
    public width: number,
    public height: number,
  ) {}

  get clientWidth(): number {
    return this.width;
  }

  get clientHeight(): number {
    return this.height;
  }

  getContext(id: string): HeadlessCanvasContext | null {
    return id === 'webgpu' ? this.context : null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, width: this.width, height: this.height };
  }

  setAttribute(): void {}
  getAttribute(): null {
    return null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

const frameCallbacks = new Map<number, (time: number) => void>();
let frameCallbackId = 0;

/**
 * One display frame: runs the pending requestAnimationFrame callbacks, as a browser does before the page renders.
 * Call it before each rendered frame. A timer-driven requestAnimationFrame advanced three's frame counter (velocity
 * history, per-frame noise) at wall-clock pace instead, so renders weren't reproducible.
 */
export function animationFrame(): void {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  const time = performance.now();
  for (const callback of callbacks) callback(time);
}

/** Installs dawn's WebGPU globals; must run before three is imported. */
export function install(): void {
  const scope = globalThis as Record<string, unknown>;
  Object.assign(scope, globals);
  // disable_timestamp_quantization: dawn rounds GPUQuerySet timestamp results to a coarse granularity by
  // default (a WebGPU spec mitigation against timing side-channels), which inflates `cli bench --gpu`'s
  // per-pass GPU timings well past wall-clock time when many short passes each round up. Safe in this
  // headless benchmark process (no browser sandbox to protect). allow_unsafe_apis is required to unlock it.
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: create(['enable-dawn-features=allow_unsafe_apis,disable_timestamp_quantization']),
    configurable: true,
  });
  scope.self ??= globalThis;
  // frame callbacks (three's renderer loop advances its node frame counter here) run only in animationFrame()
  scope.requestAnimationFrame = (callback: (time: number) => void) => {
    frameCallbacks.set(++frameCallbackId, callback);
    return frameCallbackId;
  };
  scope.cancelAnimationFrame = (id: number) => frameCallbacks.delete(id);
  scope.HTMLCanvasElement ??= HeadlessCanvas;
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  return new HeadlessCanvas(width, height) as unknown as HTMLCanvasElement;
}

export function readPixels(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return (canvas as unknown as HeadlessCanvas).context.readPixels();
}
