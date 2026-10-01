// Node scene context: reads assets from disk, decodes glTF images with sharp and runs the Draco and Basis decoders
// in-thread.
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveObjectURL } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import sharp from 'sharp';
import { DataTexture, LoadingManager, MeshStandardMaterial, TextureLoader } from 'three';
import type { Mesh } from 'three';
import type { Texture } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { LDrawUtils } from 'three/addons/utils/LDrawUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RGBAKTX2Loader } from './ktx2.js';
import type { SceneContext } from './types.js';

/** `submodules/three.js/examples/`, found through the (single, workspace) `three` package. */
export const threeExamplesDir = fileURLToPath(new URL('../examples/', import.meta.resolve('three')));

async function readUrl(url: string): Promise<Buffer> {
  if (url.startsWith('blob:')) {
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error(`Unknown blob URL ${url}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  return readFile(url.startsWith('file:') ? fileURLToPath(url) : url);
}

/** Minimal TextureLoader stand-in: decodes to an RGBA8 DataTexture (the loader then sets flipY, sampler, color space). */
const imageLoader = {
  load(url: string, onLoad: (texture: Texture) => void, _onProgress: unknown, onError: (error: unknown) => void): void {
    readUrl(url)
      .then((buffer) => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
      .then(({ data, info }) => {
        const texture = new DataTexture(new Uint8Array(data), info.width, info.height);
        texture.needsUpdate = true;
        onLoad(texture);
      })
      .catch(onError);
  },
};

type MessageListener = (event: { data: unknown }) => void;

/** Runs DRACOLoader's / KTX2Loader's worker source on the main thread (node has no Web Worker). */
class InlineWorker {
  onmessage: MessageListener | null = null;
  private readonly listeners: MessageListener[] = [];
  private readonly workerListeners: MessageListener[] = [];
  private readonly ready: Promise<void>;

  constructor(url: string) {
    // the worker's `self`: globals (DRACOLoader looks up typed array constructors on it) plus the messaging API
    const scope = Object.assign(Object.create(globalThis) as object, {
      postMessage: (data: unknown) => {
        this.onmessage?.({ data });
        for (const listener of this.listeners) listener({ data });
      },
      addEventListener: (_type: string, listener: MessageListener) => this.workerListeners.push(listener),
    });
    this.ready = readUrl(url).then((source) => {
      // `var onmessage` keeps DRACOLoader's bare `onmessage = ...` inside the worker scope; `process` is hidden so the
      // emscripten decoders take their browser path (they are handed the wasm binary)
      // oxlint-disable-next-line typescript/no-implied-eval -- the worker source is the loader's own code
      const onmessage = new Function('self', 'process', `var onmessage;\n${source.toString()}\nreturn onmessage;`)(
        scope,
        undefined,
      ) as MessageListener | undefined;
      if (onmessage) this.workerListeners.push(onmessage);
    });
  }

  addEventListener(_type: string, listener: MessageListener): void {
    this.listeners.push(listener);
  }

  postMessage(data: unknown): void {
    data = structuredClone(data); // like a real worker: DRACOLoader sends every worker the same config object
    void this.ready.then(() => {
      for (const listener of this.workerListeners) listener({ data });
    });
  }

  terminate(): void {}
}

class NodeDRACOLoader extends DRACOLoader {
  // decoder paths default to file: URLs next to DRACOLoader.js; node's fetch can't load those
  _loadLibrary(url: string, responseType: string): Promise<string | ArrayBuffer> {
    return readUrl(url).then((buffer) =>
      responseType === 'text' ? buffer.toString('utf8') : new Uint8Array(buffer).buffer,
    );
  }
}

/** The repository root: a `@/` asset path is relative to it, any other to `examplesDir`. */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function createNodeSceneContext(examplesDir = threeExamplesDir): SceneContext {
  const resolveAsset = (assetPath: string) =>
    assetPath.startsWith('@/') ? path.join(repoRoot, assetPath.slice(2)) : path.join(examplesDir, assetPath);
  (globalThis as { self?: unknown }).self ??= globalThis; // GLTFLoader reads self.URL
  (globalThis as { Worker?: unknown }).Worker ??= InlineWorker;
  // FileLoader (KTX2Loader's) reports stream progress
  (globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class extends Event {};

  // FileLoader (external .gltf buffers, KTX2Loader's transcoder and textures) fetches, and node's fetch can't load
  // file: URLs: serve them as data: URLs
  const manager = new LoadingManager().setURLModifier((url) =>
    url.startsWith('file:')
      ? `data:application/octet-stream;base64,${readFileSync(fileURLToPath(url)).toString('base64')}`
      : url,
  );
  const loader = new GLTFLoader(manager)
    .setDRACOLoader(new NodeDRACOLoader())
    .setKTX2Loader(new RGBAKTX2Loader(manager))
    .setMeshoptDecoder(MeshoptDecoder);
  // first in line, ahead of EXT_texture_webp (whose support detection needs a DOM Image); sharp decodes webp too
  (loader as unknown as { pluginCallbacks: ((parser: GLTFParser) => unknown)[] }).pluginCallbacks.unshift(
    (parser: GLTFParser) => ({
      name: 'ss_fidelity_node_images',
      loadTexture(textureIndex: number) {
        const textureDef = parser.json.textures[textureIndex];
        if (textureDef.extensions?.KHR_texture_basisu) return null; // KTX2Loader's
        const source = textureDef.extensions?.EXT_texture_webp?.source ?? textureDef.source;
        return parser.loadTextureImage(textureIndex, source, imageLoader as never);
      },
    }),
  );

  return {
    async loadGLTF(assetPath) {
      const file = resolveAsset(assetPath);
      return loader.parseAsync(
        new Uint8Array(await readFile(file)).buffer,
        `${pathToFileURL(path.dirname(file)).href}/`,
      );
    },
    async loadHDR(assetPath) {
      return new HDRLoader().createDataTexture(new Uint8Array(await readFile(resolveAsset(assetPath))).buffer);
    },
    async loadLDraw(assetPath) {
      // LDrawLoader probes several folders for each part: a missing file must fail the fetch, not throw
      const ldrawManager = new LoadingManager().setURLModifier((url) =>
        url.startsWith('file:')
          ? existsSync(fileURLToPath(url))
            ? `data:application/octet-stream;base64,${readFileSync(fileURLToPath(url)).toString('base64')}`
            : 'missing:'
          : url,
      );
      const library = `${pathToFileURL(path.join(repoRoot, 'submodules/ldraw-parts-library')).href}/`;
      const ldraw = new LDrawLoader(ldrawManager);
      ldraw.setConditionalLineMaterial(LDrawConditionalLineMaterial as never);
      await ldraw.preloadMaterials(`${library}colors/ldcfgalt.ldr`);
      const result = await ldraw
        .setPartsLibraryPath(`${library}complete/ldraw/`)
        .loadAsync(pathToFileURL(resolveAsset(assetPath)).href);
      const model = LDrawUtils.mergeObject(result);
      model.rotation.set(Math.PI, 0, 0);
      const lines: Mesh[] = [];
      model.traverse((c) => {
        if ((c as { isLineSegments?: boolean }).isLineSegments) lines.push(c as Mesh);
        if ((c as Mesh).isMesh) ((c as Mesh).material as MeshStandardMaterial).roughness *= 0.25;
      });
      for (const line of lines) line.removeFromParent();
      return model;
    },
    async loadCollada(assetPath) {
      const file = resolveAsset(assetPath);
      (globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser; // ColladaLoader parses XML
      // ColladaComposer builds its own `new TextureLoader(manager)` (no plugin hook like GLTFLoader's); its default
      // `load` goes through ImageLoader, which needs a DOM `Image`/`document`. Patch it once to reuse the same
      // sharp-based decode as `imageLoader` above.
      (TextureLoader.prototype as { load: unknown }).load = function (
        this: TextureLoader,
        url: string,
        onLoad?: (texture: Texture) => void,
        _onProgress?: unknown,
        onError?: (error: unknown) => void,
      ): Texture {
        const texture = new DataTexture();
        readUrl(this.manager.resolveURL(this.path ? this.path + url : url))
          .then((buffer) => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
          .then(({ data, info }) => {
            texture.image = { data: new Uint8Array(data), width: info.width, height: info.height };
            texture.needsUpdate = true;
            onLoad?.(texture as unknown as Texture);
          })
          .catch((error: unknown) => onError?.(error));
        return texture as unknown as Texture;
      };
      const { scene } = new ColladaLoader().parse(
        await readFile(file, 'utf8'),
        `${pathToFileURL(path.dirname(file)).href}/`,
      )!;
      scene.scale.setScalar(1);
      scene.traverse((c) => {
        const material = (c as Mesh).material as MeshStandardMaterial & { isMeshPhongMaterial?: boolean };
        if (material?.isMeshPhongMaterial) {
          (c as Mesh).material = new MeshStandardMaterial({
            color: material.color,
            roughness: material.roughness || 0,
            metalness: material.metalness || 0,
            map: material.map || null,
          });
        }
      });
      return scene;
    },
  };
}
