import { JsonSchema7Type } from 'zod-to-json-schema';
import { WebApi } from 'azure-devops-node-api';
import { ToolDefinition } from '../../shared/types/tool-definition';

/**
 * CLI tool definition with handler function
 */
export interface CliToolDefinition {
  name: string; // Tool name (e.g., "get_me")
  description: string; // Description from tool definition
  inputSchema: JsonSchema7Type; // JSON Schema from Zod
  handler: (connection: WebApi, args: any) => Promise<any>;
}

// Import tool definitions from features
import { usersTools } from '../../features/users/tool-definitions';
import { organizationsTools } from '../../features/organizations/tool-definitions';
import { projectsTools } from '../../features/projects/tool-definitions';
import { repositoriesTools } from '../../features/repositories/tool-definitions';
import { workItemsTools } from '../../features/work-items/tool-definitions';
import { searchTools } from '../../features/search/tool-definitions';
import { pullRequestsTools } from '../../features/pull-requests/tool-definitions';
import { pipelinesTools } from '../../features/pipelines/tool-definitions';
import { wikisTools } from '../../features/wikis/tool-definitions';

// Import handler functions from features
import { getMe } from '../../features/users/get-me/feature';
import { listOrganizations } from '../../features/organizations/list-organizations/feature';
import { getConfig } from '../../index';
import {
  listProjects,
  getProject,
  getProjectDetails,
} from '../../features/projects';
import {
  listRepositories,
  getRepository,
  getRepositoryDetails,
  getFileContent,
  getRepositoryTree,
  getAllRepositoriesTree,
  listCommits,
  createBranch,
  createCommit,
} from '../../features/repositories';
import {
  getWorkItem,
  createWorkItem,
  updateWorkItem,
  listWorkItems,
  manageWorkItemLink,
} from '../../features/work-items';
import { searchCode, searchWiki, searchWorkItems } from '../../features/search';
import {
  createPullRequest,
  getPullRequest,
  listPullRequests,
  addPullRequestComment,
  getPullRequestComments,
  updatePullRequest,
  getPullRequestChanges,
  getPullRequestChecks,
} from '../../features/pull-requests';
import {
  listPipelines,
  getPipeline,
  listPipelineRuns,
  getPipelineRun,
  downloadPipelineArtifact,
  getPipelineTimeline,
  getPipelineLog,
  triggerPipeline,
} from '../../features/pipelines';
import {
  getWikis,
  getWikiPage,
  listWikiPages,
  createWiki,
  updateWikiPage,
  createWikiPage,
} from '../../features/wikis';

/**
 * Wrapper for listOrganizations that uses config from environment
 */
async function listOrganizationsWrapper(
  _connection: WebApi,
  _args: any,
): Promise<any> {
  const config = getConfig();
  return await listOrganizations(config);
}

// Wrappers for functions with different signatures
async function getRepositoryWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await getRepository(connection, args.projectId, args.repositoryId);
}

async function getFileContentWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await getFileContent(
    connection,
    args.projectId,
    args.repositoryId,
    args.path,
    args.versionDescriptor,
  );
}

async function createWorkItemWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await createWorkItem(
    connection,
    args.projectId,
    args.workItemType,
    args,
  );
}

async function updateWorkItemWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await updateWorkItem(connection, args.workItemId, args);
}

async function manageWorkItemLinkWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await manageWorkItemLink(connection, args.projectId, args);
}

async function createPullRequestWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await createPullRequest(
    connection,
    args.projectId,
    args.repositoryId,
    args,
  );
}

async function listPullRequestsWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await listPullRequests(
    connection,
    args.projectId,
    args.repositoryId,
    args,
  );
}

async function addPullRequestCommentWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await addPullRequestComment(
    connection,
    args.projectId,
    args.repositoryId,
    args.pullRequestId,
    args,
  );
}

async function getPullRequestCommentsWrapper(
  connection: WebApi,
  args: any,
): Promise<any> {
  return await getPullRequestComments(
    connection,
    args.projectId,
    args.repositoryId,
    args.pullRequestId,
    args,
  );
}

async function updatePullRequestWrapper(
  _connection: WebApi,
  args: any,
): Promise<any> {
  return await updatePullRequest(args);
}

async function getWikiPageWrapper(
  _connection: WebApi,
  args: any,
): Promise<any> {
  return await getWikiPage(args);
}

async function listWikiPagesWrapper(
  _connection: WebApi,
  args: any,
): Promise<any> {
  return await listWikiPages(args);
}

async function createWikiWrapper(_connection: WebApi, args: any): Promise<any> {
  return await createWiki(_connection, args);
}

async function updateWikiPageWrapper(
  _connection: WebApi,
  args: any,
): Promise<any> {
  return await updateWikiPage(args);
}

async function createWikiPageWrapper(
  _connection: WebApi,
  args: any,
): Promise<any> {
  return await createWikiPage(args);
}

/**
 * Map tool names to handler functions
 */
const toolHandlers: Record<
  string,
  (connection: WebApi, args: any) => Promise<any>
> = {
  // Users
  get_me: getMe,

  // Organizations
  list_organizations: listOrganizationsWrapper,

  // Projects
  list_projects: listProjects,
  get_project: getProject,
  get_project_details: getProjectDetails,

  // Repositories
  list_repositories: listRepositories,
  get_repository: getRepositoryWrapper,
  get_repository_details: getRepositoryDetails,
  get_file_content: getFileContentWrapper,
  get_repository_tree: getRepositoryTree,
  get_all_repositories_tree: getAllRepositoriesTree,
  list_commits: listCommits,
  create_branch: createBranch,
  create_commit: createCommit,

  // Work Items
  get_work_item: getWorkItem,
  create_work_item: createWorkItemWrapper,
  update_work_item: updateWorkItemWrapper,
  list_work_items: listWorkItems,
  manage_work_item_link: manageWorkItemLinkWrapper,

  // Search
  search_code: searchCode,
  search_wiki: searchWiki,
  search_work_items: searchWorkItems,

  // Pull Requests
  create_pull_request: createPullRequestWrapper,
  get_pull_request: getPullRequest,
  list_pull_requests: listPullRequestsWrapper,
  add_pull_request_comment: addPullRequestCommentWrapper,
  get_pull_request_comments: getPullRequestCommentsWrapper,
  update_pull_request: updatePullRequestWrapper,
  get_pull_request_changes: getPullRequestChanges,
  get_pull_request_checks: getPullRequestChecks,

  // Pipelines
  list_pipelines: listPipelines,
  get_pipeline: getPipeline,
  list_pipeline_runs: listPipelineRuns,
  get_pipeline_run: getPipelineRun,
  download_pipeline_artifact: downloadPipelineArtifact,
  pipeline_timeline: getPipelineTimeline,
  get_pipeline_log: getPipelineLog,
  trigger_pipeline: triggerPipeline,

  // Wikis
  get_wikis: getWikis,
  get_wiki_page: getWikiPageWrapper,
  list_wiki_pages: listWikiPagesWrapper,
  create_wiki: createWikiWrapper,
  update_wiki_page: updateWikiPageWrapper,
  create_wiki_page: createWikiPageWrapper,
};

/**
 * Combine all tool definitions from all features
 */
function getAllToolDefinitions(): ToolDefinition[] {
  return [
    ...usersTools,
    ...organizationsTools,
    ...projectsTools,
    ...repositoriesTools,
    ...workItemsTools,
    ...searchTools,
    ...pullRequestsTools,
    ...pipelinesTools,
    ...wikisTools,
  ];
}

/**
 * Load all CLI tool definitions with their handlers
 */
export function loadAllTools(): CliToolDefinition[] {
  const allToolDefs = getAllToolDefinitions();
  const cliTools: CliToolDefinition[] = [];

  for (const toolDef of allToolDefs) {
    const handler = toolHandlers[toolDef.name];
    if (!handler) {
      console.warn(`No handler found for tool: ${toolDef.name}`);
      continue;
    }

    cliTools.push({
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      handler,
    });
  }

  return cliTools;
}
