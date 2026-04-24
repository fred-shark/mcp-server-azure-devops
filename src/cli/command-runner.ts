import { WebApi } from 'azure-devops-node-api';
import { getConnection, validateConfig } from '../server';
import { getConfig } from '../index';
import { AzureDevOpsConfig } from '../shared/types';
import {
  AzureDevOpsAuthenticationError,
  AzureDevOpsValidationError,
} from '../shared/errors';

/**
 * Get Azure DevOps connection using environment configuration
 */
export async function getAzureDevOpsConnection(): Promise<WebApi> {
  try {
    const config = getConfig();
    validateConfig(config);
    return await getConnection(config);
  } catch (error) {
    if (error instanceof AzureDevOpsAuthenticationError) {
      console.error('Authentication failed:');
      console.error(error.message);
      console.error('\nPlease check your authentication configuration:');
      console.error('1. Ensure AZURE_DEVOPS_ORG_URL is set correctly');
      console.error(
        '2. Verify your credentials (PAT, Azure Identity, or Azure CLI)',
      );
      console.error('3. Check network connectivity');
    } else if (error instanceof AzureDevOpsValidationError) {
      console.error('Configuration error:');
      console.error(error.message);
    } else {
      console.error('Failed to connect to Azure DevOps:');
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

/**
 * Create configuration from environment with optional overrides
 */
export function createConfig(
  overrides?: Partial<AzureDevOpsConfig>,
): AzureDevOpsConfig {
  const baseConfig = getConfig();
  return {
    ...baseConfig,
    ...overrides,
  };
}

/**
 * Test connection to Azure DevOps
 */
export async function testConnection(connection: WebApi): Promise<boolean> {
  try {
    const coreApi = await connection.getCoreApi();
    await coreApi.getProjects();
    return true;
  } catch (error) {
    console.warn(
      'Connection test failed:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
