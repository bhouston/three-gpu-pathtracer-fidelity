// Fidelity scenes of three-gpu-pathtracer's example/viewerTest.js: the Khronos glTF-Render-Fidelity-Generator
// scenarios (`khronos-*`, config.json @ deaaba0) plus the example's own extra scenarios (`x-*`, for sample assets the
// Khronos list lacks). Models come from the glTF-Sample-Assets submodule, lighting from assets/environments/.
// The scenarios are orbit cameras around a target with a 45° vertical FoV by default, like <model-viewer>.
import {
  ACESFilmicToneMapping,
  Box3,
  EquirectangularReflectionMapping,
  Group,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
} from 'three';
import scenarios from './khronos-scenarios.json' with { type: 'json' };
import type { SceneContext, SceneDefinition, SceneSetup } from './types.js';

interface Scenario {
  name: string;
  /** Under glTF-Sample-Assets/Models/. */
  model: string;
  /** File under assets/environments/ (default lightroom_14b.hdr). */
  lighting?: string;
  renderSkybox?: boolean;
  verticalFoV?: number;
  orbit?: { radius?: number; theta?: number; phi?: number };
  target?: { x?: number; y?: number; z?: number };
  dimensions?: { width?: number; height?: number };
}

async function createScenario(s: Scenario, width: number, height: number, ctx: SceneContext): Promise<SceneSetup> {
  const { radius = 1, theta = 0, phi = 90 } = s.orbit ?? {};
  const { x = 0, y = 0, z = 0 } = s.target ?? {};

  const scene = new Scene();
  const hdr = await ctx.loadHDR(`@/assets/environments/${s.lighting ?? 'lightroom_14b.hdr'}`);
  hdr.mapping = EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.background = s.renderSkybox ? hdr : null; // the golden images are transparent behind the model: black here

  // the target sits at the origin, which the camera orbits
  const model = new Group();
  model.position.set(-x, -y, -z);
  model.add((await ctx.loadGLTF(`@/submodules/glTF-Sample-Assets/Models/${s.model}`)).scene);
  scene.add(model);
  model.updateMatrixWorld(true);
  const sphere = new Box3().setFromObject(model).getBoundingSphere(new Sphere());

  const far = 2 * Math.max(radius, sphere.radius);
  const camera = new PerspectiveCamera(s.verticalFoV ?? 45, width / height, far / 1000, far);
  camera.position.setFromSphericalCoords(Math.max(radius, 1e-5), MathUtils.DEG2RAD * phi, MathUtils.DEG2RAD * theta);
  const target = new Vector3();
  camera.lookAt(target);

  return {
    scene,
    camera,
    target,
    toneMapping: ACESFilmicToneMapping,
    toneMappingExposure: 1,
  };
}

export const khronosScenes: SceneDefinition[] = (scenarios as Scenario[]).map((s) => {
  const { width = 768, height = 768 } = s.dimensions ?? {};
  return {
    name: s.name,
    description: `viewerTest scenario ${s.name}: ${s.model}.`,
    width,
    height,
    create: (ctx) => createScenario(s, width, height, ctx),
  };
});
