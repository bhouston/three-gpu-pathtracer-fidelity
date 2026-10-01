// Node scene context: reads assets from disk, decodes glTF images with sharp and runs the Draco and Basis decoders
// in-thread.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveObjectURL } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { DataTexture, LoadingManager } from 'three';
import type { Texture } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
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

export function createNodeSceneContext(examplesDir = threeExamplesDir): SceneContext {
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
      const file = path.join(examplesDir, assetPath);
      return loader.parseAsync(
        new Uint8Array(await readFile(file)).buffer,
        `${pathToFileURL(path.dirname(file)).href}/`,
      );
    },
    async loadHDR(assetPath) {
      return new HDRLoader().createDataTexture(
        new Uint8Array(await readFile(path.join(examplesDir, assetPath))).buffer,
      );
    },
  };
}
