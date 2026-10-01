import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import { expect, it } from 'vitest';
import { traceDirectOnly } from './pathtracer.js';

it('patches the path tracing shader to stop at the second surface hit', () => {
  const material = new PhysicalPathTracingMaterial();
  traceDirectOnly(material);
  expect(material.fragmentShader).toContain('SURFACE_HIT && ! state.firstRay');
  expect(() => traceDirectOnly({ fragmentShader: 'void main() {}', needsUpdate: false })).toThrow('shader changed');
});
