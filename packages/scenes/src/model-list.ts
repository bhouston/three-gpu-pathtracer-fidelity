// Scenes of three-gpu-pathtracer's example/index.js model list (example/modelList.js): glTF models from the
// 3d-demo-data and glTF-Sample-Assets submodules, normalized to a unit sphere and shown on the demo's stage
// (floor / pedestal / backdrop, rect-area light rigs, HDR or gradient lighting). Each entry's `post` is its
// `postProcess`. The LEGO models are LDraw (.mpd, parts from submodules/ldraw-parts-library) or Collada (.dae).
import {
  ACESFilmicToneMapping,
  Box3,
  EquirectangularReflectionMapping,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  RectAreaLight,
  Scene,
  Sphere,
  Vector3,
} from 'three';
import type { Material, Mesh, Object3D } from 'three';
import { PhysicalCamera, ShapedAreaLight } from 'three-gpu-pathtracer';
import { createStage } from './model-stage.js';
import type { BackgroundName, StageName } from './model-stage.js';
import type { SceneContext, SceneDefinition, SceneSetup } from './types.js';

const WIDTH = 1024;
const HEIGHT = 768;
const DEFAULT_ENV = 'hdri/aristea_wreck_puresky_2k.hdr';
const DEMO = 'submodules/3d-demo-data/models';
const { PI } = Math;

type Euler3 = [number, number, number];

interface ModelEntry {
  name: string;
  /** Relative to the repository root. */
  file: string;
  rotation?: Euler3;
  stage?: StageName;
  /** HDR under submodules/3d-demo-data/, or 'none'. */
  envMap?: string;
  /** A light rig of model-stage.ts. */
  lighting?: string;
  background?: BackgroundName;
  bokehSize?: number;
  focusDistance?: number;
  post?: (model: Object3D) => void;
}

const meshes = (model: Object3D): Mesh[] => {
  const result: Mesh[] = [];
  model.traverse((c) => (c as Mesh).isMesh && result.push(c as Mesh));
  return result;
};
const physical = (mesh: Mesh) => mesh.material as MeshPhysicalMaterial;

/** Models that fake glass with a partially transparent material render as noise: use real transmission instead. */
function convertOpacityToTransmission(model: Object3D, ior = 1.5): void {
  for (const mesh of meshes(model)) {
    const material = mesh.material as Material;
    if (material.opacity >= 0.65 || material.opacity <= 0.2) continue;
    const next = new MeshPhysicalMaterial();
    const target = next as unknown as Record<string, { copy?(v: unknown): void; constructor: unknown } | unknown>;
    for (const [key, value] of Object.entries(material)) {
      if (value === null || value === undefined || key.startsWith('_')) continue;
      if ((value as { isTexture?: boolean }).isTexture) target[key] = value;
      else if (typeof value === 'number') target[key] = value;
      else if (
        (value as { copy?: unknown }).copy &&
        (value as object).constructor === (target[key] as object | undefined)?.constructor
      ) {
        (target[key] as { copy(v: unknown): void }).copy(value);
      }
    }
    next.opacity = 1;
    next.transmission = 1;
    next.ior = ior;
    const hsl = { h: 0, s: 0, l: 0 };
    next.color.getHSL(hsl);
    next.color.setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.35));
    mesh.material = next;
  }
}

/** Flat emissive quads become rect area lights, which can be importance sampled. Curved emitters stay geometry. */
function convertEmissivePlanesToLights(model: Object3D): void {
  const FLAT_RATIO = 1e-3;
  model.updateMatrixWorld(true);
  const emitters = meshes(model).filter((mesh) => {
    const m = mesh.material as MeshStandardMaterial;
    return m.emissiveIntensity > 0 && m.emissive.getHex() !== 0;
  });
  for (const mesh of emitters) {
    const { geometry } = mesh;
    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new Vector3());
    const center = geometry.boundingBox!.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const flat =
      size.x < FLAT_RATIO * maxDim
        ? 'x'
        : size.y < FLAT_RATIO * maxDim
          ? 'y'
          : size.z < FLAT_RATIO * maxDim
            ? 'z'
            : null;
    if (!flat) continue;

    const position = center.applyMatrix4(mesh.matrixWorld);
    const quaternion = new Quaternion();
    const scale = new Vector3();
    mesh.matrixWorld.decompose(new Vector3(), quaternion, scale);

    // orient the light plane (local XY) onto the flat axis
    const alignment = new Quaternion();
    let width: number;
    let height: number;
    if (flat === 'x') {
      alignment.setFromAxisAngle(new Vector3(0, 1, 0), PI / 2);
      width = size.z * Math.abs(scale.z);
      height = size.y * Math.abs(scale.y);
    } else if (flat === 'y') {
      alignment.setFromAxisAngle(new Vector3(1, 0, 0), PI / 2);
      width = size.x * Math.abs(scale.x);
      height = size.z * Math.abs(scale.z);
    } else {
      width = size.x * Math.abs(scale.x);
      height = size.y * Math.abs(scale.y);
    }

    const material = mesh.material as MeshStandardMaterial;
    const circular = material.name.endsWith('_disk_emission');
    const light = circular
      ? new ShapedAreaLight(material.emissive, material.emissiveIntensity * 0.5, width, height)
      : new RectAreaLight(material.emissive, material.emissiveIntensity * 0.5, width, height);
    if (circular) (light as unknown as { isCircular: boolean }).isCircular = true;
    light.position.copy(position);
    light.quaternion.copy(quaternion).multiply(alignment);

    // single sided: flip the light if it emits away from the quad's normal
    const normals = geometry.attributes.normal;
    if (normals) {
      const normal = new Vector3().fromBufferAttribute(normals, 0);
      const emit = new Vector3(0, 0, -1).applyQuaternion(alignment);
      if (emit.dot(normal) < 0) light.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), PI));
    }
    model.add(light);
    mesh.removeFromParent();
  }
}

/** Removes every mesh whose (physical) material is see-through but not transmissive. */
function removeFaintSurfaces(model: Object3D): void {
  for (const mesh of meshes(model)) {
    const m = mesh.material as Material;
    if (!(m instanceof MeshPhysicalMaterial) && m.opacity < 1) mesh.removeFromParent();
  }
}

/** The MecaBricks exports use two dark golds that read as muddy brown when path traced. */
function mecaBricksGoldCorrection(model: Object3D): void {
  for (const mesh of meshes(model)) {
    const m = physical(mesh);
    const hex = m.color.getHexString();
    if (hex === '7f4c0e') {
      m.color.set(0xc2801f).multiplyScalar(0.9);
    } else if (hex === '613708') {
      m.color.set(0xc2801f);
      m.color.g *= 0.75;
      m.color.b *= 0.75;
    } else continue;
    m.roughness = 0.45;
    m.metalness = 0.6;
  }
}

const LDRAW = 'submodules/ldraw-parts-library/models';
const THREE_LDRAW = 'submodules/three.js/examples/models/ldraw/officialLibrary/models';
const ldrawGlass = (model: Object3D) => convertOpacityToTransmission(model, 1.4);
const ldraw = (name: string, file: string): ModelEntry => ({
  name: `lego-${name}`,
  file: `${LDRAW}/${file}`,
  post: ldrawGlass,
});

const entries: ModelEntry[] = [
  { name: 'nasa-jpl-m2020-rover', file: `${DEMO}/nasa-m2020/Perseverance.glb` },
  { name: 'nasa-jpl-mer-rover', file: `${DEMO}/nasa-m2020/MER_static.glb` },
  { name: 'nasa-jpl-ingenuity-helicopter', file: `${DEMO}/nasa-m2020/Ingenuity.glb` },
  { name: 'nasa-jpl-insight-lander', file: `${DEMO}/nasa-m2020/InSight.glb` },
  { name: 'nasa-jpl-juno', file: `${DEMO}/nasa-m2020/Juno.glb`, rotation: [PI / 6, PI / 5, 0] },

  { name: 'yamaha-mt-09-sp', file: `${DEMO}/vehicles/yamaha-mt-09-sp.glb`, rotation: [0, PI, 0] },
  { name: 'toyota-supra-gt300', file: `${DEMO}/vehicles/toyota-supra-gt300.glb` },
  { name: 'jaguar-xj13', file: `${DEMO}/vehicles/jaguar-xj13.glb`, rotation: [0, PI, 0] },
  { name: 'mclaren-mp4-5', file: `${DEMO}/vehicles/mclaren-mp4-5.glb` },
  { name: 'jeep-wrangler-rubicon', file: `${DEMO}/vehicles/jeep-wrangler-rubicon.glb` },
  { name: 'ferrari-laferrari-aperta', file: `${DEMO}/vehicles/ferrari-laferrari-aperta.glb`, rotation: [0, PI, 0] },
  { name: 'lamborghini-huracan-gt3', file: `${DEMO}/vehicles/lamborghini-huracan-gt3.glb` },
  { name: 'range-rover', file: `${DEMO}/vehicles/range-rover.glb`, rotation: [0, PI, 0] },
  { name: 'porsche-911-stinger-gtr', file: `${DEMO}/vehicles/porsche-911-stinger-gtr.glb`, rotation: [0, PI, 0] },

  {
    name: 'sasha-ring',
    file: `${DEMO}/blendswap/sasha.glb`,
    rotation: [0, 0, PI / 4],
    stage: 'pedestal',
    envMap: 'hdri/brown_photostudio_01_2k.hdr',
    lighting: 'light box',
    post(model) {
      let ring: MeshPhysicalMaterial | undefined;
      for (const mesh of meshes(model)) {
        const m = physical(mesh);
        if (m.name === 'Material.002') ring = m;
        else if (m.transmission === 1) m.dispersion = 1;
      }
      ring!.roughness = 0.05;
      ring!.color.lerp(ring!.color.clone().set(0xc47258), 0.45);
    },
  },
  {
    name: 'magie-noire-perfume',
    file: `${DEMO}/blendswap/magie-noire.glb`,
    stage: 'none',
    envMap: 'none',
    // aperture refit from the source scene's f/0.45 at 82mm to the normalized model scale
    bokehSize: 28,
    focusDistance: 0.536,
    post(model) {
      // the scene's light rig, stated in the normalized frame the model is scaled into
      const sphere = new Box3().setFromObject(model).getBoundingSphere(new Sphere());
      const rig: { size: number; position: Euler3; rotation: Euler3; intensity: number; color: number }[] = [
        {
          size: 0.19,
          position: [0.25, 0.06, 0.29],
          rotation: [-0.071, -0.275, -0.266],
          intensity: 25,
          color: 0xffffff,
        },
        {
          size: 0.19,
          position: [0.59, 0.06, -0.03],
          rotation: [-0.826, 1.176, -0.452],
          intensity: 12.5,
          color: 0xe29e49,
        },
        { size: 0.19, position: [0.24, -0.1, -0.32], rotation: [PI / 2, 0, 0], intensity: 15, color: 0x8f70f3 },
      ];
      for (const { size, position, rotation, intensity, color } of rig) {
        const width = size * sphere.radius;
        const light = new RectAreaLight(color, intensity, width, width);
        light.position
          .set(...position)
          .multiplyScalar(sphere.radius)
          .add(sphere.center);
        light.rotation.set(...rotation);
        model.add(light);
      }
    },
  },
  {
    name: 'stormtrooper-fan-art',
    file: `${DEMO}/blendswap/stormtrooper.glb`,
    stage: 'none',
    envMap: 'none',
    background: 'black',
    bokehSize: 10,
    focusDistance: 0.55,
    post: convertEmissivePlanesToLights,
  },
  {
    name: 'monster-under-the-bed',
    file: `${DEMO}/blender-demo-files/monster.glb`,
    stage: 'none',
    envMap: 'none',
    post(model) {
      // the source scene renders the monster with subsurface scattering, which the path tracer has no equivalent
      // for, so stand in a rough transmissive material
      for (const mesh of meshes(model)) {
        const old = mesh.material as MeshStandardMaterial;
        if (!old.name.startsWith('monster')) continue;
        const material = new MeshPhysicalMaterial();
        MeshStandardMaterial.prototype.copy.call(material, old);
        material.transmission = 1;
        material.roughness = 0.55;
        material.ior = 1.4;
        material.thickness = 0.15;
        material.attenuationDistance = 0.25;
        material.attenuationColor.copy(old.color);
        mesh.material = material;
      }
      convertEmissivePlanesToLights(model);
    },
  },
  { name: 'lone-monk', file: `${DEMO}/blender-demo-files/lone-monk.glb`, stage: 'none' },
  {
    name: 'stelton-theo-teapot-set',
    file: `${DEMO}/blendswap/teapot.glb`,
    stage: 'none',
    envMap: 'hdri/vestibule_2k.hdr',
  },
  {
    name: 'dining-room',
    file: `${DEMO}/blendswap/dining-room.glb`,
    stage: 'none',
    envMap: 'none',
    // aperture refit from the source scene's f/6 at 35mm to the normalized model scale
    bokehSize: 1,
    focusDistance: 0.74,
    post: convertEmissivePlanesToLights,
  },
  {
    name: 'dodge-challenger',
    file: `${DEMO}/blendswap/dodge-challenger.glb`,
    rotation: [0, PI / 2, 0],
    post(model) {
      for (const mesh of meshes(model))
        if ((mesh.material as Material).name === 'paint_w_stripes') physical(mesh).color.set(0x7a0c0c);
    },
  },
  {
    name: 'tropical-island',
    file: `${DEMO}/blendswap/tropical.glb`,
    stage: 'floor',
    rotation: [0, PI, 0],
    // the source scene's environment with the above rotation baked in
    envMap: 'models/blendswap/tropical-beach.hdr',
    post(model) {
      // stand a camera in for the one dropped in conversion
      const camera = new PerspectiveCamera(45, 1);
      camera.position.set(3.17, 3.11, -2.62);
      camera.lookAt(-0.52, 0, 0.36);
      model.add(camera);
    },
  },

  ...[
    'bedroom',
    'breakfast-room',
    'contemporary-bathroom',
    'country-kitchen',
    'grey-and-white-room',
    'salle-de-bain',
    'white-room',
  ].map(
    (room): ModelEntry => ({
      name: room,
      file: `${DEMO}/bitterli-rendering-resources/${room}.glb`,
      rotation: [0, 0, 0],
      stage: 'none',
      post: convertEmissivePlanesToLights,
    }),
  ),
  ...['wooden-staircase', 'coffee-maker', 'little-lamp'].map(
    (name): ModelEntry => ({
      name,
      file: `${DEMO}/bitterli-rendering-resources/${name}.glb`,
      rotation: [0, 0, 0],
      envMap: 'none',
      stage: 'none',
      post: convertEmissivePlanesToLights,
    }),
  ),

  { name: 'headphone-with-stand', file: `${DEMO}/devices/headphone-with-stand.glb` },
  { name: 'sony-playstation-2', file: `${DEMO}/devices/sony-playstation-2.glb` },
  { name: 'sony-tc-510-2-tape-recorder', file: `${DEMO}/devices/sony-tc-510-2-tape-recorder.glb` },
  { name: 'sony-walkman-wm-f2078', file: `${DEMO}/devices/sony-walkman-wm-f2078.glb` },

  {
    name: 'octopus-tea',
    file: `${DEMO}/octopus-tea/scene.gltf`,
    post(model) {
      convertOpacityToTransmission(model);
      model.updateMatrixWorld();
      for (const mesh of meshes(model)) {
        const m = physical(mesh);
        m.emissiveIntensity = 0;
        if (!(m instanceof MeshPhysicalMaterial)) continue;
        m.metalness = 0;
        if (m.transmission !== 1) continue;
        m.roughness = 0;
        // 29 === glass, 27 === liquid top, 23 === liquid
        if (mesh.name.includes('29')) {
          m.ior = 1.52;
          m.color.set(0xffffff);
        } else {
          m.ior = 1.2;
        }
      }
      removeFaintSurfaces(model);
    },
  },
  {
    name: 'halo-twist-ring',
    file: `${DEMO}/ring-twist-halo/scene.glb`,
    post(model) {
      convertOpacityToTransmission(model);
      for (const mesh of meshes(model)) {
        const m = physical(mesh);
        if (!(m instanceof MeshPhysicalMaterial) || m.transmission !== 1) continue;
        m.metalness = 0;
        m.ior = 1.8;
        m.color.set(0xffffff);
      }
    },
  },
  { name: 'flight-helmet', file: 'submodules/glTF-Sample-Assets/Models/FlightHelmet/glTF/FlightHelmet.gltf' },
  {
    name: 'dragon',
    file: `${DEMO}/bitterli-rendering-resources/dragon.glb`,
    rotation: [0, 0, 0],
    post(model) {
      // the scene is authored in arbitrary units, so the glass is tinted over a fraction of the model size
      const size = new Box3().setFromObject(model).getSize(new Vector3());
      const material = new MeshPhysicalMaterial({
        roughness: 0.15,
        metalness: 0,
        transmission: 1,
        ior: 1.6,
        thickness: 1,
        attenuationDistance: 0.1 * Math.max(size.x, size.y, size.z),
      });
      material.attenuationColor.set(0xe8a441);
      for (const mesh of meshes(model)) mesh.material = material;
    },
  },
  {
    name: 'crab-sculpture',
    file: `${DEMO}/threedscans/Crab.glb`,
    rotation: [(-2 * PI) / 4, 0, 0],
    post(model) {
      for (const mesh of meshes(model)) physical(mesh).color.set(0xdddddd);
    },
  },

  ldraw('allied-avenger', '6887-1 - Allied Avenger.mpd'),
  {
    name: 'lego-apollo-11-lander',
    file: `${DEMO}/mecabricks/apollo-11-lunar-lander/lunar-lander.dae`,
    post: mecaBricksGoldCorrection,
    rotation: [0, -PI * 0.6, 0],
  },
  ldraw('b-wing-starfighter', '10227-1 - B-wing Starfighter.mpd'),
  ldraw('bennys-spaceship', '70816 - Bennys Spaceship Spa_kOdSy6E.mpd'),
  ldraw('blizzard-baron', '6879-1 - Blizzard Baron.mpd'),
  ldraw('ice-station-odyssey', '6983-1 - Ice Station Odyssey.mpd'),
  ldraw('ice-tunnelator', '6814-1 - Ice Tunnelator.mpd'),
  {
    name: 'lego-lunar-vehicle',
    file: `${THREE_LDRAW}/1621-1-LunarMPVVehicle.mpd_Packed.mpd`,
    rotation: [PI, -PI / 2, 0],
    post: ldrawGlass,
  },
  {
    name: 'lego-nasa-mars-rover',
    file: `${DEMO}/mecabricks/nasa-mars-curiosity-rover.dae`,
    post: mecaBricksGoldCorrection,
  },
  ldraw('stellar-recon-voyager', '6956-1 - Stellar Recon Voyager.mpd'),
  ldraw('super-model-building-instruction', '6861-2 - Super Model Building Instruction.mpd'),
  { name: 'lego-ucs-at-st', file: `${THREE_LDRAW}/10174-1-ImperialAT-ST-UCS.mpd_Packed.mpd`, post: ldrawGlass },
  ldraw('ucs-imperial-star-destroyer', '10030-1 - Imperial Star Destroyer - UCS.mpd'),
  ldraw('ucs-millennium-falcon', '10179-1 - Millennium Falcon - UCS.mpd'),
  ldraw('ucs-tie-interceptor', '7181 - TIE Interceptor - UCS.mpd'),
  ldraw('ucs-x-wing-fighter', '7191 - X-wing Fighter - UCS.mpd'),
];

async function createModelScene(entry: ModelEntry, ctx: SceneContext): Promise<SceneSetup> {
  const path = `@/${entry.file}`;
  const model = entry.file.endsWith('.mpd')
    ? await ctx.loadLDraw(path)
    : entry.file.endsWith('.dae')
      ? await ctx.loadCollada(path)
      : (await ctx.loadGLTF(path)).scene;
  for (const mesh of meshes(model)) physical(mesh).thickness = 1; // render the materials as volumetric objects
  entry.post?.(model);
  // rotate after, so it doesn't affect the bounding sphere scale
  if (entry.rotation) model.rotation.set(...entry.rotation);

  // center, and normalize to a unit sphere so the framing is the same for all models
  const box = new Box3().setFromObject(model);
  model.position.addScaledVector(box.min, -0.5).addScaledVector(box.max, -0.5);
  const sphere = box.getBoundingSphere(new Sphere());
  const scale = 1 / sphere.radius;
  model.scale.setScalar(scale);
  model.position.multiplyScalar(scale);
  box.setFromObject(model, true);

  // attenuation and light dimensions are measured in world units and ignore the object hierarchy scale
  const scaled = new Set<Material>();
  model.traverse((c) => {
    const material = (c as Mesh).material as MeshPhysicalMaterial | undefined;
    if (material && !scaled.has(material)) {
      scaled.add(material);
      material.attenuationDistance *= scale;
    }
    if ((c as RectAreaLight).isRectAreaLight) {
      (c as RectAreaLight).width *= scale;
      (c as RectAreaLight).height *= scale;
    }
  });

  // the camera embedded in the model, else the demo's default view
  const camera = new PhysicalCamera(45, WIDTH / HEIGHT, 0.025, 500);
  const target = new Vector3();
  const embedded = (() => {
    let found: PerspectiveCamera | undefined;
    model.traverse((c) => {
      if (!found && (c as PerspectiveCamera).isPerspectiveCamera) found = c as PerspectiveCamera;
    });
    return found;
  })();
  const scene = new Scene();
  scene.add(model);
  if (embedded) {
    scene.updateMatrixWorld(true);
    embedded.getWorldPosition(camera.position);
    camera.fov = embedded.fov;
    const forward = embedded.getWorldDirection(new Vector3());
    target.copy(camera.position).addScaledVector(forward, Math.max(-forward.dot(camera.position), 0.1));
  } else {
    camera.position.set(-1, 0.35, 1).multiplyScalar(1.7);
  }
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.bokehSize = entry.bokehSize ?? 0;
  camera.focusDistance = entry.focusDistance ?? 1;

  const stage = createStage(
    entry.stage ?? 'floor',
    entry.lighting ?? 'none',
    entry.background ?? 'white',
    box.min.y,
    camera.position,
  );
  scene.add(stage.objects);
  scene.background = stage.background;
  const envMap = entry.envMap ?? DEFAULT_ENV;
  if (envMap !== 'none') {
    const hdr = await ctx.loadHDR(`@/submodules/3d-demo-data/${envMap}`);
    hdr.mapping = EquirectangularReflectionMapping;
    scene.environment = hdr;
  }

  return {
    scene,
    camera,
    target,
    toneMapping: ACESFilmicToneMapping,
    toneMappingExposure: 1,
  };
}

export const modelListScenes: SceneDefinition[] = entries.map((entry) => ({
  name: `model-${entry.name}`,
  description: `Model list demo: ${entry.file.split('/').slice(-1)[0]}.`,
  width: WIDTH,
  height: HEIGHT,
  create: (ctx) => createModelScene(entry, ctx),
}));
