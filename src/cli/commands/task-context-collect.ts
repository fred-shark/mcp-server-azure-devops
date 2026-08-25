import { Command } from 'commander';
import { WebApi } from 'azure-devops-node-api';
import { getConfig } from '../../index';
import {
  collectTaskContext,
  defaultOutputDir,
  TaskContextCollectCliOptions,
} from '../../workflows/task-context-export';

export function createTaskContextCollectCommand(
  getConnection: () => Promise<WebApi>,
): Command {
  const command = new Command('task-context-collect');
  command
    .description('Collect an AI evidence pack for a completed work item')
    .requiredOption('--work-item-id <number>', 'Root work item ID', parseNumber)
    .option('--project <name>', 'Azure DevOps project name or ID')
    .option('--out <path>', 'Output directory')
    .option(
      '--activity-filter <activity>',
      'Only fully collect child tasks with this Activity',
    )
    .option('--include-wiki', 'Collect wiki pages')
    .option('--include-prs', 'Collect pull request metadata')
    .option('--include-commits', 'Collect commit metadata')
    .option('--include-comments', 'Collect work item and pull request comments')
    .option(
      '--include-checks',
      'Collect pull request checks and policy evaluations',
    )
    .option('--include-raw', 'Write raw JSON files', true)
    .action(async (options: TaskContextCollectCliOptions) => {
      const config = getConfig();
      const project = options.project ?? config.defaultProject;
      if (!project || project === 'no default project') {
        throw new Error(
          'Project is not specified. Pass --project or configure default project in environment/config.',
        );
      }

      const connection = await getConnection();
      const outputDir = options.out ?? defaultOutputDir(options.workItemId);
      const hasArtifactIncludeFlags =
        options.includeWiki ||
        options.includePrs ||
        options.includeCommits ||
        options.includeComments ||
        options.includeChecks;

      const manifest = await collectTaskContext({
        connection,
        project,
        workItemId: options.workItemId,
        outputDir,
        organizationId: undefined,
        activityFilter: options.activityFilter,
        includeWiki: options.includeWiki ?? !hasArtifactIncludeFlags,
        includePrs: options.includePrs ?? !hasArtifactIncludeFlags,
        includeCommits: options.includeCommits ?? !hasArtifactIncludeFlags,
        includeComments: options.includeComments ?? false,
        includeChecks: options.includeChecks ?? false,
        includeRaw: options.includeRaw ?? true,
      });

      console.log(
        JSON.stringify(
          {
            outputDir: manifest.outputDir,
            manifestFile: 'manifest.json',
            rootWorkItemId: manifest.rootWorkItemId,
            warnings: manifest.warnings.length,
            errors: manifest.errors.length,
          },
          null,
          2,
        ),
      );
    });

  return command;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}
