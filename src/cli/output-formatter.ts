export type OutputFormat = 'json' | 'pretty';

/**
 * Format output based on the specified format
 */
export function formatOutput(
  data: any,
  format: OutputFormat = 'json',
  quiet: boolean = false,
): string {
  if (quiet) {
    // Just the data, no extra formatting
    return JSON.stringify(data);
  }

  switch (format) {
    case 'pretty':
      return JSON.stringify(data, null, 2);
    case 'json':
    default:
      return JSON.stringify(data);
  }
}

/**
 * Print formatted output to stdout
 */
export function printOutput(
  data: any,
  format: OutputFormat = 'json',
  quiet: boolean = false,
): void {
  const output = formatOutput(data, format, quiet);
  console.log(output);
}

/**
 * Print error output to stderr
 */
export function printError(error: any, format: OutputFormat = 'json'): void {
  const errorObj =
    error instanceof Error
      ? {
          error: error.name,
          message: error.message,
          stack: error.stack,
        }
      : {
          error: 'Unknown error',
          message: String(error),
        };

  const output =
    format === 'pretty'
      ? JSON.stringify(errorObj, null, 2)
      : JSON.stringify(errorObj);

  console.error(output);
}
