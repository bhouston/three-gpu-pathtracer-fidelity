import type { Color, DataTexture, PerspectiveCamera, Scene, ToneMapping, Vector3 } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** Asset access for scene creation: paths are relative to `submodules/three.js/examples/`, or to the repository root with a `@/` prefix. */
export interface SceneContext {
  loadGLTF(path: string): Promise<GLTF>;
  /** Radiance .hdr as an equirect-mapped DataTexture (HDRLoader defaults). */
  loadHDR(path: string): Promise<DataTexture>;
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
  toneMapping: ToneMapping;
  toneMappingExposure: number;
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
