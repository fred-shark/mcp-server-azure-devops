import { Command, Option } from 'commander';
import { WebApi } from 'azure-devops-node-api';
import { CliToolDefinition } from '../shared/cli-utils/tool-loader';
import { schemaToCliOptions } from './zod-parser';

/**
 * Create a Commander command from a CLI tool definition
 */
export function createCommand(tool: CliToolDefinition): Command {
  // Convert tool name from snake_case to kebab-case for CLI
  const commandName = tool.name.replace(/_/g, '-');
  const command = new Command(commandName);
  command.description(tool.description);

  // Parse schema to get CLI options
  const options = schemaToCliOptions(tool.inputSchema);

  // Add each option to the command
  for (const option of options) {
    const flag = option.flag;
    const description = option.description || '';
    const defaultValue = option.defaultValue;

    // Determine the argument parser based on type
    let argParser: ((value: string) => any) | undefined;

    switch (option.type) {
      case 'number':
        argParser = parseFloat;
        break;
      case 'boolean':
        // Boolean flags don't need a parser
        break;
      case 'array':
        // Commander handles variadic arguments
        break;
      case 'enum':
        // Add choices validation
        if (option.choices) {
          command.addOption(
            new Option(flag, description)
              .choices(option.choices)
              .default(defaultValue),
          );
          continue;
        }
        break;
    }

    // Create the option
    if (option.type === 'boolean') {
      // Boolean flag (no value)
      command.option(flag, description, defaultValue);
    } else {
      // Option with value
      if (argParser) {
        command.option(flag, description, argParser, defaultValue);
      } else {
        command.option(flag, description, defaultValue);
      }
    }
  }

  // Add help option
  command.helpOption('-h, --help', 'Show help for this command');

  return command;
}

/**
 * Execute a tool with the given connection and parsed arguments
 */
export async function executeTool(
  tool: CliToolDefinition,
  connection: WebApi,
  args: Record<string, any>,
): Promise<any> {
  // Filter out undefined arguments (Commander sets undefined for missing options)
  const filteredArgs: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) {
      filteredArgs[key] = value;
    }
  }

  // Call the tool handler
  return await tool.handler(connection, filteredArgs);
}
