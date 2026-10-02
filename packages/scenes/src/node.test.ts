import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { DataTexture, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createNodeSceneContext } from './node.js';

describe('Node legacy asset loading', () => {
  it('decodes Collada textures before returning without installing a DOM', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fidelity-collada-'));
    try {
      await sharp(new Uint8Array([255, 0, 0, 255]), { raw: { width: 1, height: 1, channels: 4 } })
        .png()
        .toFile(path.join(dir, 'red.png'));
      await writeFile(
        path.join(dir, 'scene.dae'),
        `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><unit meter="1"/><up_axis>Y_UP</up_axis></asset>
<library_images><image id="image"><init_from>red.png</init_from></image></library_images>
<library_effects><effect id="effect"><profile_COMMON>
<newparam sid="surface"><surface type="2D"><init_from>image</init_from></surface></newparam>
<newparam sid="sampler"><sampler2D><source>surface</source></sampler2D></newparam>
<technique sid="common"><phong><diffuse><texture texture="sampler" texcoord="UV"/></diffuse></phong></technique>
</profile_COMMON></effect></library_effects>
<library_materials><material id="material"><instance_effect url="#effect"/></material></library_materials>
<library_geometries><geometry id="geometry"><mesh>
<source id="positions"><float_array id="positions-array" count="9">0 0 0 1 0 0 0 1 0</float_array>
<technique_common><accessor source="#positions-array" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices>
<triangles count="1" material="material"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 1 2</p></triangles>
</mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="scene"><node id="mesh"><instance_geometry url="#geometry">
<bind_material><technique_common><instance_material symbol="material" target="#material"/></technique_common></bind_material>
</instance_geometry></node></visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene></COLLADA>`,
      );
      const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
      const scene = await createNodeSceneContext(dir).loadCollada('scene.dae');
      let material: MeshStandardMaterial | undefined;
      scene.traverse((object) => {
        if ((object as Mesh).isMesh) material = (object as Mesh).material as MeshStandardMaterial;
      });
      expect(material?.isMeshStandardMaterial).toBe(true);
      if (!material?.map) throw new Error('Expected decoded material texture');
      expect((material.map as DataTexture).image.data).toEqual(new Uint8Array([255, 0, 0, 255]));
      expect(material?.map?.flipY).toBe(true);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'document')).toEqual(documentBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves embedded LDraw subparts with Windows separators', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fidelity-ldraw-'));
    try {
      await writeFile(
        path.join(dir, 'scene.mpd'),
        [
          '0 FILE main.ldr',
          '0 !LDRAW_ORG Model',
          '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\custom.dat',
          '0 FILE s\\custom.dat',
          '0 !LDRAW_ORG Subpart',
          '3 16 0 0 0 10 0 0 0 10 0',
        ].join('\n'),
      );
      const scene = await createNodeSceneContext(dir).loadLDraw('scene.mpd');
      let triangles = 0;
      scene.traverse((object) => {
        if ((object as Mesh).isMesh) triangles += (object as Mesh).geometry.getAttribute('position').count / 3;
      });
      expect(triangles).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
