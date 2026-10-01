// glTF models of three.js examples webgl_loader_gltf, webgl_loader_gltf_compressed and webgl_animation_keyframes, restaged
// for the WebGPU screen-space pipeline: each model is normalized to unit size on a glossy floor disc, lit only by an HDR
// environment (also the background) and framed from the example's viewing direction. The HDR's bright sources are
// moved into shadow-casting directional lights (see extractLights).
import {
  ACESFilmicToneMapping,
  AnimationMixer,
  Box3,
  CircleGeometry,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  HalfFloatType,
  Mesh,
  MeshStandardMaterial,
  LinearSRGBColorSpace,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { DataTexture } from 'three';
import type { SceneContext, SceneDefinition, SceneEffects, SceneSetup } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;

/** Animation time (seconds) at which animated models are frozen, identical for every renderer. */
const POSE_TIME = 2;

const effects: SceneEffects = {
  // world-space sampling, sized for the unit-size models
  ssgi: {
    sliceCount: 4,
    stepCount: 16,
    radius: 0.25,
    thickness: 0.05,
    giIntensity: (Math.PI * Math.PI) / 2,
    useScreenSpaceSampling: false,
  },
  ssr: { maxDistance: 1, thickness: 0.03 },
  temporalDenoise: true,
  toneMapping: ACESFilmicToneMapping,
  toneMappingExposure: 1,
  frames: 128,
};

/** HDR texels brighter than this multiple of the mean radiance count as a light source. */
const SOURCE_THRESHOLD = 30;
/** Bright texels within this angle (radians) of a source's brightest texel belong to that source. */
const SOURCE_RADIUS = 0.35;

/**
 * Moves the HDR's bright sources (a sun, softboxes) into directional lights of the same irradiance, clamping those
 * texels to the threshold so the total light is unchanged. The pathtracer importance-samples such sources either way,
 * but the raster pipeline only shadows lights: as prefiltered ambient, a sun lights occluded surfaces and the AO then
 * darkens the lit ones.
 */
export function extractLights(hdr: DataTexture, maxLights = 3): DirectionalLight[] {
  const { width, height } = hdr.image;
  const data = hdr.image.data as Uint16Array | Float32Array;
  const half = hdr.type === HalfFloatType;
  const read = (i: number): number => (half ? DataUtils.fromHalfFloat(data[i]!) : data[i]!);
  const write = (i: number, value: number): void => {
    data[i] = half ? DataUtils.toHalfFloat(value) : value;
  };
  const luminance = (i: number): number => 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2);
  const solidAngle = (y: number): number =>
    ((2 * Math.PI) / width) * (Math.PI / height) * Math.sin(((y + 0.5) / height) * Math.PI);
  // as three samples an equirect map (flipY): row 0 is straight up, u = atan2(z, x) / 2π + 0.5
  const direction = (x: number, y: number): Vector3 => {
    const theta = ((y + 0.5) / height) * Math.PI;
    const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
    return new Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
  };

  let total = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) total += luminance((y * width + x) * 4) * solidAngle(y);
  const threshold = (SOURCE_THRESHOLD * total) / (4 * Math.PI);

  const bright: { x: number; y: number; luminance: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = luminance((y * width + x) * 4);
      if (l > threshold) bright.push({ x, y, luminance: l });
    }
  }
  bright.sort((a, b) => b.luminance - a.luminance);

  const sources: { seed: Vector3; direction: Vector3; rgb: [number, number, number] }[] = [];
  for (const texel of bright) {
    const dir = direction(texel.x, texel.y);
    let source = sources.find((s) => s.seed.dot(dir) > Math.cos(SOURCE_RADIUS));
    if (!source) {
      if (sources.length === maxLights) continue;
      source = { seed: dir, direction: new Vector3(), rgb: [0, 0, 0] };
      sources.push(source);
    }
    // the excess over the threshold becomes the light's irradiance
    const i = (texel.y * width + texel.x) * 4;
    const excess = (1 - threshold / texel.luminance) * solidAngle(texel.y);
    for (let c = 0; c < 3; c++) {
      source.rgb[c]! += read(i + c) * excess;
      write(i + c, read(i + c) * (threshold / texel.luminance));
    }
    source.direction.addScaledVector(dir, (texel.luminance - threshold) * solidAngle(texel.y));
  }
  hdr.needsUpdate = true;

  return sources.map(({ direction: dir, rgb: [r, g, b] }) => {
    const intensity = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const light = new DirectionalLight(0xffffff, intensity);
    light.color.setRGB(r / intensity, g / intensity, b / intensity, LinearSRGBColorSpace);
    light.position.copy(dir.normalize()).multiplyScalar(4);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.left = light.shadow.camera.bottom = -1.6; // the floor disc
    light.shadow.camera.right = light.shadow.camera.top = 1.6;
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 8;
    light.shadow.normalBias = 0.005;
    return light;
  });
}

interface GLTFExample {
  name: string;
  description: string;
  /** Relative to three.js examples/. */
  model: string;
  hdr: string;
  fov: number;
  /** From the model's center toward the camera (the example's camera relative to its OrbitControls target). */
  view: Vector3;
  /** Camera distance relative to fitting the model's largest dimension (the webgl_loader_gltf fitCameraToSelection). */
  fitOffset: number;
}

async function createGLTFExample(example: GLTFExample, ctx: SceneContext): Promise<SceneSetup> {
  const scene = new Scene();
  const hdr = await ctx.loadHDR(`textures/equirectangular/${example.hdr}`);
  hdr.mapping = EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.background = hdr;
  for (const light of extractLights(hdr)) scene.add(light, light.target);

  const gltf = await ctx.loadGLTF(example.model);
  const model = gltf.scene;
  const clip = gltf.animations[0];
  if (clip) {
    const mixer = new AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.setTime(POSE_TIME);
  }

  // unit size, standing on the floor at the origin
  let box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  model.scale.multiplyScalar(1 / Math.max(size.x, size.y, size.z));
  box = new Box3().setFromObject(model);
  const center = box.getCenter(new Vector3());
  model.position.sub(new Vector3(center.x, box.min.y, center.z));
  model.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
  });
  scene.add(model);

  const floor = new Mesh(new CircleGeometry(1.5, 64), new MeshStandardMaterial({ color: 0x808080, roughness: 0.4 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const target = new Vector3(0, (box.max.y - box.min.y) / 2, 0);
  const distance = example.fitOffset / (2 * Math.tan((example.fov * Math.PI) / 360));
  const camera = new PerspectiveCamera(example.fov, WIDTH / HEIGHT, distance / 100, distance * 100);
  camera.position.copy(target).addScaledVector(example.view.clone().normalize(), distance);
  camera.lookAt(target);

  return { scene, camera, target, effects, aoRadius: 0.25 };
}

const examples: GLTFExample[] = [
  {
    name: 'gltf-damaged-helmet',
    description:
      'webgl_loader_gltf: DamagedHelmet on a glossy floor, ferndale studio HDR lighting (softboxes as shadowed lights).',
    model: 'models/gltf/DamagedHelmet/glTF/DamagedHelmet.gltf',
    hdr: 'ferndale_studio_04_1k.hdr',
    fov: 45,
    view: new Vector3(-1.8, 0.6, 2.9),
    fitOffset: 1.8,
  },
  {
    name: 'gltf-coffeemat',
    description:
      'webgl_loader_gltf_compressed: coffeemat.glb (meshopt geometry, KTX2 textures) on a glossy floor, ferndale studio HDR lighting (softboxes as shadowed lights).',
    model: 'models/gltf/coffeemat.glb',
    hdr: 'ferndale_studio_04_1k.hdr',
    fov: 45,
    view: new Vector3(-10, 10, 16),
    fitOffset: 1.5,
  },
  {
    name: 'gltf-littlest-tokyo',
    description: `webgl_animation_keyframes: LittlestTokyo.glb (Draco) frozen at t=${POSE_TIME}s on a glossy floor, spruit sunrise HDR lighting (sun as a shadowed light).`,
    model: 'models/gltf/LittlestTokyo.glb',
    hdr: 'spruit_sunrise_1k.hdr',
    fov: 40,
    view: new Vector3(5, 1.3, 8),
    fitOffset: 1.4,
  },
];

export const gltfExampleScenes: SceneDefinition[] = examples.map((example) => ({
  name: example.name,
  description: example.description,
  width: WIDTH,
  height: HEIGHT,
  create: (ctx) => createGLTFExample(example, ctx),
}));
