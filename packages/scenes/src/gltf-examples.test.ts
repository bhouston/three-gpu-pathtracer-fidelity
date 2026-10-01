import { DataTexture, FloatType, RGBAFormat, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { extractLights } from './gltf-examples.js';

const WIDTH = 64;
const HEIGHT = 32;

/** Luminance integrated over the sphere (the equirect texels' solid angles). */
function irradiance(data: Float32Array): number {
  let total = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const solidAngle = ((2 * Math.PI) / WIDTH) * (Math.PI / HEIGHT) * Math.sin(((y + 0.5) / HEIGHT) * Math.PI);
    for (let x = 0; x < WIDTH; x++) total += data[(y * WIDTH + x) * 4]! * solidAngle;
  }
  return total;
}

describe('extractLights', () => {
  it('moves a bright spot into a directional light toward it, conserving energy', () => {
    const data = new Float32Array(WIDTH * HEIGHT * 4).fill(1);
    // a grey sun at row 8 (theta = 8.5/32 * pi, above the horizon), column 48 (u = 48.5/64: phi = pi / 2 + a bit, +z)
    const sun = (8 * WIDTH + 48) * 4;
    data.fill(5000, sun, sun + 3);
    const hdr = new DataTexture(data, WIDTH, HEIGHT, RGBAFormat, FloatType);
    const before = irradiance(data);

    const lights = extractLights(hdr);

    expect(lights).toHaveLength(1);
    const theta = (8.5 / HEIGHT) * Math.PI;
    const phi = (48.5 / WIDTH - 0.5) * 2 * Math.PI;
    const expected = new Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    expect(lights[0]!.position.clone().normalize().dot(expected)).toBeCloseTo(1, 5);
    expect(irradiance(data) + lights[0]!.intensity).toBeCloseTo(before, 3);
    expect(data[sun]).toBeLessThan(5000);
  });

  it('leaves an HDR without bright sources alone', () => {
    const data = new Float32Array(WIDTH * HEIGHT * 4).fill(1);
    expect(extractLights(new DataTexture(data, WIDTH, HEIGHT, RGBAFormat, FloatType))).toHaveLength(0);
  });
});
