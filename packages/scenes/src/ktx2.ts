import { DataTexture, LinearMipmapLinearFilter } from 'three';
import type { CompressedTexture, LoadingManager } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/**
 * KTX2Loader that transcodes Basis textures to RGBA8 DataTextures (no GPU compressed formats), so every renderer
 * (WebGPU, the WebGL pathtracer, headless or not) samples the same texels.
 */
export class RGBAKTX2Loader extends KTX2Loader {
  constructor(manager?: LoadingManager) {
    super(manager);
    this.workerConfig = {
      astcSupported: false,
      astcHDRSupported: false,
      etc1Supported: false,
      etc2Supported: false,
      dxtSupported: false,
      bptcSupported: false,
      pvrtcSupported: false,
    };
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- KTX2Loader internal
  async _createTextureFrom(...args: any[]): Promise<DataTexture> {
    // oxlint-disable-next-line typescript/no-explicit-any -- KTX2Loader internal
    const compressed: CompressedTexture = await (KTX2Loader.prototype as any)._createTextureFrom.apply(this, args);
    const { data, width, height } = compressed.mipmaps![0]!;
    const texture = new DataTexture(data as Uint8Array, width, height);
    texture.colorSpace = compressed.colorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    compressed.dispose();
    return texture;
  }
}
