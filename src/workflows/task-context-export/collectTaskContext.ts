import path from 'path';
import { WebApi } from 'azure-devops-node-api';
import { WorkItem } from '../../features/work-items';
import { getWorkItem } from '../../features/work-items/get-work-item/feature';
import {
  getPullRequest,
  getPullRequestChanges,
  getPullRequestChecks,
  getPullRequestComments,
} from '../../features/pull-requests';
import { getWikiPage, listWikiPages } from '../../features/wikis';
import {
  buildManifest,
  createWorkItemSummary,
  workItemMarkdownFile,
} from './manifest';
import {
  compactWorkItemType,
  fieldString,
  renderWorkItemMarkdown,
  safeBoundedFileName,
  safeFileName,
} from './markdownRenderers';
import {
  resetOutputDirectory,
  writeCommits,
  writeJsonFile,
  writeLinks,
  writeManifestReadmeAndPrompt,
  writeMarkdownFile,
  writePullRequests,
  writeWiki,
} from './fileWriters';
import {
  extractLinksFromText,
  extractLinksFromWorkItem,
} from './linkExtractors';
import { writeCompactAnalysisPack } from './compactAnalysis';
import {
  ArtifactSource,
  ClassifiedWorkItems,
  CollectionIssue,
  CommitArtifact,
  ExtractedLink,
  Manifest,
  PullRequestArtifact,
  TaskContextCollectOptions,
  WikiArtifact,
  WorkItemSummary,
  WorkItemWithActivity,
} from './types';

const CHILD_RELATION = 'System.LinkTypes.Hierarchy-Forward';
const PARENT_RELATION = 'System.LinkTypes.Hierarchy-Reverse';
const WORK_ITEM_URL_ID_PATTERN = /\/workItems\/(\d+)(?:$|[/?#])/i;

export async function collectTaskContext(
  options: TaskContextCollectOptions,
): Promise<Manifest> {
  const warnings: CollectionIssue[] = [];
  const errors: CollectionIssue[] = [];
  const generatedAt = new Date().toISOString();
  const outputDir = path.resolve(options.outputDir);

  await resetOutputDirectory(outputDir);

  const rootWorkItem = await getWorkItem(
    options.connection,
    options.workItemId,
    'all',
  );
  const rootActivity = activityOf(rootWorkItem);
  const rootFiles = await writeWorkItem(
    outputDir,
    rootWorkItem,
    'work-items/root',
    options.includeRaw,
  );
  const rootSummary = createWorkItemSummary(
    rootWorkItem,
    rootFiles.markdownFile,
    rootFiles.rawFile,
    { activity: rootActivity, fullCollection: true },
  );

  const rootClassification = classifyWorkItemRelations(rootWorkItem);
  const fullChildIds = new Set(rootClassification.directChildIds);
  const childItems = await fetchWorkItems(
    options.connection,
    [...fullChildIds],
    warnings,
    'child-work-item',
  );

  const fullChildren: WorkItemWithActivity[] = [];
  const contextReferenceRequests = [...rootClassification.contextReferenceIds];
  const activitySummaries: Record<string, WorkItemSummary[]> = {};
  let allLinks: ExtractedLink[] = [...rootClassification.links];

  if (options.activityFilter) {
    warnings.push({
      message: `Activity filter '${options.activityFilter}' was applied. Full artifact collection is limited to matching child work items.`,
      source: 'activity-filter',
    });
  }

  for (const child of childItems) {
    const activity = activityOf(child);
    const fullCollection =
      !options.activityFilter || activity === options.activityFilter;
    const activityDir = `work-items/activities/${safeFileName(activity)}`;
    const childFiles = await writeWorkItem(
      outputDir,
      child,
      activityDir,
      options.includeRaw,
    );
    const summary = createWorkItemSummary(
      child,
      childFiles.markdownFile,
      childFiles.rawFile,
      { activity, fullCollection },
    );
    activitySummaries[activity] = [
      ...(activitySummaries[activity] ?? []),
      summary,
    ];

    if (fullCollection) {
      fullChildren.push({ workItem: child, activity, fullCollection });
      const childClassification = classifyWorkItemRelations(child);
      allLinks = [...allLinks, ...childClassification.links];
      contextReferenceRequests.push(...childClassification.contextReferenceIds);
    } else if (child.id !== undefined) {
      contextReferenceRequests.push({
        id: child.id,
        relationType: 'ActivityFilterExcludedChild',
        sourceWorkItemId: rootWorkItem.id ?? options.workItemId,
      });
    }
  }

  const scopedWorkItems = [
    { workItem: rootWorkItem, activity: rootActivity, fullCollection: true },
    ...fullChildren,
  ];

  allLinks = [
    ...allLinks,
    ...scopedWorkItems.flatMap(({ workItem }) =>
      extractLinksFromWorkItem(workItem),
    ),
  ];

  const contextReferences = await collectContextReferences(
    options.connection,
    outputDir,
    contextReferenceRequests,
    options.includeRaw,
    warnings,
  );

  const workItemComments = options.includeComments
    ? await collectWorkItemComments(
        options.connection,
        options.project,
        outputDir,
        scopedWorkItems.map(({ workItem }) => workItem),
        options.includeRaw,
        warnings,
      )
    : [];
  allLinks = [
    ...allLinks,
    ...workItemComments.flatMap((entry) =>
      extractLinksFromText(
        JSON.stringify(entry.comments),
        `work-item-comments:${entry.workItemId}`,
        entry.workItemId,
      ),
    ),
  ];

  const pullRequests =
    options.includePrs || noIncludeArtifactFlags(options)
      ? await collectPullRequests(options, scopedWorkItems, allLinks, warnings)
      : [];

  allLinks = [
    ...allLinks,
    ...pullRequests.flatMap((pullRequest) =>
      extractLinksFromText(
        JSON.stringify({
          raw: pullRequest.raw,
          comments: pullRequest.comments,
        }),
        `pull-request:${pullRequest.id}`,
      ),
    ),
  ];

  const commits =
    options.includeCommits || noIncludeArtifactFlags(options)
      ? await collectCommits(
          options.connection,
          options.project,
          scopedWorkItems,
          allLinks,
          pullRequests,
          warnings,
        )
      : [];

  const wikiPages =
    options.includeWiki || noIncludeArtifactFlags(options)
      ? await collectWikiPages(options, scopedWorkItems, allLinks, warnings)
      : [];

  allLinks = dedupeExtractedLinks(allLinks);
  await writeLinks(outputDir, allLinks);
  await writePullRequests(outputDir, pullRequests, options.includeRaw);
  await writeCommits(outputDir, commits, options.includeRaw);
  await writeWiki(outputDir, wikiPages, options.includeRaw);

  const manifest = buildManifest({
    generatedAt,
    collectionUrl: options.connection.serverUrl,
    project: options.project,
    rootWorkItem,
    outputDir,
    activityFilter: options.activityFilter,
    rootSummary,
    activities: activitySummaries,
    contextReferences,
    wikiPages,
    pullRequests,
    commits,
    links: allLinks,
    warnings,
    errors,
  });

  await writeManifestReadmeAndPrompt(outputDir, manifest);
  await writeCompactAnalysisPack(outputDir, manifest);
  return manifest;
}

export function classifyWorkItemRelations(
  workItem: WorkItem,
): ClassifiedWorkItems {
  const directChildIds: number[] = [];
  const contextReferenceIds: ClassifiedWorkItems['contextReferenceIds'] = [];
  const links: ExtractedLink[] = [];
  const sourceWorkItemId = workItem.id ?? 0;

  for (const relation of workItem.relations ?? []) {
    const relationType = relation.rel ?? 'unknown';
    const targetId = parseWorkItemIdFromUrl(relation.url);
    if (relationType === CHILD_RELATION && targetId !== undefined) {
      directChildIds.push(targetId);
      continue;
    }
    if (relationType === PARENT_RELATION) {
      continue;
    }
    if (targetId !== undefined) {
      contextReferenceIds.push({
        id: targetId,
        relationType,
        sourceWorkItemId,
      });
    }
  }

  links.push(...extractLinksFromWorkItem(workItem));

  return {
    directChildIds: [...new Set(directChildIds)],
    contextReferenceIds: dedupeReferenceRequests(contextReferenceIds),
    links,
  };
}

export function activityOf(workItem: WorkItem): string {
  const raw = workItem.fields?.['Microsoft.VSTS.Common.Activity'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'Unknown';
}

export function defaultOutputDir(workItemId: number): string {
  return path.join('.ai-context', 'tasks', String(workItemId));
}

async function writeWorkItem(
  outputDir: string,
  workItem: WorkItem,
  baseDir: string,
  includeRaw: boolean,
): Promise<{ markdownFile: string; rawFile?: string }> {
  const fields = workItem.fields ?? {};
  const type = fieldString(fields, 'System.WorkItemType', 'WorkItem');
  const id = workItem.id ?? Number(fields['System.Id']);
  const markdownFile = `${baseDir}/${workItemMarkdownFile(id, type)}`;
  const rawFile = includeRaw ? `${baseDir}/raw/${id}.json` : undefined;

  await writeMarkdownFile(
    outputDir,
    markdownFile,
    renderWorkItemMarkdown(workItem),
  );
  if (includeRaw && rawFile) {
    await writeJsonFile(outputDir, rawFile, workItem);
  }

  return { markdownFile, rawFile };
}

async function fetchWorkItems(
  connection: WebApi,
  ids: number[],
  warnings: CollectionIssue[],
  source: string,
): Promise<WorkItem[]> {
  const result: WorkItem[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      result.push(await getWorkItem(connection, id, 'all'));
    } catch (error) {
      warnings.push(toIssue(`Failed to fetch work item ${id}`, source, error));
    }
  }
  return result;
}

async function collectContextReferences(
  connection: WebApi,
  outputDir: string,
  requests: ClassifiedWorkItems['contextReferenceIds'],
  includeRaw: boolean,
  warnings: CollectionIssue[],
): Promise<WorkItemSummary[]> {
  const summaries: WorkItemSummary[] = [];
  for (const request of dedupeReferenceRequests(requests)) {
    try {
      const workItem = await getWorkItem(connection, request.id, 'all');
      const type = fieldString(
        workItem.fields ?? {},
        'System.WorkItemType',
        'WorkItem',
      );
      const markdownFile = `work-items/context-references/${workItemMarkdownFile(request.id, type)}`;
      const rawFile = includeRaw
        ? `work-items/context-references/raw/${request.id}.json`
        : undefined;
      await writeMarkdownFile(
        outputDir,
        markdownFile,
        renderWorkItemMarkdown(workItem),
      );
      if (includeRaw && rawFile) {
        await writeJsonFile(outputDir, rawFile, workItem);
      }
      summaries.push(
        createWorkItemSummary(workItem, markdownFile, rawFile, {
          fullCollection: false,
          relationType: request.relationType,
          sourceWorkItemId: request.sourceWorkItemId,
          activity: activityOf(workItem),
        }),
      );
    } catch (error) {
      warnings.push(
        toIssue(
          `Failed to fetch context reference work item ${request.id}`,
          'context-reference',
          error,
        ),
      );
    }
  }
  return summaries;
}

async function collectWorkItemComments(
  connection: WebApi,
  project: string,
  outputDir: string,
  workItems: WorkItem[],
  includeRaw: boolean,
  warnings: CollectionIssue[],
): Promise<Array<{ workItemId: number; comments: unknown }>> {
  const witApi = await connection.getWorkItemTrackingApi();
  const results: Array<{ workItemId: number; comments: unknown }> = [];
  for (const workItem of workItems) {
    if (workItem.id === undefined) {
      continue;
    }
    try {
      const comments = await witApi.getComments(project, workItem.id, 200);
      results.push({ workItemId: workItem.id, comments });
      if (includeRaw) {
        await writeJsonFile(
          outputDir,
          `work-items/comments/raw/${workItem.id}.comments.json`,
          comments,
        );
      }
    } catch (error) {
      warnings.push(
        toIssue(
          `Failed to fetch comments for work item ${workItem.id}`,
          'work-item-comments',
          error,
        ),
      );
    }
  }
  return results;
}

async function collectPullRequests(
  options: TaskContextCollectOptions,
  scopedWorkItems: WorkItemWithActivity[],
  links: ExtractedLink[],
  warnings: CollectionIssue[],
): Promise<PullRequestArtifact[]> {
  const gitApi = await options.connection.getGitApi();
  const byKey = new Map<string, PullRequestArtifact>();
  const candidates = links.filter(
    (link) => link.kind === 'pull-request' && link.pullRequestId !== undefined,
  );

  for (const link of candidates) {
    const source = sourceFromLink(link, scopedWorkItems);
    if (!source) {
      continue;
    }
    const key = `${link.repositoryId ?? link.repositoryName ?? 'unknown'}:${link.pullRequestId}`;
    const existing = byKey.get(key);
    if (existing) {
      addSource(existing.sources, source);
      continue;
    }
    try {
      const raw = link.repositoryId
        ? await gitApi.getPullRequest(
            link.repositoryId,
            link.pullRequestId ?? 0,
            options.project,
          )
        : await getPullRequest(options.connection, {
            projectId: options.project,
            pullRequestId: link.pullRequestId ?? 0,
          });
      const repository = asRecord(raw.repository);
      const repositoryId =
        stringFrom(repository.id) ?? link.repositoryId ?? link.repositoryName;
      const repositoryName = stringFrom(repository.name) ?? link.repositoryName;
      const artifact: PullRequestArtifact = {
        key,
        id: link.pullRequestId ?? 0,
        repositoryId,
        repositoryName,
        raw,
        sources: [source],
      };

      if (options.includeComments && repositoryId) {
        artifact.comments = await tryOptional(
          () =>
            getPullRequestComments(
              options.connection,
              options.project,
              repositoryId,
              artifact.id,
              {
                projectId: options.project,
                repositoryId,
                pullRequestId: artifact.id,
              },
            ),
          warnings,
          `Failed to fetch comments for PR ${artifact.id}`,
          'pull-request-comments',
        );
      }

      if (repositoryId) {
        artifact.changes = await tryOptional(
          () =>
            getPullRequestChanges(options.connection, {
              projectId: options.project,
              repositoryId,
              pullRequestId: artifact.id,
            }),
          warnings,
          `Failed to fetch changes for PR ${artifact.id}`,
          'pull-request-changes',
        );
      }

      if (options.includeChecks && repositoryId) {
        artifact.checks = await tryOptional(
          () =>
            getPullRequestChecks(options.connection, {
              projectId: options.project,
              repositoryId,
              pullRequestId: artifact.id,
            }),
          warnings,
          `Failed to fetch checks for PR ${artifact.id}`,
          'pull-request-checks',
        );
      }

      byKey.set(key, artifact);
    } catch (error) {
      warnings.push(
        toIssue(
          `Failed to fetch pull request ${link.pullRequestId}`,
          'pull-request',
          error,
        ),
      );
    }
  }

  return [...byKey.values()];
}

async function collectCommits(
  connection: WebApi,
  project: string,
  scopedWorkItems: WorkItemWithActivity[],
  links: ExtractedLink[],
  _pullRequests: PullRequestArtifact[],
  warnings: CollectionIssue[],
): Promise<CommitArtifact[]> {
  const gitApi = await connection.getGitApi();
  const byKey = new Map<string, CommitArtifact>();

  for (const link of links.filter(
    (item) => item.kind === 'commit' && item.commitId,
  )) {
    const source = sourceFromLink(link, scopedWorkItems);
    if (!source) {
      continue;
    }
    const repositoryId = link.repositoryId ?? link.repositoryName;
    if (!repositoryId || !link.commitId) {
      warnings.push({
        message: `Skipping commit link without repository id: ${link.url}`,
        source: 'commit',
      });
      continue;
    }
    await addCommitArtifact(
      gitApi,
      project,
      byKey,
      repositoryId,
      link.repositoryName,
      link.commitId,
      source,
      warnings,
    );
  }

  return [...byKey.values()];
}

async function addCommitArtifact(
  gitApi: Awaited<ReturnType<WebApi['getGitApi']>>,
  project: string,
  byKey: Map<string, CommitArtifact>,
  repositoryId: string,
  repositoryName: string | undefined,
  commitId: string,
  source: ArtifactSource,
  warnings: CollectionIssue[],
  rawHint?: unknown,
): Promise<void> {
  const key = `${repositoryId}:${commitId}`;
  const existing = byKey.get(key);
  if (existing) {
    addSource(existing.sources, source);
    return;
  }

  try {
    const raw =
      rawHint ?? (await gitApi.getCommit(commitId, repositoryId, project));
    byKey.set(key, {
      key,
      hash: commitId,
      repositoryId,
      repositoryName,
      raw,
      sources: [source],
    });
  } catch (error) {
    warnings.push(
      toIssue(`Failed to fetch commit ${commitId}`, 'commit', error),
    );
  }
}

async function collectWikiPages(
  options: TaskContextCollectOptions,
  scopedWorkItems: WorkItemWithActivity[],
  links: ExtractedLink[],
  warnings: CollectionIssue[],
): Promise<WikiArtifact[]> {
  const byKey = new Map<string, WikiArtifact>();

  for (const link of links.filter((item) => item.kind === 'wiki')) {
    const source = sourceFromLink(link, scopedWorkItems) ?? {
      sourceWorkItemId: link.sourceWorkItemId ?? options.workItemId,
      sourceWorkItemActivity: 'Unknown',
      sourceRelationType: link.relationType,
    };
    const wikiId = link.wikiId;
    if (!wikiId) {
      warnings.push({
        message: `Skipping wiki link without wiki id: ${link.url}`,
        source: 'wiki',
      });
      continue;
    }
    const pagePath = await resolveWikiPagePath(options, link, warnings);
    if (!pagePath) {
      continue;
    }
    await addWikiArtifact(
      options,
      byKey,
      wikiId,
      pagePath,
      'explicit-link',
      source,
      link,
      warnings,
    );
  }

  return [...byKey.values()];
}

async function addWikiArtifact(
  options: TaskContextCollectOptions,
  byKey: Map<string, WikiArtifact>,
  wikiId: string,
  pagePath: string,
  source: 'explicit-link' | 'search',
  artifactSource: ArtifactSource,
  link: ExtractedLink | undefined,
  warnings: CollectionIssue[],
): Promise<void> {
  const key = safeBoundedFileName(`${wikiId}-${pagePath}`);
  const existing = byKey.get(key);
  if (existing) {
    addSource(existing.sources, artifactSource);
    return;
  }
  try {
    const content = await getWikiPage({
      organizationId: link?.wikiOrganizationId ?? options.organizationId ?? '',
      projectId: link?.wikiProjectId ?? options.project,
      wikiId,
      pagePath,
    });
    byKey.set(key, {
      key,
      title: pagePath.split('/').filter(Boolean).at(-1) ?? wikiId,
      path: pagePath,
      wikiId,
      content,
      source,
      sources: [artifactSource],
    });
  } catch (error) {
    warnings.push(
      toIssue(
        `Failed to fetch wiki page ${wikiId}:${pagePath}`,
        'wiki-page',
        error,
      ),
    );
  }
}

async function resolveWikiPagePath(
  options: TaskContextCollectOptions,
  link: ExtractedLink,
  warnings: CollectionIssue[],
): Promise<string | undefined> {
  if (link.wikiPageId === undefined) {
    return link.wikiPath ?? '/';
  }

  if (!link.wikiId) {
    return undefined;
  }

  const organizationId = link.wikiOrganizationId ?? options.organizationId;
  const projectId = link.wikiProjectId ?? options.project;

  try {
    const pages = await listWikiPages({
      organizationId,
      projectId,
      wikiId: link.wikiId,
    });
    const page = pages.find((candidate) => candidate.id === link.wikiPageId);
    if (!page?.path) {
      warnings.push({
        message: `Failed to resolve wiki page id ${link.wikiPageId} to pagePath for wiki ${link.wikiId}`,
        source: 'wiki-page',
      });
      return undefined;
    }
    return page.path;
  } catch (error) {
    warnings.push(
      toIssue(
        `Failed to list wiki pages for wiki ${link.wikiId} while resolving page id ${link.wikiPageId}`,
        'wiki-page',
        error,
      ),
    );
    return undefined;
  }
}

function sourceFromLink(
  link: ExtractedLink,
  scopedWorkItems: WorkItemWithActivity[],
): ArtifactSource | undefined {
  if (link.sourceWorkItemId === undefined) {
    return undefined;
  }
  const sourceItem = scopedWorkItems.find(
    ({ workItem }) => workItem.id === link.sourceWorkItemId,
  );
  if (!sourceItem) {
    return undefined;
  }
  return {
    sourceWorkItemId: link.sourceWorkItemId,
    sourceWorkItemActivity: sourceItem.activity,
    sourceRelationType: link.relationType,
  };
}

function noIncludeArtifactFlags(options: TaskContextCollectOptions): boolean {
  return (
    !options.includeWiki &&
    !options.includePrs &&
    !options.includeCommits &&
    !options.includeComments &&
    !options.includeChecks
  );
}

function parseWorkItemIdFromUrl(url?: string): number | undefined {
  if (!url) {
    return undefined;
  }
  const match = url.match(WORK_ITEM_URL_ID_PATTERN);
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : undefined;
}

function dedupeReferenceRequests(
  requests: ClassifiedWorkItems['contextReferenceIds'],
): ClassifiedWorkItems['contextReferenceIds'] {
  const seen = new Set<string>();
  const result: ClassifiedWorkItems['contextReferenceIds'] = [];
  for (const request of requests) {
    const key = `${request.id}:${request.relationType}:${request.sourceWorkItemId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(request);
    }
  }
  return result;
}

function dedupeExtractedLinks(links: ExtractedLink[]): ExtractedLink[] {
  const seen = new Set<string>();
  const result: ExtractedLink[] = [];
  for (const link of links) {
    const key = JSON.stringify({
      kind: link.kind,
      url: link.url,
      sourceWorkItemId: link.sourceWorkItemId,
      relationType: link.relationType,
    });
    if (!seen.has(key)) {
      seen.add(key);
      result.push(link);
    }
  }
  return result;
}

function addSource(sources: ArtifactSource[], source: ArtifactSource): void {
  if (
    !sources.some(
      (existing) =>
        existing.sourceWorkItemId === source.sourceWorkItemId &&
        existing.sourceWorkItemActivity === source.sourceWorkItemActivity,
    )
  ) {
    sources.push(source);
  }
}

async function tryOptional<T>(
  action: () => Promise<T>,
  warnings: CollectionIssue[],
  message: string,
  source: string,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    warnings.push(toIssue(message, source, error));
    return undefined;
  }
}

function toIssue(
  message: string,
  source: string,
  error: unknown,
): CollectionIssue {
  return {
    message,
    source,
    error: error instanceof Error ? error.message : String(error),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringFrom(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

export function workItemFileNameForTest(workItem: WorkItem): string {
  const type = fieldString(
    workItem.fields ?? {},
    'System.WorkItemType',
    'WorkItem',
  );
  return `${workItem.id}.${compactWorkItemType(type)}.md`;
}
