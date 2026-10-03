// webgpu-new (WebGPU New): WebGPURenderer + WebGPUPathTracer, a second, independently-implemented path-traced
// reference (see issue #34) run alongside the existing WebGL WebGLPathTracer (pathtracer.ts) to cross-check it:
// if both converge to the same image that's evidence the WebGL reference is correct; if they diverge, that's a
// real finding about at least one of them, not a bug in this file.
import {
  Color,
  CubeCamera,
  DataTexture,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  WebGLCubeRenderTarget,
} from 'three';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, WebGPURenderer } from 'three/webgpu';
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import { cubeTexture, float, Fn, uv, vec3 } from 'three/tsl';
import type { SceneSetup } from '@pathtracer-fidelity/scenes';
import { dequantizeAttributes, PATHTRACER_BOUNCES } from './pathtracer.js';
import type { LiveRenderer, RendererOptions } from './types.js';

// Fragment direction for an equirectangular UV (inverse of the standard equirect-uv-from-direction mapping).
const directionFromEquirectUV = Fn(([uvNode]: [ReturnType<typeof uv>]) => {
  const theta = uvNode.x.sub(0.5).mul(float(Math.PI * 2));
  const phi = uvNode.y.sub(0.5).mul(float(-Math.PI));
  const cosPhi = phi.cos();
  return vec3(theta.sin().mul(cosPhi), phi.sin(), theta.cos().mul(cosPhi).negate());
});

/**
 * Bakes a scene into an equirectangular environment DataTexture for WebGPUPathTracer.
 *
 * WebGPUPathTracer's environment importance sampling (EquirectHdrInfoUniform.updateFrom) reads CPU-side pixel
 * data off a DataTexture's `.image.data`, same as what three-gpu-pathtracer's WebGL-only CubeToEquirectGenerator
 * produces via a synchronous `renderer.readRenderTargetPixels` -- a method WebGPURenderer doesn't have. So the
 * scene is rasterized to a cube map, converted to an equirect render target GPU-side with a TSL fullscreen quad
 * (CubeCamera and QuadMesh both support WebGPURenderer), then read back with the async WebGPU equivalent and
 * wrapped in a plain DataTexture the same way the WebGL path produces one.
 */
async function bakeEquirectEnvironment(
  renderer: WebGPURenderer,
  environment: NonNullable<SceneSetup['environment']>,
): Promise<DataTexture> {
  const cubeTarget = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
  const cubeCamera = new CubeCamera(0.1, 100, cubeTarget);
  cubeCamera.update(renderer, environment.scene);

  const material = new MeshBasicNodeMaterial();
  material.colorNode = cubeTexture(cubeTarget.texture, directionFromEquirectUV(uv()));
  const quad = new QuadMesh(material);
  const width = 512;
  const height = 256;
  const equirectTarget = new RenderTarget(width, height, { type: HalfFloatType });
  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(equirectTarget);
  quad.render(renderer);
  renderer.setRenderTarget(previousTarget);

  const pixels = await renderer.readRenderTargetPixelsAsync(equirectTarget, 0, 0, width, height);

  material.dispose();
  quad.dispose();
  cubeTarget.dispose();
  equirectTarget.dispose();

  const texture = new DataTexture(pixels, width, height, RGBAFormat, HalfFloatType);
  texture.mapping = EquirectangularReflectionMapping;
  texture.wrapS = RepeatWrapping;
  // No mipmaps: a single-sample equirect fetch, and half-float render targets can't generate them under WebGPU.
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export async function createWebGPUPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height }: RendererOptions,
): Promise<LiveRenderer> {
  dequantizeAttributes(setup.scene);
  const { scene, camera } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  renderer.toneMapping = setup.toneMapping;
  renderer.toneMappingExposure = setup.toneMappingExposure;
  await renderer.init();

  let environmentTexture: DataTexture | undefined;
  if (setup.environment) {
    environmentTexture = await bakeEquirectEnvironment(renderer, setup.environment);
    scene.environment = environmentTexture;
  }

  // WebGPUPathTracer reads scene.background as a flat Color/Texture (updateEnvironment()), not a screen-space
  // gradient node: there is no renderToCanvasCallback hook here to composite a gradient under the radiance like
  // pathtracer.ts's blit shader does.
  // ponytail: approximated as a flat color at the gradient's center; the handful of gradient-background scenes
  // will show extra divergence from the WebGL reference near their edges. Revisit with a custom present pass if
  // that turns out to matter for the comparison.
  if (setup.gradientBackground) scene.background = new Color(setup.gradientBackground.center);

  const pathTracer = new WebGPUPathTracer(renderer);
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 0;
  pathTracer.minSamples = 0;
  pathTracer.dynamicLowRes = false;
  pathTracer.maxSamples = 0; // never auto-stop; the render loop decides when enough samples have accumulated
  pathTracer.maxBounces = PATHTRACER_BOUNCES;
  pathTracer.filterGlossyFactor = 0; // unbiased, matching the WebGL reference

  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  // one renderSample() call dispatches ~one sample per pixel, comparable to the WebGL reference's tiles.set(1, 1)
  pathTracer.frameBudget = width * height;
  pathTracer.setScene(scene, camera);

  let frames = 0;
  const handle: LiveRenderer = {
    name: 'webgpu-new',
    renderer,
    get frames() {
      return frames;
    },
    render() {
      pathTracer.renderSample();
      frames++;
    },
    setSampleLimit(samples) {
      pathTracer.maxSamples = samples;
    },
    async getCompletedSamples() {
      return (await pathTracer.getSampleCountsAsync()).min;
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      pathTracer.frameBudget = w * h;
      pathTracer.updateCamera();
      frames = 0;
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
      pathTracer.updateCamera();
      frames = 0;
    },
    dispose() {
      pathTracer.dispose();
      environmentTexture?.dispose();
      renderer.dispose();
    },
  };

  return handle;
}
