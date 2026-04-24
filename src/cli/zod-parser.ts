import { JsonSchema7Type } from 'zod-to-json-schema';

export interface CliOption {
  flag: string; // e.g., '--project-id <value>'
  description?: string; // Description from schema
  defaultValue?: any; // Default value if specified
  required: boolean; // Whether the option is required
  type: 'string' | 'number' | 'boolean' | 'array' | 'enum';
  choices?: string[]; // For enum types
}

/**
 * Convert a property name from camelCase or snake_case to kebab-case
 * for CLI flag naming
 */
function propertyNameToFlag(propertyName: string): string {
  // Convert snake_case to kebab-case
  return propertyName.replace(/_/g, '-');
}

/**
 * Convert JSON Schema property to CLI option(s)
 */
export function schemaPropertyToCliOption(
  propertyName: string,
  schema: JsonSchema7Type,
  requiredProperties: string[] = [],
): CliOption[] {
  const flagBase = `--${propertyNameToFlag(propertyName)}`;
  const isRequired = requiredProperties.includes(propertyName);

  // Handle different schema types
  const type = (schema as any).type;

  if (type === 'string') {
    const enumValues = (schema as any).enum as string[] | undefined;
    if (enumValues && enumValues.length > 0) {
      // Enum type - create choice option
      return [
        {
          flag: `${flagBase} <value>`,
          description: schema.description || `One of: ${enumValues.join(', ')}`,
          defaultValue: schema.default,
          required: isRequired,
          type: 'enum',
          choices: enumValues,
        },
      ];
    }

    // Regular string
    return [
      {
        flag: `${flagBase} <value>`,
        description: schema.description,
        defaultValue: schema.default,
        required: isRequired,
        type: 'string',
      },
    ];
  }

  if (type === 'number' || type === 'integer') {
    return [
      {
        flag: `${flagBase} <number>`,
        description: schema.description,
        defaultValue: schema.default,
        required: isRequired,
        type: 'number',
      },
    ];
  }

  if (type === 'boolean') {
    return [
      {
        flag: flagBase,
        description: schema.description,
        defaultValue: schema.default || false,
        required: isRequired,
        type: 'boolean',
      },
    ];
  }

  if (type === 'array') {
    // For arrays, we support multiple values or comma-separated
    // Using spread syntax for multiple values
    return [
      {
        flag: `${flagBase} <items...>`,
        description: schema.description,
        defaultValue: schema.default,
        required: isRequired,
        type: 'array',
      },
    ];
  }

  // Handle union types? For now, treat as string
  if (Array.isArray(type)) {
    // Union type - treat as string for simplicity
    console.warn(
      `Union type detected for property ${propertyName}, treating as string`,
    );
    return [
      {
        flag: `${flagBase} <value>`,
        description: schema.description,
        defaultValue: schema.default,
        required: isRequired,
        type: 'string',
      },
    ];
  }

  // Handle objects? Not supported in CLI directly
  if (type === 'object') {
    console.warn(
      `Object type detected for property ${propertyName}, not supported in CLI`,
    );
    return [];
  }

  // Fallback to string
  console.warn(
    `Unknown type ${type} for property ${propertyName}, treating as string`,
  );
  return [
    {
      flag: `${flagBase} <value>`,
      description: schema.description,
      defaultValue: schema.default,
      required: isRequired,
      type: 'string',
    },
  ];
}

/**
 * Convert entire JSON Schema to CLI options
 */
export function schemaToCliOptions(schema: JsonSchema7Type): CliOption[] {
  const options: CliOption[] = [];

  if ((schema as any).type !== 'object' || !(schema as any).properties) {
    // Not an object schema, no options to generate
    return options;
  }

  const requiredProperties = (schema as any).required || [];
  const properties = (schema as any).properties as Record<
    string,
    JsonSchema7Type
  >;

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const propertyOptions = schemaPropertyToCliOption(
      propertyName,
      propertySchema,
      requiredProperties,
    );
    options.push(...propertyOptions);
  }

  return options;
}
