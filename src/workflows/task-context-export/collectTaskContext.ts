import path from 'path';
import { WebApi } from 'azure-devops-node-api';
import { PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import {
  Comment,
  CommentSortOrder,
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { WorkItem } from '../../features/work-items';
import { getWorkItem } from '../../features/work-items/get-work-item/feature';
import {
  getPullRequest,
  getPullRequestChanges,
  getPullRequestChecks,
  getPullRequestComments,
} from '../../features/pull-requests';
import { getWikiPage, listWikiPages } from '../../features/wikis';
import type { WikiPageSummary } from '../../features/wikis/list-wiki-pages/feature';
import {
  buildManifest,
  createWorkItemSummary,
  workItemMarkdownFile,
} from './manifest';
import {
  compactWorkItemType,
  fieldString,
  renderWorkItemMarkdown,
  renderWorkItemCommentsMarkdown,
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
  WorkItemCommentsArtifact,
  WorkItemWithActivity,
} from './types';

const CHILD_RELATION = 'System.LinkTypes.Hierarchy-Forward';
const PARENT_RELATION = 'System.LinkTypes.Hierarchy-Reverse';
const WORK_ITEM_URL_ID_PATTERN = /\/workItems\/(\d+)(?:$|[/?#])/i;
type WikiPageListCache = Map<string, Promise<WikiPageSummary[]>>;

export async function collectTaskContext(
  options: TaskContextCollectOptions,
): Promise<Manifest> {
  const warnings: CollectionIssue[] = [];
  const errors: CollectionIssue[] = [];
  const generatedAt = new Date().toISOString();
  const outputDir = path.resolve(options.outputDir);

  const rootWorkItem = await getWorkItem(
    options.connection,
    options.workItemId,
    'all',
  );
  if (isRemovedWorkItem(rootWorkItem)) {
    throw new Error(
      `Work item ${options.workItemId} is Removed and cannot be collected`,
    );
  }

  await resetOutputDirectory(outputDir);

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
    if (isRemovedWorkItem(child)) {
      warnings.push(skippedRemovedWorkItemIssue(child));
      continue;
    }

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
  applyWorkItemCommentSummaries(
    [rootSummary, ...Object.values(activitySummaries).flat()],
    workItemComments,
  );
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
      if (isRemovedWorkItem(workItem)) {
        warnings.push(skippedRemovedWorkItemIssue(workItem, request.id));
        continue;
      }

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
): Promise<WorkItemCommentsArtifact[]> {
  let witApi: Awaited<ReturnType<WebApi['getWorkItemTrackingApi']>>;
  try {
    witApi = await connection.getWorkItemTrackingApi();
  } catch (error) {
    warnings.push(
      toIssue(
        'Failed to initialize work item comments API',
        'work-item-comments',
        error,
      ),
    );
    return [];
  }
  const results: WorkItemCommentsArtifact[] = [];
  for (const workItem of workItems) {
    if (workItem.id === undefined) {
      continue;
    }
    try {
      const comments: Comment[] = [];
      let continuationToken: string | undefined;
      let totalCount: number | undefined;
      const seenContinuationTokens = new Set<string>();
      do {
        const page = await witApi.getComments(
          project,
          workItem.id,
          200,
          continuationToken,
          false,
          undefined,
          CommentSortOrder.Asc,
        );
        comments.push(...(page.comments ?? []));
        totalCount = page.totalCount ?? totalCount;
        const nextToken = page.continuationToken || undefined;
        if (nextToken && seenContinuationTokens.has(nextToken)) {
          throw new Error(
            `Repeated continuation token while fetching comments for work item ${workItem.id}`,
          );
        }
        if (nextToken) {
          seenContinuationTokens.add(nextToken);
        }
        continuationToken = nextToken;
      } while (continuationToken);

      const artifact: WorkItemCommentsArtifact = {
        workItemId: workItem.id,
        comments,
        count: comments.length,
        totalCount: totalCount ?? comments.length,
      };
      results.push(artifact);
      await writeMarkdownFile(
        outputDir,
        workItemCommentsMarkdownFile(workItem.id),
        renderWorkItemCommentsMarkdown(artifact),
      );
      if (includeRaw) {
        await writeJsonFile(
          outputDir,
          `work-items/comments/raw/${workItem.id}.comments.json`,
          {
            count: artifact.count,
            totalCount: artifact.totalCount,
            comments: artifact.comments,
          },
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

function applyWorkItemCommentSummaries(
  summaries: WorkItemSummary[],
  comments: WorkItemCommentsArtifact[],
): void {
  const commentsByWorkItemId = new Map(
    comments.map((entry) => [entry.workItemId, entry]),
  );
  for (const summary of summaries) {
    const entry = commentsByWorkItemId.get(summary.id);
    if (!entry) {
      continue;
    }
    summary.commentsFile = workItemCommentsMarkdownFile(summary.id);
    summary.commentCount = entry.count;
  }
}

function workItemCommentsMarkdownFile(workItemId: number): string {
  return `work-items/comments/${workItemId}.comments.md`;
}

async function collectPullRequests(
  options: TaskContextCollectOptions,
  scopedWorkItems: WorkItemWithActivity[],
  links: ExtractedLink[],
  warnings: CollectionIssue[],
): Promise<PullRequestArtifact[]> {
  const gitApi = await options.connection.getGitApi();
  const byKey = new Map<string, PullRequestArtifact>();
  const skippedKeys = new Set<string>();
  const candidates = links.filter(
    (link) => link.kind === 'pull-request' && link.pullRequestId !== undefined,
  );

  for (const link of candidates) {
    const source = sourceFromLink(link, scopedWorkItems);
    if (!source) {
      continue;
    }
    const key = `${link.repositoryId ?? link.repositoryName ?? 'unknown'}:${link.pullRequestId}`;
    if (skippedKeys.has(key)) {
      continue;
    }
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
      if (!shouldCollectPullRequest(raw)) {
        skippedKeys.add(key);
        warnings.push(skippedPullRequestIssue(link.pullRequestId ?? 0, raw));
        continue;
      }

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

export async function collectWikiPages(
  options: TaskContextCollectOptions,
  scopedWorkItems: WorkItemWithActivity[],
  links: ExtractedLink[],
  warnings: CollectionIssue[],
): Promise<WikiArtifact[]> {
  const byKey = new Map<string, WikiArtifact>();
  const pageListCache: WikiPageListCache = new Map();

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
    const pagePath = await resolveWikiPagePath(
      options,
      link,
      warnings,
      pageListCache,
    );
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
  pageListCache: WikiPageListCache,
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
    const pages = await getCachedWikiPages(
      pageListCache,
      organizationId,
      projectId,
      link.wikiId,
    );
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

function getCachedWikiPages(
  cache: WikiPageListCache,
  organizationId: string | undefined,
  projectId: string,
  wikiId: string,
): Promise<WikiPageSummary[]> {
  const cacheKey = JSON.stringify([organizationId ?? '', projectId, wikiId]);
  let pages = cache.get(cacheKey);
  if (!pages) {
    pages = listWikiPages({
      organizationId,
      projectId,
      wikiId,
    });
    cache.set(cacheKey, pages);
  }
  return pages;
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

export function isRemovedWorkItem(workItem: WorkItem): boolean {
  return normalizedString(workItem.fields?.['System.State']) === 'removed';
}

export function shouldCollectPullRequest(raw: unknown): boolean {
  const record = asRecord(raw);
  return isCompletedPullRequestStatus(record.status) && record.isDraft !== true;
}

function skippedRemovedWorkItemIssue(
  workItem: WorkItem,
  fallbackId?: number,
): CollectionIssue {
  const id =
    workItem.id ?? fallbackId ?? Number(workItem.fields?.['System.Id']);
  return {
    message: `Skipped removed work item ${Number.isFinite(id) ? id : 'unknown'}`,
    source: 'work-item',
  };
}

function skippedPullRequestIssue(
  pullRequestId: number,
  raw: unknown,
): CollectionIssue {
  const record = asRecord(raw);
  const status = pullRequestStatusText(record.status);
  const draftSuffix = record.isDraft === true ? ', draft: true' : '';
  return {
    message: `Skipped pull request ${pullRequestId} because it is not completed (status: ${status}${draftSuffix})`,
    source: 'pull-request',
  };
}

function normalizedString(value: unknown): string | undefined {
  const text = stringFrom(value);
  return text?.trim().toLowerCase();
}

function isCompletedPullRequestStatus(value: unknown): boolean {
  if (typeof value === 'number') {
    return value === PullRequestStatus.Completed;
  }
  return normalizedString(value) === 'completed';
}

function pullRequestStatusText(value: unknown): string {
  if (typeof value === 'number') {
    return PullRequestStatus[value]?.toLowerCase() ?? String(value);
  }
  return stringFrom(value) ?? 'unknown';
}
