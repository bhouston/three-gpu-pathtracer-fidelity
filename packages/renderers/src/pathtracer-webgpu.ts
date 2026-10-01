// webgpu-new (WebGPU New): WebGPURenderer + WebGPUPathTracer, a second, independently-implemented path-traced
// reference (see issue #34) run alongside the existing WebGL WebGLPathTracer (pathtracer.ts) to cross-check it:
// if both converge to the same image that's evidence the WebGL reference is correct; if they diverge, that's a
// real finding about at least one of them, not a bug in this file.
import {
  AdditiveBlending,
  Color,
  CubeCamera,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  WebGLCubeRenderTarget,
} from 'three';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, WebGPURenderer } from 'three/webgpu';
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import type { Material, Mesh } from 'three';
import {
  cameraPosition,
  cubeTexture,
  dFdx,
  float,
  Fn,
  uv,
  vec3,
  dFdy,
  normalWorld,
  positionWorld,
  screenCoordinate,
  select,
  vec4,
  ivec2,
  texture,
  uniform,
} from 'three/tsl';
import { BVHComputeData, rayIntersectionResultStruct, rayStruct, wgslTagFn } from 'three-mesh-bvh/webgpu';
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

// ao: a WebGPU port of pathtracer.ts's createAORenderer (three-gpu-pathtracer's AmbientOcclusionMaterial, which
// three-gpu-pathtracer/webgpu lacks): the scene is rasterized with an override material that casts one cosine-weighted
// hemisphere ray per pixel against a three-mesh-bvh BVH; a hit within `radius` occludes. Mean over frames;
// the background is unoccluded (1).
const aoSampleFn = (bvh: BVHComputeData) => wgslTagFn /* wgsl */ `
  fn aoSample( position: vec3f, normalIn: vec3f, faceIn: vec3f, toCamera: vec3f, pixel: vec2f, seed: u32, radius: f32 ) -> f32 {
    // the flat face normal and the shading normal, both turned to the viewer's side (gl_FrontFacing in the WebGL one)
    var face = normalize( faceIn );
    if ( dot( face, toCamera ) < 0.0 ) { face = - face; }
    var n = normalize( normalIn );
    if ( dot( n, face ) < 0.0 ) { n = - n; }

    // pcg hash of pixel + frame
    var state = u32( pixel.x ) * 1973u + u32( pixel.y ) * 9277u + seed * 26699u;
    state = state * 747796405u + 2891336453u;
    var word = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
    let r1 = f32( ( word >> 22u ) ^ word ) / 4294967295.0;
    state = state * 747796405u + 2891336453u;
    word = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
    let r2 = f32( ( word >> 22u ) ^ word ) / 4294967295.0;

    // cosine-weighted hemisphere about n
    let t = select( vec3f( 1.0, 0.0, 0.0 ), vec3f( 0.0, 1.0, 0.0 ), abs( n.x ) > 0.9 );
    let tangent = normalize( cross( t, n ) );
    let bitangent = cross( n, tangent );
    let phi = 6.283185307 * r1;
    let sinTheta = sqrt( r2 );
    let direction = normalize( tangent * cos( phi ) * sinTheta + bitangent * sin( phi ) * sinTheta + n * sqrt( 1.0 - r2 ) );
    if ( dot( direction, face ) <= 0.0 ) { return 0.0; }

    let absPoint = abs( position );
    let maxPoint = max( absPoint.x, max( absPoint.y, absPoint.z ) );
    let ray = ${rayStruct}( position + face * ( maxPoint + 1.0 ) * 1e-4, direction, radius );
    var hit: ${rayIntersectionResultStruct};
    if ( ${bvh.fns.raycastFirstHit}( ray, &hit ) && hit.dist < radius ) { return 0.0; }
    return 1.0;
  }
`;

async function createAORenderer(canvas: HTMLCanvasElement, setup: SceneSetup, width: number, height: number) {
  const { scene, camera } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false; // `sum` accumulates across frames
  await renderer.init();

  // transparent objects don't occlude in the AO pass
  scene.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    if ([material ?? []].flat().some((m) => m.transparent)) object.visible = false;
  });
  scene.background = null;
  scene.updateMatrixWorld(true);
  const bvh = new BVHComputeData(scene);
  bvh.update();

  const seed = uniform(0, 'uint');
  // mean over frames: each frame's sample (rgb, alpha 1 where covered) is added into `sum`, whose alpha then counts
  // the frames a pixel was covered
  const targetOptions = { type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter };
  const sampleTarget = new RenderTarget(width, height, targetOptions);
  const sum = new RenderTarget(width, height, { ...targetOptions, depthBuffer: false });
  const sample = aoSampleFn(bvh)(
    positionWorld,
    normalWorld,
    dFdx(positionWorld).cross(dFdy(positionWorld)),
    cameraPosition.sub(positionWorld),
    screenCoordinate,
    seed,
    uniform(setup.aoRadius),
  );
  const aoMaterial = new MeshBasicNodeMaterial();
  aoMaterial.outputNode = vec4(vec3(sample), 1);
  scene.overrideMaterial = aoMaterial;

  const addMaterial = new MeshBasicNodeMaterial({ blending: AdditiveBlending });
  addMaterial.outputNode = texture(sampleTarget.texture).load(ivec2(screenCoordinate));
  const add = new QuadMesh(addMaterial);

  const blitMaterial = new MeshBasicNodeMaterial();
  const accumulated = texture(sum.texture).load(ivec2(screenCoordinate));
  blitMaterial.colorNode = vec3(select(accumulated.a.greaterThan(0), accumulated.r.div(accumulated.a), float(1)));
  const blit = new QuadMesh(blitMaterial);
  let frames = 0;

  const handle: LiveRenderer = {
    name: 'webgpu-new',
    renderer,
    get frames() {
      return frames;
    },
    render() {
      frames++;
      seed.value = frames;
      renderer.setRenderTarget(sampleTarget);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(sum);
      if (frames === 1) renderer.clear();
      add.render(renderer);
      renderer.setRenderTarget(null);
      blit.render(renderer);
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      sampleTarget.setSize(w, h);
      sum.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      frames = 0;
    },
    setCamera(newCamera) {
      if (newCamera !== camera) camera.copy(newCamera);
      frames = 0;
    },
    dispose() {
      blit.dispose();
      blitMaterial.dispose();
      aoMaterial.dispose();
      add.dispose();
      addMaterial.dispose();
      sampleTarget.dispose();
      sum.dispose();
      renderer.dispose();
    },
  };
  handle.setSize(width, height);
  return handle;
}

export async function createWebGPUPathTracerRenderer(
  canvas: HTMLCanvasElement,
  setup: SceneSetup,
  { width, height, pass }: RendererOptions,
): Promise<LiveRenderer> {
  dequantizeAttributes(setup.scene);
  if (pass === 'ao') return createAORenderer(canvas, setup, width, height);
  const { scene, camera, effects } = setup;
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  renderer.toneMapping = effects.toneMapping;
  renderer.toneMappingExposure = effects.toneMappingExposure;
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
  // direct: approximates traceDirectOnly's 2-bounce single-scatter patch (see pathtracer.ts) by capping bounces;
  // the megakernel/wavefront kernels don't expose the fragment-shader string this repo's WebGL patch relies on.
  pathTracer.maxBounces = pass === 'direct' ? 2 : PATHTRACER_BOUNCES;
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
