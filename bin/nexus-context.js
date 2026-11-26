#!/usr/bin/env node
import { createNexusContext } from '../src/core/index.js';
import { runCli } from '../src/cli/index.js';

const exitCode = await runCli(process.argv.slice(2), {
  createNexusContext
});

process.exitCode = exitCode;
