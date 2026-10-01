// Blender Cycles renderer: exports the scene (glTF + environment EXR), path traces it in Blender, then composites the
// background, tone maps and encodes in node exactly as three.js does. Runs in the headless WebGL render process.
import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  FloatType,
  NoToneMapping,
  SpotLight,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { DataTexture, Object3D, ToneMapping } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { EXRExporter } from 'three/addons/exporters/EXRExporter.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { environmentEquirect, PATHTRACER_BOUNCES } from '@pathtracer-fidelity/renderers';
import type { PassName } from '@pathtracer-fidelity/renderers';
import type { GradientBackground, SceneSetup } from '@pathtracer-fidelity/scenes';

const script = fileURLToPath(new URL('../blender/render.py', import.meta.url));

/** macOS: `/Applications/Blender*.app`, newest version first (a plain `Blender.app` sorts first). */
function macOSBlenderCandidates(): string[] {
  if (process.platform !== 'darwin') return [];
  let entries: string[];
  try {
    entries = readdirSync('/Applications').filter((name) => /^Blender(?:\s+.*)?\.app$/.test(name));
  } catch {
    return [];
  }
  entries.sort((a, b) =>
    a === 'Blender.app' ? -1 : b === 'Blender.app' ? 1 : b.localeCompare(a, undefined, { numeric: true }),
  );
  return entries.map((name) => path.join('/Applications', name, 'Contents', 'MacOS', 'Blender'));
}

/** Blender executable: $BLENDER_EXECUTABLE, else a macOS /Applications install, else `blender` on PATH. */
function blenderExecutable(): string {
  return process.env.BLENDER_EXECUTABLE || macOSBlenderCandidates()[0] || 'blender';
}

/** Cycles max bounces per pass: direct is first-hit lighting only (Cycles still MIS-samples lights and world). */
const passBounces: Record<PassName, number> = { beauty: PATHTRACER_BOUNCES, direct: 0, ao: 0 };

/** What primary rays that miss show: the environment itself, or a background composited under the render in node. */
export type Background = 'environment' | GradientBackground;

/** Just enough 2D canvas for GLTFExporter to encode DataTexture images (node-webgl canvases have no 2d context). */
class ExportCanvas {
  width = 1;
  height = 1;
  private data?: Uint8ClampedArray;

  getContext() {
    return {
      translate() {},
      scale() {},
      putImageData: (image: ImageData) => {
        this.data = image.data;
      },
    };
  }

  toBlob(callback: (blob: Blob) => void, mimeType: string): void {
    const format = mimeType.split('/')[1] as 'png' | 'jpeg' | 'webp';
    void sharp(this.data!, { raw: { width: this.width, height: this.height, channels: 4 } })
      .toFormat(format)
      .toBuffer()
      .then((buffer) => callback(new Blob([new Uint8Array(buffer)], { type: mimeType })));
  }
}

/** Binary glTF of the scene plus its camera; lights get their target as a child, the direction glTF can express. */
async function exportGlb(setup: SceneSetup): Promise<ArrayBuffer> {
  const { scene, camera } = setup;
  scene.updateMatrixWorld();
  const lights: (DirectionalLight | SpotLight)[] = [];
  const ambient: AmbientLight[] = [];
  scene.traverse((object: Object3D) => {
    if (object instanceof DirectionalLight || object instanceof SpotLight) lights.push(object);
    if (object instanceof AmbientLight) ambient.push(object);
  });
  // glTF has no ambient light, and the pathtracer ignores it too
  for (const light of ambient) light.removeFromParent();
  for (const light of lights) {
    light.lookAt(light.target.getWorldPosition(new Vector3()));
    light.add(light.target);
    light.target.position.set(0, 0, -1);
  }
  camera.name = 'ss_fidelity_camera'; // models may bring their own cameras
  scene.add(camera);
  const createElement = document.createElement;
  document.createElement = ((tag: string) =>
    tag === 'canvas' ? new ExportCanvas() : createElement.call(document, tag)) as typeof document.createElement;
  try {
    return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  } finally {
    document.createElement = createElement;
    scene.remove(camera);
  }
}

/** EXR of an equirect DataTexture. EXRExporter expects GL row order (bottom first), i.e. flipY false. */
async function exportEquirect(texture: DataTexture): Promise<Uint8Array> {
  const { data, width, height } = texture.image as { data: Uint16Array | Float32Array; width: number; height: number };
  let rows = data;
  if (texture.flipY) {
    const row = width * 4;
    rows = data.slice();
    for (let y = 0; y < height; y += 1) rows.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  }
  const glOrder = texture.clone();
  glOrder.image = { data: rows, width, height };
  return new EXRExporter().parse(glOrder);
}

/** Sends `signal` to the whole Blender process group (headless Blender can spawn helper processes). */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || typeof child.pid !== 'number') return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      killProcessGroup(child, 'SIGKILL');
      reject(error);
    });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      killProcessGroup(child, 'SIGKILL'); // best-effort: reap any straggling helper processes
      reject(new Error(`${executable} exited with code ${code}:\n${output.slice(-4000)}`));
    });
  });
}

// three.js tonemapping_pars_fragment ACESFilmicToneMapping; matrices are GLSL column-major (columns listed).
const ACES_IN = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777];
const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602];
const mul = (m: number[], [r, g, b]: number[]) => [0, 1, 2].map((i) => m[i]! * r! + m[i + 3]! * g! + m[i + 6]! * b!);
const rrtAndOdtFit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);

const toneMappers: Partial<Record<ToneMapping, (rgb: number[], exposure: number) => number[]>> = {
  [NoToneMapping]: (rgb) => rgb,
  [ACESFilmicToneMapping]: (rgb, exposure) =>
    mul(
      ACES_OUT,
      mul(
        ACES_IN,
        rgb.map((c) => (c * exposure) / 0.6),
      ).map(rrtAndOdtFit),
    ),
};

const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Composites `background` under premultiplied linear RGBA (bottom row first, as EXRLoader returns it), tone maps and
 * encodes to sRGB like the pathtracer's blit. Returns RGBA8, top row first.
 */
export function encodeLinear(
  linear: Float32Array,
  width: number,
  height: number,
  background: Background,
  toneMapping: ToneMapping,
  exposure: number,
): Uint8Array {
  const toneMap = toneMappers[toneMapping];
  if (!toneMap) throw new Error(`blender: unsupported tone mapping ${toneMapping}`);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = ((height - 1 - y) * width + x) * 4;
      const rgb = [linear[i]!, linear[i + 1]!, linear[i + 2]!];
      if (background !== 'environment') {
        const t = Math.hypot((x + 0.5) / width - 0.5, (y + 0.5) / height - 0.5) / 0.5;
        const { center, edge } = background;
        const alpha = linear[i + 3]!;
        rgb[0]! += (center.r + (edge.r - center.r) * t) * (1 - alpha);
        rgb[1]! += (center.g + (edge.g - center.g) * t) * (1 - alpha);
        rgb[2]! += (center.b + (edge.b - center.b) * t) * (1 - alpha);
      }
      const o = (y * width + x) * 4;
      toneMap(rgb, exposure).forEach((c, channel) => {
        out[o + channel] = Math.round(srgb(Math.min(1, Math.max(0, c))) * 255);
      });
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The pathtracer's background: gradient, color (a flat gradient), none (black), or the environment texture itself. */
function sceneBackground(setup: SceneSetup): Background {
  const { scene, gradientBackground } = setup;
  if (gradientBackground) return gradientBackground;
  const bg = scene.background;
  if (bg === null || bg instanceof Color) {
    const color = bg ?? new Color(0x000000);
    return { center: color, edge: color };
  }
  if (bg !== scene.environment || scene.backgroundIntensity !== scene.environmentIntensity) {
    throw new Error('blender: only a background equal to the environment (same intensity) is supported');
  }
  return 'environment';
}

export interface BlenderRenderOptions {
  width: number;
  height: number;
  pass: PassName;
  samples: number;
  /** Headless WebGL canvas, for baking the environment. */
  canvas: HTMLCanvasElement;
}

/** Renders the scene in Blender Cycles; returns RGBA8, top row first. */
export async function renderBlender(setup: SceneSetup, options: BlenderRenderOptions): Promise<Uint8Array> {
  const { width, height, pass, samples, canvas } = options;
  if (pass === 'ao')
    throw new Error(
      'blender: the ao pass is not supported (Cycles has no equivalent to AmbientOcclusionMaterial here)',
    );
  const { camera, effects, scene } = setup;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const bg = sceneBackground(setup);

  const dir = await mkdtemp(path.join(tmpdir(), 'three-gpu-pathtracer-fidelity-blender-'));
  try {
    const renderer = new WebGLRenderer({ canvas });
    const environment = environmentEquirect(renderer, setup);
    if (environment) await writeFile(path.join(dir, 'environment.exr'), await exportEquirect(environment));
    renderer.dispose();
    await writeFile(path.join(dir, 'scene.glb'), new Uint8Array(await exportGlb(setup)));

    const job = {
      glb: path.join(dir, 'scene.glb'),
      output: path.join(dir, 'render.exr'),
      environment: environment
        ? { path: path.join(dir, 'environment.exr'), intensity: scene.environmentIntensity }
        : undefined,
      transparent: bg !== 'environment',
      samples,
      bounces: passBounces[pass],
      width,
      height,
    };
    await writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
    await run(blenderExecutable(), [
      '--background',
      '--factory-startup',
      '--python',
      script,
      '--',
      path.join(dir, 'job.json'),
    ]);

    const exr = new EXRLoader().setDataType(FloatType).parse(new Uint8Array(await readFile(job.output)).buffer);
    return encodeLinear(exr.data as Float32Array, width, height, bg, effects.toneMapping, effects.toneMappingExposure);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
