/**
 * New CLI entry point using commander.js (subcommand pattern)
 * @autodev/codebase v1.0.0+
 */
import { Command } from 'commander';
import { createSearchCommand } from './commands/search';
import { createIndexCommand } from './commands/index';
import { createOutlineCommand } from './commands/outline';
import { createStdioCommand } from './commands/stdio';
import { createConfigCommand } from './commands/config/index';
import { createCallCommand } from './commands/call';
import { createCacheCommand } from './commands/cache';
import { createHighlightCommand } from './commands/highlight';

/**
 * Main CLI program
 */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('codebase')
    .description('@autodev/codebase - Vector-based code search and indexing tool')
    .version('1.0.0');

  // Add subcommands
  program.addCommand(createSearchCommand());
  program.addCommand(createIndexCommand());
  program.addCommand(createOutlineCommand());
  program.addCommand(createStdioCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createCallCommand());
  program.addCommand(createCacheCommand());
  program.addCommand(createHighlightCommand());

  // Parse arguments
  await program.parseAsync(process.argv);
}

// Run the CLI
main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
