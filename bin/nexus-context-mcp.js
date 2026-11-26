#!/usr/bin/env node
import { createNexusContext } from '../src/core/index.js';
import { runCli } from '../src/cli/index.js';
import { startStdioServer } from '../src/mcp/server.js';

const exitCode = await runCli(['mcp', ...process.argv.slice(2)], {
  createNexusContext,
  startStdioServer
});

process.exitCode = exitCode;
