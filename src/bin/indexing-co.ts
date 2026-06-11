#!/usr/bin/env node

import { createRootCommand } from "../commands";
import { runCli } from "../lib/runtime";

async function main(): Promise<void> {
  const command = createRootCommand();
  const exitCode = await runCli(command, process.argv.slice(2));
  process.exitCode = exitCode;
}

main();
