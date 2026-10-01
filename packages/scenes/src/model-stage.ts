// The stage of three-gpu-pathtracer's example/index.js (the model list demo): floor, pedestal, cyclorama backdrop,
// rect-area light rigs and the gradient background, ported from index.js, src/Backdrop.js and
// src/generateRadialFloorTexture.js.
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RectAreaLight,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GradientEquirectTexture } from 'three-gpu-pathtracer';

export type StageName = 'floor' | 'pedestal' | 'backdrop' | 'none';
export type BackgroundName = 'white' | 'black';

interface LightDef {
  size: number | [number, number];
  position: [number, number, number];
  /** Unset: the light aims at the model. */
  rotation?: [number, number, number];
  intensity: number;
  color: number;
}

const { PI } = Math;

export const LIGHT_RIGS: Record<string, LightDef[]> = {
  'three point': [
    { size: 2, position: [2, 1.6, 1.8], intensity: 6, color: 0xfff0dd },
    { size: 2.5, position: [-2.4, 0.8, 1.6], intensity: 1.5, color: 0xdfeaff },
    { size: 1.6, position: [-1.2, 1.8, -2.2], intensity: 9, color: 0xffffff },
  ],
  softbox: [
    { size: [2.1, 2.5], position: [-1.55, 0.35, 0.9], intensity: 2, color: 0xffffff },
    { size: [2.5, 2], position: [1.8, 0.5, 0.25], intensity: 2, color: 0xffffff },
    { size: 2.55, position: [0, 1.9, 0.2], intensity: 2, color: 0xffffff },
  ],
  overhead: [{ size: 3, position: [0, 2.4, 0.4], intensity: 8, color: 0xffffff }],
  'side strips': [
    { size: [0.5, 3.2], position: [-2.2, 1, 0.4], intensity: 14, color: 0xffffff },
    { size: [0.5, 3.2], position: [2.2, 1, 0.4], intensity: 14, color: 0xffffff },
  ],
  'light box': [
    { size: [3.55, 8.8], position: [0.65, 1.75, -3.45], rotation: [-PI / 2, 0, 0], intensity: 5, color: 0xffffff },
    { size: [1.65, 7.7], position: [-1.8, 0.6, -2.8], rotation: [0, -PI / 2, 0], intensity: 3, color: 0xffffff },
    { size: [1.65, 1.7], position: [2.25, 0.6, 0.2], rotation: [0, PI / 2, 0], intensity: 3, color: 0xffffff },
    { size: [1.7, 2.8], position: [0.1, 1.15, 2.4], rotation: [0, 0, 0], intensity: 3, color: 0xffffff },
  ],
  'overhead strips': [-0.9, -0.3, 0.3, 0.9].map((x) => ({
    size: [0.35, 3.4] as [number, number],
    position: [x, 2.4, 0] as [number, number, number],
    rotation: [-PI / 2, 0, 0] as [number, number, number],
    intensity: 12,
    color: 0xffffff,
  })),
};

/** Where the backdrop's curve begins, behind the model. */
const BACKDROP_DISTANCE = 1;

/** White radial falloff in the alpha channel, for the floor. */
function radialFloorTexture(dim: number): DataTexture {
  const data = new Uint8Array(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const xc = 2 * (x / (dim - 1) - 0.5);
      const yc = 2 * (y / (dim - 1) - 0.5);
      const a = Math.min(Math.max(Math.min(1 - Math.hypot(xc, yc), 1), 0) ** 2 * 1.5, 1);
      data.set([255, 255, 255, a * 255], (y * dim + x) * 4);
    }
  }
  const texture = new DataTexture(data, dim, dim, RGBAFormat, UnsignedByteType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A seamless floor sweeping up into a wall: the curve begins at the origin, the floor extends toward +z. */
function backdropGeometry(width = 5, depth = 2.5, curve = 1.6, height = 2, curvature = 4, segments = 128) {
  const profile: [number, number][] = [[depth, 0]];
  const scale = Math.exp(curvature) - 1;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    profile.push([-t * curve, (height * (Math.exp(curvature * t * t) - 1)) / scale]);
  }
  const rows = profile.length;
  const positions = new Float32Array(rows * 2 * 3);
  const indices: number[] = [];
  for (let i = 0; i < rows; i++) {
    const [z, y] = profile[i]!;
    for (let j = 0; j < 2; j++) positions.set([(j - 0.5) * width, y, z], (2 * i + j) * 3);
    if (i < rows - 1) indices.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export interface Stage {
  /** Scenery and lights, to add to the scene. */
  objects: Group;
  background: GradientEquirectTexture;
}

/**
 * @param bottom world y of the model's lowest point
 * @param cameraPosition the backdrop and the light rigs are oriented relative to the camera
 */
export function createStage(
  stage: StageName,
  lighting: string,
  background: BackgroundName,
  bottom: number,
  cameraPosition: { x: number; z: number },
): Stage {
  const light = background === 'white';
  const gradient = new GradientEquirectTexture();
  gradient.topColor.set(light ? 0xe0e0e0 : 0x111111);
  gradient.bottomColor.set(light ? 0xc4c4c4 : 0x000000);
  gradient.update();

  const objects = new Group();
  const angle = Math.atan2(cameraPosition.x, cameraPosition.z);
  const y = bottom - 1e-3;

  if (stage === 'floor') {
    const floor = new Mesh(
      new PlaneGeometry(),
      new MeshStandardMaterial({
        map: radialFloorTexture(1024),
        transparent: true,
        color: light ? 0xd2d2d2 : 0x111111,
        roughness: 0.1,
        metalness: 0,
        side: DoubleSide,
      }),
    );
    // a unit plane scaled by 5, lying down
    floor.scale.setScalar(5);
    floor.rotation.x = -PI / 2;
    floor.position.y = y;
    objects.add(floor);
  } else if (stage === 'pedestal') {
    const material = new MeshStandardMaterial({ color: light ? 0xdcdcdc : 0x1c1c1c, roughness: 0.35, metalness: 0 });
    // a two tier cylinder, with the top surface at the model's base
    [
      { radius: 0.9, height: 0.05 },
      { radius: 0.92, height: 0.05 },
    ].forEach(({ radius, height }, i) => {
      const geometry = new RoundedBoxGeometry(2, height / 0.01, 2, 32, 1);
      geometry.scale(radius, 0.01, radius);
      const tier = new Mesh(geometry, material);
      tier.position.y = y - height * (0.5 + i * 0.2);
      objects.add(tier);
    });
  } else if (stage === 'backdrop') {
    const backdrop = new Mesh(
      backdropGeometry(),
      new MeshStandardMaterial({
        color: light ? 0xc6c6c6 : 0x161616,
        roughness: light ? 0.2 : 0.6,
        metalness: 0,
        side: DoubleSide,
      }),
    );
    backdrop.rotation.y = angle;
    backdrop.position.set(-Math.sin(angle) * BACKDROP_DISTANCE, y, -Math.cos(angle) * BACKDROP_DISTANCE);
    objects.add(backdrop);
  }

  const rig = LIGHT_RIGS[lighting];
  if (rig) {
    const rigGroup = new Group();
    rigGroup.rotation.y = angle;
    for (const def of rig) {
      const [width, height] = Array.isArray(def.size) ? def.size : [def.size, def.size];
      const area = new RectAreaLight(def.color, def.intensity, width, height);
      area.position.set(...def.position);
      if (def.rotation) area.rotation.set(...def.rotation);
      else area.lookAt(0, 0.35, 0);
      rigGroup.add(area);
    }
    objects.add(rigGroup);
  }

  return { objects, background: gradient };
}
