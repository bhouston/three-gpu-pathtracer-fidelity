// Blender rendering, export, color management and process lifecycle belong to the pinned fidelity-kit adapter.
import { outputSettings, renderScene } from 'fidelity-kit-blender/three';
import { SRGBColorSpace, WebGLRenderer } from 'three';
import type { Scene } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { environmentEquirect, PATHTRACER_BOUNCES } from '@pathtracer-fidelity/renderers';
import type { SceneSetup } from '@pathtracer-fidelity/scenes';

export interface BlenderRenderOptions {
  width: number;
  height: number;
  samples: number;
  device?: 'auto' | 'cpu' | 'gpu';
  /** Headless WebGL canvas, used only when procedural lighting needs baking. */
  canvas: HTMLCanvasElement;
}

/** Returns opaque sRGB RGBA8, top row first. Unsupported features fail instead of silently changing a reference. */
export async function renderBlender(setup: SceneSetup, options: BlenderRenderOptions): Promise<Uint8Array> {
  const { width, height, samples, canvas } = options;
  const camera = setup.camera.clone();
  setup.camera.updateWorldMatrix(true, false);
  setup.camera.getWorldPosition(camera.position);
  setup.camera.getWorldQuaternion(camera.quaternion);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  let renderer: WebGLRenderer | undefined;
  let environment;
  try {
    if (setup.environment) {
      renderer = new WebGLRenderer({ canvas });
      environment = environmentEquirect(renderer, setup);
    }
    // Baking needs a GPU; exporting the resulting readable texture does not.
    renderer?.dispose();
    renderer = undefined;
    const scene = clone(setup.scene) as Scene;
    // Scene.copy clones these textures independently, losing background === environment identity.
    scene.environment = environment ?? setup.scene.environment;
    scene.background =
      setup.scene.background === setup.scene.environment && environment ? environment : setup.scene.background;
    const gradient = setup.gradientBackground;
    const result = await renderScene({
      scene,
      camera,
      width,
      height,
      samples,
      device: options.device ?? 'auto',
      bounces: PATHTRACER_BOUNCES,
      seed: 1,
      denoise: false,
      adaptiveThreshold: 0,
      ...outputSettings({
        toneMapping: setup.toneMapping,
        toneMappingExposure: setup.toneMappingExposure,
        outputColorSpace: SRGBColorSpace,
      }),
      background: gradient
        ? {
            type: 'gradient',
            center: [gradient.center.r, gradient.center.g, gradient.center.b],
            edge: [gradient.edge.r, gradient.edge.g, gradient.edge.b],
          }
        : scene.background === null
          ? { type: 'color', color: [0, 0, 0] }
          : undefined,
      features: { areaLights: true, depthOfField: true, textureBackground: true },
      unsupported: 'warn',
      onDiagnostic: (message) => {
        // The reference pathtracers also ignore ambient lights and finite punctual-light cutoffs.
        if (
          message.startsWith('Unsupported light AmbientLight:') ||
          message.includes('distance cutoff is unsupported')
        ) {
          console.warn(`blender: ${message}`);
        } else {
          throw new Error(`blender: ${message}`);
        }
      },
    });
    return result.pixels;
  } finally {
    renderer?.dispose();
    environment?.dispose();
  }
}
