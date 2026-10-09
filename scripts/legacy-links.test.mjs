import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../migration/pathtracer-history.json' with { type: 'json' };
import { legacyDestination } from './legacy-links.mjs';
test('maps every source scene and renderer while preserving output, view and comparison options', () => {
  for (const scene of manifest.sceneMappings)
    for (const [source, canonical] of Object.entries(manifest.rendererMappings)) {
      const old = new URL('https://old.invalid/?output=beauty&zoom=2');
      old.searchParams.set('scene', scene.source);
      old.searchParams.set('renderer', source);
      old.searchParams.set('ref', source);
      old.hash = 'vs-' + source;
      const next = new URL(legacyDestination(old.href, 'https://new.invalid/project/', manifest));
      assert.equal(next.pathname, '/project/');
      assert.equal(next.searchParams.get('scene'), scene.id);
      assert.equal(next.searchParams.get('renderer'), canonical);
      assert.equal(next.searchParams.get('ref'), canonical);
      assert.equal(next.searchParams.get('zoom'), '2');
      assert.equal(next.hash, '#vs-' + canonical);
    }
});
test('defaults the old landing page to imported path-tracer comparisons and maps group selection', () => {
  const next = new URL(
    legacyDestination('https://old.invalid/?renderers=webgpu-new,blender', 'https://new.invalid/', manifest),
  );
  assert.equal(next.searchParams.get('renderers'), 'three-gpu-pathtracer-webgpu-experimental,blender');
  assert.equal(next.searchParams.get('tags'), 'pathtracer-import');
  assert.equal(next.searchParams.get('view'), 'fidelity');
});
test('preserves an explicit empty renderer selection and unknown legacy fields', () => {
  const next = new URL(
    legacyDestination('https://old.invalid/?renderers=&scene=unknown&view=live', 'https://new.invalid/', manifest),
  );
  assert.equal(next.searchParams.get('renderers'), '');
  assert.equal(next.searchParams.get('scene'), 'unknown');
  assert.equal(next.searchParams.get('view'), 'live');
});

test('generated redirect executes correctly and preserves original image URLs', async () => {
  const out = await mkdtemp(join(tmpdir(), 'fidelity-redirect-'));
  try {
    execFileSync(process.execPath, [
      'scripts/build-legacy-redirect.mjs',
      '--out',
      out,
      ...(!existsSync('fidelity-results') ? ['--source'] : []),
    ]);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    let destination;
    runInNewContext(script, {
      URL,
      location: {
        href: 'https://old.invalid/?scene=khronos-Box&renderers=webgpu-new#vs-webgpu-new',
        replace(value) {
          destination = value;
        },
      },
      document: {
        getElementById() {
          return {};
        },
      },
    });
    const target = new URL(destination);
    assert.equal(target.searchParams.get('scene'), 'pt-khronos-box');
    assert.equal(target.searchParams.get('renderers'), 'three-gpu-pathtracer-webgpu-experimental');
    assert.equal(target.hash, '#vs-three-gpu-pathtracer-webgpu-experimental');
    const entry = manifest.images[0];
    assert.equal((await readFile(join(out, 'data', entry.source))).length, entry.bytes);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
