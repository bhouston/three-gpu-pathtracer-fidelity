import { describe, expect, it } from 'vitest';
import { selectNames } from './select.js';

const names = ['ssgi-basic', 'ssgi-rounded', 'ssr-steampunk-camera', 'ssr-steampunk-camera-roughness-0'];

describe('selectNames', () => {
  it('matches globs and comma lists in registry order', () => {
    expect(selectNames(names, '*', 'scene')).toEqual(names);
    expect(selectNames(names, 'ssr-*', 'scene')).toEqual(names.slice(2));
    expect(selectNames(names, 'ssr-steampunk-camera, ssgi-basic', 'scene')).toEqual(['ssgi-basic', names[2]]);
  });

  it('throws when a pattern matches nothing', () => {
    expect(() => selectNames(names, 'ssgi-*,nope', 'scene')).toThrow(/No scene matches "nope"/);
  });
});
