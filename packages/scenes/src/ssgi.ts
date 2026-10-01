// Cornell box scenes, from the setups of three.js examples/webgpu_postprocessing_ssgi.html.
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Object3D } from 'three';
import type { SceneContext, SceneDefinition, SceneSetup } from './types.js';

const WIDTH = 640;
const HEIGHT = 480;

/** Michelle.glb animation time (seconds) at which the pose is frozen. */
export const ANIMATED_POSE_TIME = 1;

type Setup = 'basic' | 'rounded' | 'metallic' | 'animated';

function shadowed<T extends Object3D>(object: T): T {
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

async function createCornellBox(setup: Setup, ctx: SceneContext): Promise<SceneSetup> {
  const camera = new PerspectiveCamera(40, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 10, 30);
  const target = new Vector3(0, 7, 0); // OrbitControls target of the example
  camera.lookAt(target);

  const scene = new Scene();
  scene.background = new Color(0xaaaaaa);

  const wallGeometry = new PlaneGeometry(1, 1);

  const leftWall = new Mesh(wallGeometry, new MeshPhysicalMaterial({ color: '#ff0000' }));
  leftWall.scale.set(20, 15, 1);
  leftWall.rotation.y = Math.PI * 0.5;
  leftWall.position.set(-10, 7.5, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);

  const rightWall = new Mesh(wallGeometry, new MeshPhysicalMaterial({ color: '#00ff00' }));
  rightWall.scale.set(20, 15, 1);
  rightWall.rotation.y = Math.PI * -0.5;
  rightWall.position.set(10, 7.5, 0);
  rightWall.receiveShadow = true;
  scene.add(rightWall);

  const whiteMaterial = new MeshPhysicalMaterial({ color: '#fff' });

  const floor = new Mesh(wallGeometry, whiteMaterial);
  floor.scale.set(20, 20, 1);
  floor.rotation.x = Math.PI * -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const backWall = new Mesh(wallGeometry, whiteMaterial);
  backWall.scale.set(15, 20, 1);
  backWall.rotation.z = Math.PI * -0.5;
  backWall.position.set(0, 7.5, -10);
  backWall.receiveShadow = true;
  scene.add(backWall);

  const ceiling = new Mesh(wallGeometry, whiteMaterial);
  ceiling.scale.set(20, 20, 1);
  ceiling.rotation.x = Math.PI * 0.5;
  ceiling.position.set(0, 15, 0);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  const sphereGeometry = new SphereGeometry(2, 64, 32);
  const cone = () => {
    const mesh = shadowed(new Mesh(new ConeGeometry(2.5, 7, 64), whiteMaterial));
    mesh.position.set(-3, 3.5, -2);
    return mesh;
  };

  if (setup === 'basic') {
    const tallBox = shadowed(new Mesh(new BoxGeometry(5, 7, 5), whiteMaterial));
    tallBox.rotation.y = Math.PI * 0.25;
    tallBox.position.set(-3, 3.5, -2);
    const shortBox = shadowed(new Mesh(new BoxGeometry(4, 4, 4), whiteMaterial));
    shortBox.rotation.y = Math.PI * -0.1;
    shortBox.position.set(4, 2, 4);
    scene.add(tallBox, shortBox);
  } else if (setup === 'rounded') {
    const sphere = shadowed(new Mesh(sphereGeometry, whiteMaterial));
    sphere.position.set(4, 2, 4);
    scene.add(cone(), sphere);
  } else if (setup === 'metallic') {
    // metals have no diffuse term, so the GI must not change it
    const metalSphere = shadowed(
      new Mesh(sphereGeometry, new MeshPhysicalMaterial({ color: '#fff', metalness: 1, roughness: 0 })),
    );
    metalSphere.position.set(4, 2, 4);
    scene.add(cone(), metalSphere);
  } else {
    const gltf = await ctx.loadGLTF('models/gltf/Michelle.glb');
    const character = gltf.scene;
    character.traverse((child) => {
      if ((child as Mesh).isMesh) shadowed(child);
    });
    character.scale.setScalar(10 / new Box3().setFromObject(character).getSize(new Vector3()).y);
    scene.add(character);

    const clip = gltf.animations[0];
    if (!clip) throw new Error('Michelle.glb has no animation');
    const mixer = new AnimationMixer(character);
    mixer.clipAction(clip).play();
    mixer.setTime(ANIMATED_POSE_TIME); // frozen pose, identical for every renderer
  }

  // Light source geometry: emissive so AO doesn't darken it. A real emitter in both renderers (see docs/PLAN.md).
  const lightSource = new Mesh(
    new CylinderGeometry(2.5, 2.5, 1, 64),
    new MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff }),
  );
  lightSource.position.y = 15;
  // deviation: the example's fixture doesn't cast shadows, but the pathtracer can't make one geometry transparent to
  // just the point light, so it shadows the ceiling around it in both renderers
  lightSource.castShadow = true;
  scene.add(lightSource);

  const pointLight = new PointLight('#ffffff', 100);
  pointLight.position.set(0, 13, 0);
  pointLight.distance = 100;
  pointLight.castShadow = true;
  pointLight.shadow.mapSize.width = 1024;
  pointLight.shadow.mapSize.height = 1024;
  scene.add(pointLight);

  scene.add(new AmbientLight('#0c0c0c'));

  return { scene, camera, target, toneMapping: NoToneMapping, toneMappingExposure: 1 };
}

const descriptions: Record<Setup, string> = {
  basic: 'Cornell box, "basic": Cornell box with a tall and a short box.',
  rounded: 'Cornell box, "rounded": Cornell box with a cone and a sphere.',
  metallic: 'Cornell box, "metallic": Cornell box with a cone and a mirror sphere.',
  animated: `Cornell box, "animated": Cornell box with Michelle.glb frozen at t=${ANIMATED_POSE_TIME}s.`,
};

export const ssgiScenes: SceneDefinition[] = (['basic', 'rounded', 'metallic', 'animated'] as const).map((setup) => ({
  name: `gi-${setup}`,
  description: descriptions[setup],
  width: WIDTH,
  height: HEIGHT,
  create: (ctx) => createCornellBox(setup, ctx),
}));
