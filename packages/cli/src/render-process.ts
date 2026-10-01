// Child process entry of `cli render`: renders scenes with one renderer. Each GPU backend (dawn, ANGLE) gets its own
// process, and dawn keeps the event loop alive, so the process exits explicitly.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { PassName, RendererName } from '@pathtracer-fidelity/renderers';

/** A renderer job can also target Blender Cycles, a second ground-truth renderer that isn't a `LiveRenderer`
 * (it renders in one batch call via `renderBlender`, not `createRenderer`'s incremental frame loop). */
export type JobRendererName = RendererName | 'blender';

export interface RenderJob {
  renderer: JobRendererName;
  scenes: string[];
  passes: PassName[];
  outDir: string;
  /** Samples per pixel. */
  samples: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Replaces Math.random with a fixed-seed generator (mulberry32): every render is reproducible. */
function seedRandom(seed = 1): void {
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The only WebGL renderers: the WebGPU path tracer runs on WebGPURenderer. Blender needs
 * a WebGL canvas too, only to bake `setup.environment` into a cube map before exporting it as an equirect EXR. */
function usesWebGL(renderer: JobRendererName): boolean {
  return renderer === 'webgl-legacy' || renderer === 'blender';
}

async function main(job: RenderJob): Promise<void> {
  const headless = usesWebGL(job.renderer) ? await import('./headless/webgl.js') : await import('./headless/webgpu.js');
  headless.install();
  const { createRenderer } = await import('@pathtracer-fidelity/renderers');
  const { getScene } = await import('@pathtracer-fidelity/scenes');
  const { createNodeSceneContext } = await import('@pathtracer-fidelity/scenes/node');
  const { renderPath } = await import('./paths.js');
  const { RESULT_AVIF } = await import('./compare.js');
  const ctx = createNodeSceneContext();

  for (const name of job.scenes) {
    for (const pass of job.passes) {
      await render(name, pass);
    }
  }

  async function render(name: string, pass: PassName): Promise<void> {
    const { width, height, create } = getScene(name);
    const start = performance.now();
    seedRandom(); // before the scene and renderer draw any random numbers
    const setup = await create(ctx);
    const canvas = headless.createCanvas(width, height);
    if (job.renderer === 'blender') return renderBlenderJob(name, pass, setup, canvas, width, height, start);
    const renderer = await createRenderer(job.renderer, canvas, setup, { width, height, pass });
    const target = job.samples;
    const renderStart = performance.now();
    while (renderer.frames < target) {
      headless.animationFrame();
      renderer.render();
      await new Promise((resolve) => setImmediate(resolve)); // lets async shader compilation progress
    }
    const pixels = await headless.readPixels(canvas);
    const renderMs = performance.now() - renderStart;
    const file = renderPath(name, pass, job.renderer, job.outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
    renderer.dispose();
    console.log(
      `${name} | ${pass} | ${job.renderer}: ${target} samples in ${seconds(renderMs)} (setup ${seconds(renderStart - start)}) -> ${path.relative(process.cwd(), file)}`,
    );
  }

  /** Blender is a single batch render, not a `LiveRenderer` with an incremental frame loop: its own branch. */
  // oxlint-disable-next-line typescript/no-explicit-any -- headless SceneSetup import is dynamic (see main())
  async function renderBlenderJob(
    name: string,
    pass: PassName,
    setup: any,
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    start: number,
  ): Promise<void> {
    const { renderBlender } = await import('./blender.js');
    const renderStart = performance.now();
    const pixels = await renderBlender(setup, { width, height, pass, samples: job.samples, canvas });
    const renderMs = performance.now() - renderStart;
    const file = renderPath(name, pass, 'blender', job.outDir);
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .avif(RESULT_AVIF)
      .toFile(file);
    console.log(
      `${name} | ${pass} | blender: ${job.samples} samples in ${seconds(renderMs)} (setup ${seconds(renderStart - start)}) -> ${path.relative(process.cwd(), file)}`,
    );
  }
}

try {
  await main(JSON.parse(process.argv[2]!) as RenderJob);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
