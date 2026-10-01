import { getScene, listSceneNames } from '@pathtracer-fidelity/scenes';
import { defineCommand } from 'yargs-file-commands';

export const command = defineCommand({
  command: 'list',
  describe: 'List scene names',
  builder: (yargs) => yargs.option('verbose', { type: 'boolean', default: false, describe: 'Include descriptions' }),
  handler: (argv) => {
    for (const name of listSceneNames()) {
      console.log(argv.verbose ? `${name}\t${getScene(name).description}` : name);
    }
  },
});
