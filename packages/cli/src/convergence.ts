// Noise-targeted stopping for the path tracers, which have no per-pixel adaptive sampling of their own.
//
// A progressive render after N samples is the mean of N independent estimates, so its noise falls as σ/√N. The image
// after M < N samples shares its first M samples, and Var(I_M − I_N) = σ²(1/M − 1/N). The remaining noise of I_N,
// σ/√N, is therefore RMS(I_M − I_N) · √(M / (N − M)): with M = N/2 it is simply the RMS difference of the two
// snapshots. Comparing snapshots needs no access to the renderers' accumulation buffers, only canvas readbacks.

/** Display-space RMS noise estimates, in [0, 1] units of the 8-bit output. */
export interface NoiseEstimate {
  /** Samples of the image the estimate describes. */
  samples: number;
  /** Whole-image RMS noise. */
  rms: number;
  /** RMS noise of the tile at the configured percentile: what the stopping rule compares to the threshold. */
  tile: number;
}

export interface ConvergenceOptions {
  /** Target noise of the percentile tile; the render stops once the estimate is at or below it. */
  threshold: number;
  /** Never stop before this many samples. */
  minSamples: number;
  /** Tile edge in pixels. Small enough that a caustic or a glossy highlight dominates its tile. */
  tileSize?: number;
  /** Tile percentile in [0, 1]; 1 is the noisiest tile. */
  percentile?: number;
}

/** Checkpoints per doubling of the sample count: stops overshoot by at most 2^(1/4) ≈ 19 %. */
const STEPS_PER_DOUBLING = 4;
const FIRST_CHECKPOINT = 8;

/** Geometric sample counts at which convergence is checked, ending at `maxSamples`. */
export function checkpoints(maxSamples: number, stepsPerDoubling = STEPS_PER_DOUBLING): number[] {
  const result: number[] = [];
  for (let k = 0; ; k++) {
    const samples = Math.round(FIRST_CHECKPOINT * 2 ** (k / stepsPerDoubling));
    if (samples >= maxSamples) break;
    if (samples !== result.at(-1)) result.push(samples);
  }
  result.push(maxSamples);
  return result;
}

/**
 * Noise of `current` (after `samples`) estimated from its difference to `previous` (after `previousSamples`). Both are
 * RGBA8 images of the same size; alpha is ignored.
 */
export function estimateNoise(
  current: Uint8Array,
  samples: number,
  previous: Uint8Array,
  previousSamples: number,
  width: number,
  height: number,
  { tileSize = 16, percentile = 0.99 }: Pick<ConvergenceOptions, 'tileSize' | 'percentile'> = {},
): NoiseEstimate {
  if (!(previousSamples > 0 && previousSamples < samples)) throw new Error('previousSamples must be in (0, samples)');
  if (current.length !== width * height * 4 || previous.length !== current.length)
    throw new Error('Images must be RGBA8 of width × height');
  const scale = Math.sqrt(previousSamples / (samples - previousSamples)) / 255;
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const tileSums = new Float64Array(tilesX * tilesY);
  const tileCounts = new Uint32Array(tilesX * tilesY);
  let sum = 0;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / tileSize) * tilesX;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dr = current[i]! - previous[i]!;
      const dg = current[i + 1]! - previous[i + 1]!;
      const db = current[i + 2]! - previous[i + 2]!;
      const squared = dr * dr + dg * dg + db * db;
      const tile = row + Math.floor(x / tileSize);
      tileSums[tile]! += squared;
      tileCounts[tile]! += 3;
      sum += squared;
    }
  }
  const tiles = Array.from(tileSums, (tileSum, i) => Math.sqrt(tileSum / tileCounts[i]!)).toSorted((a, b) => a - b);
  const index = Math.min(tiles.length - 1, Math.max(0, Math.ceil(percentile * tiles.length) - 1));
  return {
    samples,
    rms: Math.sqrt(sum / (width * height * 3)) * scale,
    tile: tiles[index]! * scale,
  };
}

/** Tracks checkpoint snapshots of one render and decides when it has converged. */
export class ConvergenceMonitor {
  private readonly snapshots: { samples: number; pixels: Uint8Array }[] = [];
  /** The latest estimate, if any checkpoint had a half-sample snapshot to compare with. */
  last: NoiseEstimate | undefined;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly options: ConvergenceOptions,
  ) {}

  /** Records the image after `samples` (callers pass increasing counts); returns true once it has converged. */
  add(samples: number, pixels: Uint8Array): boolean {
    const half = samples / 2;
    // the snapshot nearest to half the samples: the most balanced, so the least noisy, estimate
    let reference: (typeof this.snapshots)[number] | undefined;
    for (const snapshot of this.snapshots) {
      if (!reference || Math.abs(snapshot.samples - half) < Math.abs(reference.samples - half)) reference = snapshot;
    }
    if (reference) {
      this.last = estimateNoise(
        pixels,
        samples,
        reference.pixels,
        reference.samples,
        this.width,
        this.height,
        this.options,
      );
    }
    // readbacks may reuse their buffer, so keep a copy; later checkpoints only need snapshots near their half
    this.snapshots.push({ samples, pixels: pixels.slice() });
    while (this.snapshots.length > STEPS_PER_DOUBLING + 1) this.snapshots.shift();
    // an unchanged image is not converged: the readback is stale or the GPU context lost, never noise-free
    const { last } = this;
    return (
      samples >= this.options.minSamples && last !== undefined && last.rms > 0 && last.tile <= this.options.threshold
    );
  }
}
