#!/usr/bin/env node
/**
 * Azure DevOps CLI - Command line interface for Azure DevOps MCP tools
 */

import { Command } from 'commander';
import { loadAllTools } from '../shared/cli-utils/tool-loader';
import { createCommand, executeTool } from './commander';
import { getAzureDevOpsConnection } from './command-runner';
import { printOutput, printError, OutputFormat } from './output-formatter';
import { createTaskContextCollectCommand } from './commands/task-context-collect';
import packageJson from '../../package.json';

async function main() {
  const program = new Command();

  // Basic program info
  program
    .name('azdevops-cli')
    .description('Azure DevOps CLI - Command line interface using MCP tools')
    .version(packageJson.version)
    .option('--output <format>', 'Output format (json, pretty)', 'json')
    .option('--quiet', 'Suppress additional output, only output data', false);

  // Load all tools and create commands
  const tools = loadAllTools();

  // Create a command for each tool
  for (const tool of tools) {
    const command = createCommand(tool);

    // Add action to execute the tool
    command.action(async (options, command) => {
      try {
        // Get global options from parent
        const globalOptions = command.parent?.opts() || {};
        const outputFormat = globalOptions.output as OutputFormat;
        const quiet = globalOptions.quiet as boolean;

        // Get Azure DevOps connection
        const connection = await getAzureDevOpsConnection();

        // Execute the tool
        const result = await executeTool(tool, connection, options);

        // Output the result
        printOutput(result, outputFormat, quiet);
      } catch (error) {
        printError(error);
        process.exit(1);
      }
    });

    // Add command to program
    program.addCommand(command);
  }

  program.addCommand(
    createTaskContextCollectCommand(() => getAzureDevOpsConnection()),
  );

  // Add a default help command
  program.addHelpCommand('help [command]', 'Show help for a command');

  // Handle unknown commands
  program.on('command:*', (operands) => {
    console.error(`Error: unknown command '${operands[0]}'`);
    console.error('See --help for a list of available commands');
    process.exit(1);
  });

  // Parse arguments
  await program.parseAsync(process.argv);

  // If no arguments provided, show help
  if (process.argv.length === 2) {
    program.help();
  }
}

// Run the CLI
main().catch((error) => {
  printError(error);
  process.exit(1);
});
