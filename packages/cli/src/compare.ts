import sharp from 'sharp';

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

/** All errors are normalized to 0–1. `psnr` is in dB over RGB 0–255, and `null` when the images are identical (infinite PSNR). */
export interface ImageMetrics {
  psnr: number | null;
  rmse: number;
  mae: number;
  maxError: number;
}

/** Encoding for committed result images: near-lossless (worst render ~40 dB PSNR vs PNG), full-res chroma so noise and false colour survive. */
export const RESULT_AVIF = { quality: 90, chromaSubsampling: '4:4:4' } as const;

/** Decodes an image (path or encoded buffer) to 8-bit RGB, dropping alpha. */
export async function readRgb(input: string | Buffer): Promise<RawImage> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Inferno colormap, polynomial fit by Matt Zucker (CC0). inferno(0) clamps to black.
const INFERNO = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
] as const;

function inferno(t: number): [number, number, number] {
  const rgb: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    let v = 0;
    for (let i = INFERNO.length - 1; i >= 0; i -= 1) v = v * t + INFERNO[i]![c]!;
    rgb[c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return rgb;
}

// Max-channel error e (0–255) → t = min(1, 2·sqrt(e/255)): 1/255 error is already visible, ≥25% error saturates.
const DELTA_LUT = Array.from({ length: 256 }, (_, e) => inferno(Math.min(1, 2 * Math.sqrt(e / 255))));

/** Computes metrics and an RGB heat-map delta image (black = identical) from two equal-size RGB images. */
export function compareRgb(reference: RawImage, test: RawImage): { metrics: ImageMetrics; delta: RawImage } {
  if (reference.width !== test.width || reference.height !== test.height) {
    throw new Error(
      `Image size mismatch: reference ${reference.width}x${reference.height} vs test ${test.width}x${test.height}`,
    );
  }
  const n = reference.data.length;
  const delta = Buffer.alloc(n);
  let sumSq = 0;
  let sumAbs = 0;
  let max = 0;
  for (let p = 0; p < n; p += 3) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(reference.data[p + c]! - test.data[p + c]!);
      sumSq += d * d;
      sumAbs += d;
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax > max) max = pixelMax;
    const [r, g, b] = DELTA_LUT[pixelMax]!;
    delta[p] = r;
    delta[p + 1] = g;
    delta[p + 2] = b;
  }
  const mse = sumSq / n;
  return {
    metrics: {
      psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
      rmse: Math.sqrt(mse) / 255,
      mae: sumAbs / n / 255,
      maxError: max / 255,
    },
    delta: { data: delta, width: reference.width, height: reference.height },
  };
}
