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
import { writeSync } from 'fs';

// ============================================================================
// Native crash (SIGSEGV) catch: llama.cpp native binding 崩溃时捕获退出码
// 注意：如果 SEGV 发生在信号处理器无法恢复的位置（如栈溢出），此 hook 仍不可用
// ============================================================================
process.on('SIGSEGV', () => {
  const ts = new Date().toISOString();
  writeSync(2, `[CRASH] SIGSEGV at ${ts}\n`);
  writeSync(2, `[CRASH] Likely a native addon crash (@realtimex/node-llama-cpp / llama.cpp)\n`);
  writeSync(2, `[CRASH] Check your model GGUF batchSize/contextSize configuration\n`);
  // 用 abort 替代 exit 以跳过 signal-exit 等 exit hook，
  // 否则 hook 里的 cleanup 会触碰已崩溃的 native 模块导致死锁
  process.abort();
});

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
