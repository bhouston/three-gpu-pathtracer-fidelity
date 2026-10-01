import { describe, expect, it } from 'vitest';
import { compareRgb, type RawImage } from './compare.js';

const solid = (r: number, g: number, b: number, width = 4, height = 2): RawImage => ({
  data: Buffer.from(Array.from({ length: width * height }, () => [r, g, b]).flat()),
  width,
  height,
});

describe('compareRgb', () => {
  it('reports null PSNR, zero error and a black delta for identical images', () => {
    const image = solid(10, 128, 200);
    const { metrics, delta } = compareRgb(image, image);
    expect(metrics).toEqual({ psnr: null, rmse: 0, mae: 0, maxError: 0 });
    expect([delta.width, delta.height]).toEqual([4, 2]);
    expect(delta.data.every((v) => v === 0)).toBe(true);
  });

  it('computes metrics for a known difference', () => {
    // one channel off by 51 in every pixel: per-channel errors are [51, 0, 0]
    const { metrics, delta } = compareRgb(solid(100, 100, 100), solid(151, 100, 100));
    const mse = (51 * 51) / 3;
    expect(metrics.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / mse), 10);
    expect(metrics.rmse).toBeCloseTo(Math.sqrt(mse) / 255, 10);
    expect(metrics.mae).toBeCloseTo(17 / 255, 10);
    expect(metrics.maxError).toBeCloseTo(0.2, 10);
    expect(delta.data.some((v) => v > 0)).toBe(true);
  });

  it('rejects images of different sizes', () => {
    expect(() => compareRgb(solid(0, 0, 0, 2, 2), solid(0, 0, 0, 4, 2))).toThrow('size mismatch');
  });
});
