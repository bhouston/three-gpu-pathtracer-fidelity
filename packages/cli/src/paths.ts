import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** results/<scene-name>/beauty/<renderer-name>.avif, committed. fidelity-kit wants an output folder per scene. */
export const resultsDir = path.join(repoRoot, 'results');

const OUTPUT = 'beauty';

export const renderPath = (sceneName: string, rendererName: string, root = resultsDir) =>
  path.join(root, sceneName, OUTPUT, `${rendererName}.avif`);

/** `fidelity-kit process`'s metrics file for one renderer vs one reference. */
export const metricsPath = (sceneName: string, rendererName: string, reference: string, root = resultsDir) =>
  path.join(root, sceneName, OUTPUT, `${rendererName}.vs-${reference}.metrics.json`);
