// Asset-free experiments: isolate light transport (multi-bounce) from textures, ambient light and tone mapping.
import {
  Color,
  Mesh,
  MeshPhysicalMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  Vector3,
} from 'three';
import type { SceneDefinition, SceneSetup } from './types.js';

const WIDTH = 480;
const HEIGHT = 360;

function material(albedo: number, emission = 0): MeshPhysicalMaterial {
  // Numeric RGB values are linear. IOR 1 minimizes the specular lobe; the path tracer still uses
  // Disney diffuse rather than raster Lambert, so these are transport diagnostics, not exact BRDF tests.
  return new MeshPhysicalMaterial({
    color: new Color().setRGB(albedo, albedo, albedo),
    emissive: new Color().setRGB(emission, emission, emission),
    roughness: 1,
    ior: 1,
  });
}

function plane(
  scene: Scene,
  name: string,
  width: number,
  height: number,
  surface: MeshPhysicalMaterial,
  position: [number, number, number],
  rotation: [number, number, number],
): void {
  const mesh = new Mesh(new PlaneGeometry(width, height), surface);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
}

function setup(fov = 65): SceneSetup {
  const scene = new Scene();
  scene.background = new Color(0);
  const camera = new PerspectiveCamera(fov, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 4, 4);
  const target = new Vector3(0, 0, 0);
  camera.lookAt(target);
  return { scene, camera, target, toneMapping: NoToneMapping, toneMappingExposure: 1 };
}

function floor(scene: Scene, surface: MeshPhysicalMaterial): void {
  plane(scene, 'receiver-floor', 10, 10, surface, [0, 0, 0], [-Math.PI / 2, 0, 0]);
}

function walls(scene: Scene, surface: MeshPhysicalMaterial): void {
  plane(scene, 'back', 10, 6, surface, [0, 3, -5], [0, 0, 0]);
  plane(scene, 'front', 10, 6, surface, [0, 3, 5], [0, Math.PI, 0]);
  plane(scene, 'left', 10, 6, surface, [-5, 3, 0], [0, Math.PI / 2, 0]);
  plane(scene, 'right', 10, 6, surface, [5, 3, 0], [0, -Math.PI / 2, 0]);
  plane(scene, 'ceiling', 10, 10, surface, [0, 6, 0], [Math.PI / 2, 0, 0]);
}

function diffuseRoom(albedo: number): SceneSetup {
  const result = setup(90);
  const surface = material(albedo);
  floor(result.scene, surface);
  walls(result.scene, surface);
  const light = new PointLight(0xffffff, 12);
  light.position.set(0, 5, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  result.scene.add(light);
  return result;
}

function diagnostic(name: string, description: string, create: () => SceneSetup): SceneDefinition {
  return { name, description, width: WIDTH, height: HEIGHT, create: async () => create() };
}

export const giDiagnosticScenes: SceneDefinition[] = [
  diagnostic(
    'gi-room-low-albedo',
    'Closed empty room with linear albedo 0.2 and one point light; weak higher-bounce contribution.',
    () => diffuseRoom(0.2),
  ),
  diagnostic('gi-room-high-albedo', 'Same closed room with linear albedo 0.8; strong higher-bounce contribution.', () =>
    diffuseRoom(0.8),
  ),
];
