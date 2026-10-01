// webgl-legacy (WebGL Legacy): WebGLRenderer + WebGLPathTracer, the established three-gpu-pathtracer, on the same scene objects.
import {
  BufferAttribute,
  Color,
  CubeCamera,
  HalfFloatType,
  Mesh,
  ShaderChunk,
  ShaderMaterial,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry, DataTexture, Object3D } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { CubeToEquirectGenerator } from 'three-gpu-pathtracer/src/utils/CubeToEquirectGenerator.js';
import type { SceneSetup } from '@pathtracer-fidelity/scenes';
import type { LiveRenderer, RendererOptions } from './types.js';

/** Path tracing bounces (plenty, so the result is close to converged). */
export const PATHTRACER_BOUNCES = 8;

/** Bakes `setup.environment` into a 256² half-float cube map, like the pathtracer does for its own scene.environment. */
function bakeEnvironmentCube(renderer: WebGLRenderer, setup: SceneSetup): WebGLCubeRenderTarget | null {
  if (!setup.environment) return null;
  const cubeTarget = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
  new CubeCamera(0.1, 100, cubeTarget).update(renderer, setup.environment.scene);
  return cubeTarget;
}

/** The lighting environment as an importance-sampled equirect (for exporters that need a single 2D texture, e.g. Blender). */
export function environmentEquirect(renderer: WebGLRenderer, setup: SceneSetup): DataTexture | null {
  const cubeTarget = bakeEnvironmentCube(renderer, setup);
  if (!cubeTarget) return null;
  const equirect = new CubeToEquirectGenerator(renderer).generate(cubeTarget.texture);
  cubeTarget.dispose();
  return equirect;
}

// Final blit, replacing the pathtracer's own: composites the scene's screen-space gradient background under the
// accumulated (premultiplied) radiance before tone mapping, like the raster background, then tone maps and encodes.
function createBlitMaterial(setup: SceneSetup): ShaderMaterial {
  const gradient = setup.gradientBackground;
  return new ShaderMaterial({
    defines: { GRADIENT_BACKGROUND: gradient ? 1 : 0 },
    uniforms: {
      map: { value: null },
      center: { value: gradient?.center ?? new Color() },
      edge: { value: gradient?.edge ?? new Color() },
    },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 center;
      uniform vec3 edge;
      void main() {
        ivec2 size = textureSize( map, 0 );
        vec4 radiance = texelFetch( map, ivec2( gl_FragCoord.xy ), 0 );
        #if GRADIENT_BACKGROUND
        vec2 uv = gl_FragCoord.xy / vec2( size );
        radiance.rgb += mix( center, edge, distance( uv, vec2( 0.5 ) ) / 0.5 ) * ( 1.0 - radiance.a );
        #endif
        gl_FragColor = vec4( radiance.rgb, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// The three.js fork dropped this chunk (PMREM uses cube render targets now); three-gpu-pathtracer's
// CubeToEquirectGenerator still includes it without using it.
(ShaderChunk as Record<string, string>).cube_uv_reflection_fragment ??= '';

/** three-gpu-pathtracer merges the scene into float geometry: expand quantized / interleaved (gltfpack) attributes. */
export function dequantizeAttributes(scene: Object3D): void {
  scene.traverse((object) => {
    const geometry = (object as Mesh).geometry as BufferGeometry | undefined;
    if (!geometry) return;
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (!('isInterleavedBufferAttribute' in attribute) && attribute.array instanceof Float32Array) continue;
      const { count, itemSize } = attribute;
      const array = new Float32Array(count * itemSize);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < itemSize; c++) array[i * itemSize + c] = attribute.getComponent(i, c);
      }
      geometry.setAttribute(name, new BufferAttribute(array, itemSize));
    }
  });
}

export async function createPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height }: RendererOptions,
): Promise<LiveRenderer> {
  dequantizeAttributes(setup.scene);
  const { scene, camera } = setup;
  const renderer = new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.toneMapping = setup.toneMapping;
  renderer.toneMappingExposure = setup.toneMappingExposure;

  // the raster PMREM (RoomEnvironment etc.) as a plain cube map, which the pathtracer converts to an equirect
  const cubeTarget = bakeEnvironmentCube(renderer, setup);
  if (cubeTarget) scene.environment = cubeTarget.texture;

  // primary rays that miss must show the gradient composited in the blit: render them as black and transparent
  if (setup.gradientBackground) scene.background = new Color(0x000000);

  const pathTracer = new WebGLPathTracer(renderer);
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 0;
  pathTracer.minSamples = 0;
  pathTracer.rasterizeScene = false;
  pathTracer.dynamicLowRes = false;
  pathTracer.tiles.set(1, 1); // one renderSample() is one full-frame sample
  pathTracer.bounces = PATHTRACER_BOUNCES;
  pathTracer.filterGlossyFactor = 0; // unbiased

  const blit = new FullScreenQuad(createBlitMaterial(setup));
  pathTracer.renderToCanvasCallback = (target: { texture: unknown }) => {
    (blit.material as ShaderMaterial).uniforms.map!.value = target.texture;
    blit.render(renderer);
  };

  const handle: LiveRenderer = {
    name: 'webgl-legacy',
    renderer,
    get frames() {
      return pathTracer.samples;
    },
    render() {
      pathTracer.renderSample();
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      pathTracer.updateCamera();
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
      pathTracer.updateCamera();
    },
    dispose() {
      blit.dispose();
      blit.material.dispose();
      pathTracer.dispose();
      cubeTarget?.dispose();
      renderer.dispose();
    },
  };

  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  pathTracer.setScene(scene, camera);
  if (setup.gradientBackground) {
    // oxlint-disable-next-line typescript/no-explicit-any -- internal PathTracingRenderer material
    (pathTracer as any)._pathTracer.material.backgroundAlpha = 0;
  }
  return handle;
}
