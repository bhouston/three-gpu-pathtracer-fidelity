import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file is packages/cli/{src,dist}/paths). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** results/<scene-name>/<pass-name>/<renderer-name>.avif, committed. */
export const resultsDir = path.join(repoRoot, 'results');

export const passDir = (sceneName: string, passName: string, root = resultsDir) => path.join(root, sceneName, passName);

export const renderPath = (sceneName: string, passName: string, rendererName: string, root = resultsDir) =>
  path.join(passDir(sceneName, passName, root), `${rendererName}.avif`);

/** `fidelity-kit process`'s metrics file for one renderer vs one reference. */
export const metricsPath = (
  sceneName: string,
  passName: string,
  rendererName: string,
  reference: string,
  root = resultsDir,
) => path.join(passDir(sceneName, passName, root), `${rendererName}.vs-${reference}.metrics.json`);
