/** Pure legacy-link mapping shared with the retired sibling site. */
export function legacyDestination(href, canonicalBase, manifest) {
  const old = new URL(href);
  const target = new URL(canonicalBase);
  target.search = old.search;
  const scenes = new Map(manifest.sceneMappings.map((entry) => [entry.source, entry.id]));
  const renderers = manifest.rendererMappings;
  const scene = old.searchParams.get('scene');
  if (scene && scenes.has(scene)) target.searchParams.set('scene', scenes.get(scene));
  for (const key of ['renderer', 'ref', 'renderers']) {
    if (old.searchParams.has(key))
      target.searchParams.set(
        key,
        old.searchParams
          .get(key)
          .split(',')
          .map((value) => renderers[value] ?? value)
          .join(','),
      );
  }
  if (!old.searchParams.has('view')) target.searchParams.set('view', 'fidelity');
  if (!old.searchParams.has('renderers') && !old.searchParams.has('renderer'))
    target.searchParams.set('renderers', 'blender,three-gpu-pathtracer-webgpu-experimental');
  if (!old.searchParams.has('ref')) target.searchParams.set('ref', 'three-gpu-pathtracer');
  if (!scene && !old.searchParams.has('tags')) target.searchParams.set('tags', 'pathtracer-import');
  let hash = old.hash.slice(1);
  if (scenes.has(hash)) hash = scenes.get(hash);
  for (const [source, destination] of Object.entries(renderers))
    if (hash === 'vs-' + source) hash = 'vs-' + destination;
  target.hash = hash;
  return target.href;
}
