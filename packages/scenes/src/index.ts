import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { khronosScenes } from './khronos.js';
import { RGBAKTX2Loader } from './ktx2.js';
import { giDiagnosticScenes } from './gi-diagnostics.js';
import { ssgiScenes } from './ssgi.js';
import type { SceneContext, SceneDefinition } from './types.js';

export type * from './types.js';
export { ANIMATED_POSE_TIME } from './ssgi.js';

const scenes = new Map<string, SceneDefinition>(
  [...ssgiScenes, ...khronosScenes, ...giDiagnosticScenes].map((scene) => [scene.name, scene]),
);

export function listSceneNames(): string[] {
  return [...scenes.keys()];
}

export function getScene(name: string): SceneDefinition {
  const scene = scenes.get(name);
  if (!scene) throw new Error(`Unknown scene "${name}". Available: ${listSceneNames().join(', ')}`);
  return scene;
}

/** Browser context: `baseUrl` serves the contents of `submodules/three.js/examples/` (e.g. '/three-examples/'). */
export function createBrowserSceneContext(baseUrl: string): SceneContext {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const dracoLoader = new DRACOLoader().setDecoderPath(`${base}jsm/libs/draco/`);
  const loader = new GLTFLoader()
    .setDRACOLoader(dracoLoader)
    .setKTX2Loader(new RGBAKTX2Loader().setTranscoderPath(`${base}jsm/libs/basis/`))
    .setMeshoptDecoder(MeshoptDecoder);
  return {
    loadGLTF: (path) => loader.loadAsync(base + path),
    loadHDR: (path) => new HDRLoader().loadAsync(base + path),
  };
}
