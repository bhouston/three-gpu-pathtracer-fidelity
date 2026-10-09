import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { legacyDestination } from './legacy-links.mjs';
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'legacy-site' },
    source: { type: 'boolean', default: false },
    base: { type: 'string', default: 'https://three-fidelity.ben3d.ca/' },
  },
});
const manifest = JSON.parse(await readFile('migration/pathtracer-history.json', 'utf8'));
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const script =
  '(' +
  legacyDestination.toString() +
  ')(location.href, ' +
  JSON.stringify(values.base) +
  ', ' +
  JSON.stringify({ sceneMappings: manifest.sceneMappings, rendererMappings: manifest.rendererMappings }) +
  ')';
const defaultDestination = legacyDestination('https://legacy.invalid/', values.base, manifest);
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Three.js fidelity suite has moved</title></head><body><h1>Three.js fidelity suite has moved</h1><p><a id="destination" href="' +
  defaultDestination.replaceAll('&', '&amp;') +
  '">Open the unified three-fidelity suite</a></p><p>Historical comparisons and source history are preserved.</p><script>const destination=' +
  script.replaceAll('<', '\u003c') +
  ';document.getElementById("destination").href=destination;location.replace(destination);</script></body></html>';
await writeFile(join(out, 'index.html'), html);
await writeFile(join(out, '404.html'), html);
await writeFile(join(out, '.nojekyll'), '');
for (const image of manifest.images) {
  const source = values.source ? join(manifest.sourceResultsRoot, image.source) : image.destination;
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== image.sha256)
    throw new Error('Historical source changed: ' + source);
  const destination = join(out, 'data', image.source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
await writeFile(join(out, 'migration.json'), JSON.stringify(manifest, null, 2));
console.log('Built legacy redirects and preserved ' + manifest.images.length + ' original image URLs.');
