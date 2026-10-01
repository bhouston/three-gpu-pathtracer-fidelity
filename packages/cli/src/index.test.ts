import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCommands } from 'yargs-file-commands';
import { expect, test } from 'vitest';

const cliDir = fileURLToPath(new URL('../dist/', import.meta.url));

test('command modules are valid', async () => {
  const commandsDir = path.join(cliDir, 'commands');
  await expect(validateCommands({ commandDirs: [commandsDir] })).resolves.toBeUndefined();
});

test('docgen document includes CLI commands', async () => {
  const document = JSON.parse(
    execFileSync(process.execPath, [path.join(cliDir, 'bin.js'), 'docgen'], { encoding: 'utf8' }),
  );
  expect(document.opencliVersion).toBeTruthy();
  expect(document.commands?.['cli list']).toBeDefined();
  expect(document.commands?.['cli docgen']).toBeDefined();
});
