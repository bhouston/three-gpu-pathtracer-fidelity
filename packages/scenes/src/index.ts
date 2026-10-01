import { khronosScenes } from './khronos.js';
import { modelListScenes } from './model-list.js';
import { giDiagnosticScenes } from './gi-diagnostics.js';
import { ssgiScenes } from './ssgi.js';
import type { SceneDefinition } from './types.js';

export type * from './types.js';
export { ANIMATED_POSE_TIME } from './ssgi.js';

const scenes = new Map<string, SceneDefinition>(
  [...ssgiScenes, ...khronosScenes, ...modelListScenes, ...giDiagnosticScenes].map((scene) => [scene.name, scene]),
);

export function listSceneNames(): string[] {
  return [...scenes.keys()];
}

export function getScene(name: string): SceneDefinition {
  const scene = scenes.get(name);
  if (!scene) throw new Error(`Unknown scene "${name}". Available: ${listSceneNames().join(', ')}`);
  return scene;
}
