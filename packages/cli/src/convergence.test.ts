import { describe, expect, it } from 'vitest';
import { checkpoints, ConvergenceMonitor, estimateNoise } from './convergence.js';

/** RGBA8 image whose RGB channels hold `value(x, y)`. */
function image(width: number, height: number, value: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.fill(value(x, y), (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return data;
}

/** An image whose difference to the half-sample image halves per doubling of the samples, like noise. */
const converging = (samples: number) => image(4, 4, () => 100 + Math.round(512 / samples));

/** One pixel steps by 1/255 per checkpoint: noise far under any threshold from the start. */
const nearlyStill = (samples: number) => image(2, 2, (x, y) => (x + y === 0 ? 50 + Math.log2(samples) : 50));

describe('checkpoints', () => {
  it('grows geometrically, four steps per doubling, ending at the maximum', () => {
    const result = checkpoints(64);
    expect(result).toEqual([8, 10, 11, 13, 16, 19, 23, 27, 32, 38, 45, 54, 64]);
    expect(checkpoints(100).at(-1)).toBe(100);
    expect(checkpoints(4)).toEqual([4]);
  });
});

describe('estimateNoise', () => {
  it('is the RMS difference for half-sample snapshots, and scales for other ratios', () => {
    const previous = image(4, 4, () => 100);
    const current = image(4, 4, () => 110);
    const half = estimateNoise(current, 64, previous, 32, 4, 4);
    expect(half.rms).toBeCloseTo(10 / 255);
    expect(half.tile).toBeCloseTo(10 / 255);
    // M = N/4: √(M / (N − M)) = √(1/3)
    expect(estimateNoise(current, 64, previous, 16, 4, 4).rms).toBeCloseTo(10 / 255 / Math.sqrt(3));
  });

  it('reports the percentile tile, so a small noisy region is not averaged away', () => {
    const previous = image(64, 64, () => 100);
    // one noisy 16 px tile out of 16
    const current = image(64, 64, (x, y) => (x < 16 && y < 16 ? 120 : 100));
    const estimate = estimateNoise(current, 64, previous, 32, 64, 64);
    expect(estimate.tile).toBeCloseTo(20 / 255);
    expect(estimate.rms).toBeCloseTo(20 / 255 / 4);
    expect(estimateNoise(current, 64, previous, 32, 64, 64, { percentile: 0.5 }).tile).toBe(0);
  });

  it('rejects invalid sample counts and sizes', () => {
    const pixels = image(2, 2, () => 0);
    expect(() => estimateNoise(pixels, 32, pixels, 32, 2, 2)).toThrow(/previousSamples/);
    expect(() => estimateNoise(pixels, 32, pixels, 16, 3, 2)).toThrow(/RGBA8/);
  });
});

describe('ConvergenceMonitor', () => {
  it('stops once the estimate reaches the threshold, but not before the minimum samples', () => {
    const monitor = new ConvergenceMonitor(4, 4, { threshold: 0.01, minSamples: 32 });
    expect(monitor.add(8, converging(8))).toBe(false);
    expect(monitor.last).toBeUndefined();
    expect(monitor.add(16, converging(16))).toBe(false); // 164 vs 132: 32/255 noise
    expect(monitor.add(32, converging(32))).toBe(false);
    expect(monitor.add(64, converging(64))).toBe(false);
    expect(monitor.add(128, converging(128))).toBe(false); // 4/255 = 1.6 %
    expect(monitor.add(256, converging(256))).toBe(true); // 2/255 = 0.8 %
    expect(monitor.last).toMatchObject({ samples: 256 });
    expect(monitor.last!.tile).toBeCloseTo(2 / 255);
  });

  it('respects the minimum samples even when already converged', () => {
    const monitor = new ConvergenceMonitor(2, 2, { threshold: 0.01, minSamples: 64 });
    expect(monitor.add(16, nearlyStill(16))).toBe(false);
    expect(monitor.add(32, nearlyStill(32))).toBe(false);
    expect(monitor.add(64, nearlyStill(64))).toBe(true);
  });

  it('never treats an unchanged image as converged', () => {
    const monitor = new ConvergenceMonitor(2, 2, { threshold: 0.01, minSamples: 0 });
    const black = image(2, 2, () => 0);
    expect(monitor.add(16, black)).toBe(false);
    expect(monitor.add(32, black)).toBe(false);
    expect(monitor.last).toMatchObject({ rms: 0, tile: 0 });
  });

  it('compares against the snapshot nearest half the samples and copies readbacks', () => {
    const monitor = new ConvergenceMonitor(2, 2, { threshold: 0, minSamples: 0 });
    const buffer = image(2, 2, () => 0);
    for (const samples of checkpoints(64)) {
      monitor.add(samples, buffer);
      buffer.fill(samples); // a reused readback buffer must not change the stored snapshots
    }
    // 64 vs 32: snapshot 32 holds the value written after checkpoint 27
    expect(monitor.last).toMatchObject({ samples: 64 });
    expect(monitor.last!.rms).toBeCloseTo((54 - 27) / 255);
  });
});
