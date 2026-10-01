import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { OpenCliDocument } from '@clidoc/core';
import { createDocgenCommand, fromYargsAsync } from '@clidoc/yargs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fileCommands } from 'yargs-file-commands';

// Commands are the files in ./commands (list, render, quality-gate, ...).
async function loadCommands() {
  const commandsDir = fileURLToPath(new URL('./commands', import.meta.url));
  return fileCommands({ commandDirs: [commandsDir] });
}

/** OpenCLI document of this CLI (clidoc), served by `cli __opencli`. */
export async function cliDocument(): Promise<OpenCliDocument> {
  const commands = await loadCommands();
  const docgen = createDocgenCommand(() => cliDocument());
  return fromYargsAsync([...commands, docgen], {
    title: 'three-gpu-pathtracer-fidelity',
    binary: 'cli',
    version: '0.1.0',
  });
}

export async function runCli(argv = hideBin(process.argv)): Promise<void> {
  // Child renderers inherit this, so long runs don't starve the machine.
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Unsupported platform or insufficient rights: run at normal priority.
  }
  const commands = await loadCommands();
  const docgen = createDocgenCommand(() =>
    fromYargsAsync([...commands, docgen], { title: 'three-gpu-pathtracer-fidelity', binary: 'cli', version: '0.1.0' }),
  );
  await yargs(argv)
    .scriptName('cli')
    .usage('$0 <command>')
    .command([...commands, docgen])
    .strictCommands()
    .demandCommand(1)
    .help()
    .parseAsync();
}
