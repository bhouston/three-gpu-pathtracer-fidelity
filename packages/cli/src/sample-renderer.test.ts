import { describe, expect, it, vi } from 'vitest';
import type { LiveRenderer } from '@pathtracer-fidelity/renderers';
import { renderUntilSamples } from './sample-renderer.js';

describe('completed samples', () => {
  it('keeps advancing wavefront bounces until every pixel completes the target', async () => {
    let frames = 0;
    const cap = vi.fn();
    const renderer = {
      get frames() {
        return frames;
      },
      render() {
        frames++;
      },
      setSampleLimit: cap,
      async getCompletedSamples() {
        return Math.floor(frames / 3);
      },
    } as unknown as LiveRenderer;
    const advance = vi.fn();
    expect(await renderUntilSamples(renderer, 2, 0, advance)).toBe(2);
    expect(frames).toBe(6);
    expect(cap).toHaveBeenCalledWith(2);
    expect(advance).toHaveBeenCalledTimes(6);
    expect(await renderUntilSamples(renderer, 4, 2, advance)).toBe(4);
    expect(cap).toHaveBeenLastCalledWith(4);
  });

  it('uses full-frame counters for legacy renderers', async () => {
    let frames = 0;
    const renderer = {
      get frames() {
        return frames;
      },
      render() {
        frames++;
      },
    } as unknown as LiveRenderer;
    expect(await renderUntilSamples(renderer, 2, 0, () => {})).toBe(2);
    expect(frames).toBe(2);
  });

  it('rejects a stalled GPU instead of accepting a black or unfinished result', async () => {
    const renderer = {
      frames: 0,
      render() {},
      async getCompletedSamples() {
        return 0;
      },
    } as unknown as LiveRenderer;
    await expect(renderUntilSamples(renderer, 1, 0, () => {})).rejects.toThrow('did not complete');
  });
});
