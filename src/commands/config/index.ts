/**
 * Config command (parent command)
 */
import { Command } from 'commander';

/**
 * Create config command with options
 */
export function createConfigCommand(): Command {
  const command = new Command('config');

  command
    .description('Manage configuration')
    .option('--get [items...]', 'View configuration layers')
    .option('--set <config>', 'Set configuration values')
    .option('-p, --path <path>', 'Working directory path', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--json', 'Output in JSON format')
    .option('--global', 'Set global configuration (only for --set)')
    .action(async (options) => {
      if (options.get !== undefined) {
        // Handle --get
        const { default: handler } = await import('./get');
        const items = Array.isArray(options.get) ? options.get : (options.get === true ? [] : [options.get]);
        await handler(items, options);
      } else if (options.set) {
        // Handle --set
        const { default: handler } = await import('./set');
        await handler(options.set, options);
      } else {
        // No option specified, show help
        command.help();
      }
    });

  return command;
}
