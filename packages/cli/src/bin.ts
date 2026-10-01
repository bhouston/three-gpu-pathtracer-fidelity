#!/usr/bin/env node
import { handleOpenCliRequest } from '@clidoc/core';
import { hideBin } from 'yargs/helpers';
import { cliDocument, runCli } from './index.js';

const argv = hideBin(process.argv);
if (argv[0] === '__opencli') {
  const document = await cliDocument();
  await handleOpenCliRequest(argv, () => document);
} else {
  await runCli(argv);
}
