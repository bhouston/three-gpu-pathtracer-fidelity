import type { Color, DataTexture, PerspectiveCamera, Scene, ToneMapping, Vector3 } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** Asset access for scene creation: paths are relative to `submodules/three.js/examples/`, or to the repository root with a `@/` prefix. */
export interface SceneContext {
  loadGLTF(path: string): Promise<GLTF>;
  /** Radiance .hdr as an equirect-mapped DataTexture (HDRLoader defaults). */
  loadHDR(path: string): Promise<DataTexture>;
}

/** SSGI (screen-space GI + AO) parameters, as in webgpu_postprocessing_ssgi. */
export interface SSGIEffect {
  sliceCount: number;
  stepCount: number;
  giIntensity: number;
  /** Unset values keep SSGINode defaults. */
  radius?: number;
  thickness?: number;
  aoIntensity?: number;
  useScreenSpaceSampling?: boolean;
  /** AO/GI fade to none between these view distances (webgpu_higharc_ao's terrain/horizon fade). */
  fade?: { start: number; end: number };
}

/** SSR parameters, as in webgpu_postprocessing_ssr / webgpu_postprocessing_ssgi. Unset values keep SSRNode defaults. */
export interface SSREffect {
  maxDistance: number;
  quality?: number;
  blurQuality?: number;
  intensity?: number;
  thickness?: number;
  binaryRefine?: boolean;
}

/** What the three-ss pipeline enables. The pathtracer only uses tone mapping and exposure. */
export interface SceneEffects {
  ssgi?: SSGIEffect;
  ssr?: SSREffect;
  /** Temporal reprojection + recurrent denoising of AO/GI/SSR, with animated noise (ssgi example "temporal"). */
  temporalDenoise: boolean;
  /** SSGINode/SSRNode and temporal denoise chain resolutionScale (default 1). */
  resolutionScale?: number;
  toneMapping: ToneMapping;
  toneMappingExposure: number;
  /** Frames the three-ss pipeline renders before the image is taken (TRAA/denoiser/multi-bounce convergence). */
  frames: number;
}

/** Screen-space radial gradient behind the scene: mix(center, edge, distance(screenUV, 0.5) / 0.5), unclamped. */
export interface GradientBackground {
  center: Color;
  edge: Color;
}

/** An environment defined by a scene that each renderer bakes itself (PMREM for three-ss, cube→equirect for the pathtracer). */
export interface SceneEnvironment {
  scene: Scene;
  /** PMREMGenerator.fromScene blur sigma used by three-ss. */
  sigma: number;
}

export interface SceneSetup {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Point the camera looks at (the example's OrbitControls target), for orbiting in live views. */
  target: Vector3;
  effects: SceneEffects;
  /** World-space ambient occlusion radius of the `ao` pass (scene scale is scene data). */
  aoRadius: number;
  /** Replaces scene.background when set (scene.background must then be null). */
  gradientBackground?: GradientBackground;
  /** Lighting environment; intensity is scene.environmentIntensity. */
  environment?: SceneEnvironment;
}

export interface SceneDefinition {
  name: string;
  description: string;
  width: number;
  height: number;
  create(ctx: SceneContext): Promise<SceneSetup>;
}
