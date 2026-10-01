import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricsPath, renderPath } from './paths.js';

describe('result paths', () => {
  const root = path.join(process.cwd(), 'temporary-results');

  it("uses fidelity-kit's <renderer>.vs-<reference>.metrics.json naming", () => {
    expect(metricsPath('cornell', 'webgpu-new', 'webgl-legacy', root)).toBe(
      path.join(root, 'cornell', 'beauty', 'webgpu-new.vs-webgl-legacy.metrics.json'),
    );
    expect(metricsPath('cornell', 'webgl-legacy', 'blender', root)).toBe(
      path.join(root, 'cornell', 'beauty', 'webgl-legacy.vs-blender.metrics.json'),
    );
    expect(renderPath('cornell', 'webgl-legacy', root)).toBe(path.join(root, 'cornell', 'beauty', 'webgl-legacy.avif'));
  });
});
