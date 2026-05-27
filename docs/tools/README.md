# Azure DevOps MCP Server Tools Documentation

This directory contains documentation for all tools available in the Azure DevOps MCP server. Each tool is documented with examples, parameters, response formats, and error handling information.

## Navigation

- [Core Navigation Tools](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/core-navigation.md) - Overview of tools for navigating Azure DevOps resources
  - [Organizations](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/organizations.md) - Tools for working with organizations
  - [Projects](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/projects.md) - Tools for working with projects
  - [Repositories](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/repositories.md) - Tools for working with Git repositories
  - [Pull Requests](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md) - Tools for working with pull requests
  - [Work Items](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/work-items.md) - Tools for working with work items
  - [Pipelines](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md) - Tools for working with pipelines
- [Resource URIs](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/resources.md) - Documentation for accessing repository content via resource URIs

## Tools by Category

## CLI Workflow Commands

### task-context-collect

`task-context-collect` is a CLI-only workflow command for collecting an evidence pack for a completed root work item. It is intentionally not exposed as a single MCP tool and does not generate an AI `summary.md`.

Minimal example:

```bash
azdevops-cli task-context-collect --work-item-id 12345
```

Full example:

```bash
azdevops-cli task-context-collect \
  --project "MyProject" \
  --work-item-id 12345 \
  --out ".ai-context/tasks/12345" \
  --include-wiki \
  --include-prs \
  --include-commits \
  --include-comments \
  --include-checks \
  --include-raw
```

Default output is `.ai-context/tasks/<workItemId>`. The command writes `manifest.json`, `README.md`, `work-items/`, `links/`, `pull-requests/`, `commits/`, `wiki/`, and `prompts/summarize-task.prompt.md`. Wiki pages are downloaded only from explicit links found in scope work items and collected PR/comment text; the command does not run text search across wiki content.

The command also creates a deterministic compact analysis pack under `output/analysis/`:

- `00-inventory.md` / `00-inventory.json`
- `01-work-items-compact.md` / `01-work-items-compact.json`
- `02-wiki-index.md` / `02-wiki-index.json`
- `03-pr-index.md` / `03-pr-index.json`
- `04-commits-compact.md` / `04-commits-compact.json`
- `05-analysis-input.md`

For Qwen or another LLM with limited context, start with `output/analysis/05-analysis-input.md` and then read the other compact files only when needed. Do not load `manifest.json`, `links/extracted-links.md`, raw JSON, full PR `changes.md` / `comments.md`, large wiki pages, or `commits/commits.md` into model context.

Repeated collector runs overwrite only generated analysis files in `output/analysis/`. Existing `output/summary.md`, `output/summary-review.md`, and user notes under `output/` are preserved.

The root work item and direct children are scope work items. Non-parent-child related work items are saved as context references only; the collector does not recursively traverse them and does not collect PRs, commits, or checks for them.

Direct children are grouped by the dynamic `Activity` field, with missing values grouped under `Unknown`. `--activity-filter` limits full child artifact collection to the selected Activity and records that filter in the manifest warnings.

Azure DevOps Server on-premises is supported through the existing configuration and PAT auth path. APIs that are unavailable on a server version degrade to manifest warnings instead of failing the whole collection.

### Organization Tools

- [`list_organizations`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/organizations.md#list_organizations) - List all Azure DevOps organizations accessible to the user

### Project Tools

- [`list_projects`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/projects.md#list_projects) - List all projects in the organization
- [`get_project`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/projects.md#get_project) - Get details of a specific project

### Repository Tools

- [`list_repositories`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/repositories.md#list_repositories) - List all repositories in a project
- [`get_repository`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/repositories.md#get_repository) - Get details of a specific repository
- [`get_repository_details`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/repositories.md#get_repository_details) - Get detailed information about a repository
- [`get_file_content`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/repositories.md#get_file_content) - Get content of a file or directory from a repository

### Pull Request Tools

- [`create_pull_request`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md#create_pull_request) - Create a new pull request
- [`get_pull_request`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md#get_pull_request) - Get a pull request by ID
- [`list_pull_requests`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md#list_pull_requests) - List pull requests in a repository
- [`add_pull_request_comment`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md#add_pull_request_comment) - Add a comment to a pull request
- [`get_pull_request_comments`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md#get_pull_request_comments) - Get comments from a pull request
- [`update_pull_request`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pull-requests.md#update_pull_request) - Update an existing pull request (title, description, status, draft state, reviewers, work items)

### Work Item Tools

- [`get_work_item`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/work-items.md#get_work_item) - Retrieve a work item by ID
- [`create_work_item`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/work-items.md#create_work_item) - Create a new work item
- [`list_work_items`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/work-items.md#list_work_items) - List work items in a project

### Pipeline Tools

- [`list_pipelines`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#list_pipelines) - List all pipelines in a project
- [`get_pipeline`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#get_pipeline) - Get details of a specific pipeline
- [`list_pipeline_runs`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#list_pipeline_runs) - List recent runs for a pipeline with filters
- [`get_pipeline_run`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#get_pipeline_run) - Get detailed information about a specific run
- [`download_pipeline_artifact`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#download_pipeline_artifact) - Download a file from pipeline artifacts as text
- [`pipeline_timeline`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#pipeline_timeline) - Retrieve the stage/job timeline for a run
- [`get_pipeline_log`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#get_pipeline_log) - Retrieve log contents in plain or JSON formats
- [`trigger_pipeline`](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/pipelines.md#trigger_pipeline) - Trigger a pipeline run with customizable parameters

## Tool Structure

Each tool documentation follows a consistent structure:

1. **Description**: Brief explanation of what the tool does
2. **Parameters**: Required and optional parameters with explanations
3. **Response**: Expected response format with examples
4. **Error Handling**: Potential errors and how they're handled
5. **Example Usage**: Code examples showing how to use the tool
6. **Implementation Details**: Technical details about how the tool works

## Examples

Examples of using multiple tools together can be found in the [Core Navigation Tools](https://github.com/tiberriver256/mcp-server-azure-devops/blob/main/docs/tools/core-navigation.md#common-use-cases) documentation.
