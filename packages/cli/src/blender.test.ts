import { ACESFilmicToneMapping, Color, LinearToneMapping, NoToneMapping } from 'three';
import { describe, expect, it } from 'vitest';
import { encodeLinear } from './blender.js';

describe('encodeLinear', () => {
  it('flips EXR rows to top-first and encodes sRGB', () => {
    // 1x2, bottom row first: bottom 0.5 opaque, top 0 opaque
    const linear = new Float32Array([0.5, 0.5, 0.5, 1, 0, 0, 0, 1]);
    const out = encodeLinear(linear, 1, 2, 'environment', NoToneMapping, 1);
    expect([...out]).toEqual([0, 0, 0, 255, 188, 188, 188, 255]);
  });

  it('composites the background under transparent pixels', () => {
    const grey = new Color(0x808080); // linear internally, like the scenes' colors
    const out = encodeLinear(new Float32Array(4), 1, 1, { center: grey, edge: grey }, NoToneMapping, 1);
    expect([...out]).toEqual([128, 128, 128, 255]);
  });

  it('applies ACES filmic like three.js and clamps', () => {
    const black = encodeLinear(new Float32Array([0, 0, 0, 1]), 1, 1, 'environment', ACESFilmicToneMapping, 1);
    const bright = encodeLinear(new Float32Array([100, 100, 100, 1]), 1, 1, 'environment', ACESFilmicToneMapping, 1);
    expect([...black]).toEqual([0, 0, 0, 255]);
    expect([...bright]).toEqual([255, 255, 255, 255]);
  });

  it('rejects tone mappings it does not implement', () => {
    expect(() => encodeLinear(new Float32Array(4), 1, 1, 'environment', LinearToneMapping, 1)).toThrow('unsupported');
  });
});
