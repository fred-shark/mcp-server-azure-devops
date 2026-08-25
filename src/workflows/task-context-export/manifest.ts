import { WorkItem } from '../../features/work-items';
import {
  CommitArtifact,
  Manifest,
  ManifestCommit,
  ManifestPullRequest,
  ManifestWikiPage,
  PullRequestArtifact,
  WikiArtifact,
  WorkItemSummary,
} from './types';
import {
  compactWorkItemType,
  fieldString,
  safeBoundedFileName,
} from './markdownRenderers';

export function createWorkItemSummary(
  workItem: WorkItem,
  file: string,
  rawFile: string | undefined,
  options: {
    activity?: string;
    fullCollection?: boolean;
    relationType?: string;
    sourceWorkItemId?: number;
  } = {},
): WorkItemSummary {
  const fields = workItem.fields ?? {};
  const type = fieldString(fields, 'System.WorkItemType', 'Unknown');
  return {
    id: workItem.id ?? Number(fields['System.Id']),
    type,
    title: fieldString(fields, 'System.Title', 'Untitled'),
    state: fieldString(fields, 'System.State', 'Unknown'),
    activity: options.activity,
    assignedTo: fieldString(fields, 'System.AssignedTo', ''),
    relationType: options.relationType,
    sourceWorkItemId: options.sourceWorkItemId,
    file,
    rawFile,
    fullCollection: options.fullCollection,
  };
}

export function buildManifest(input: {
  generatedAt: string;
  collectionUrl?: string;
  project: string;
  rootWorkItem: WorkItem;
  outputDir: string;
  activityFilter?: string;
  rootSummary: WorkItemSummary;
  activities: Record<string, WorkItemSummary[]>;
  contextReferences: WorkItemSummary[];
  wikiPages: WikiArtifact[];
  pullRequests: PullRequestArtifact[];
  commits: CommitArtifact[];
  links: Manifest['links'];
  warnings: Manifest['warnings'];
  errors: Manifest['errors'];
}): Manifest {
  return {
    schemaVersion: '1.0',
    generatedAt: input.generatedAt,
    collectionUrl: input.collectionUrl,
    project: input.project,
    rootWorkItemId: input.rootWorkItem.id ?? 0,
    rootWorkItemTitle: fieldString(
      input.rootWorkItem.fields ?? {},
      'System.Title',
      'Untitled',
    ),
    outputDir: input.outputDir,
    activityFilter: input.activityFilter ?? null,
    workItems: {
      root: input.rootSummary,
      activities: input.activities,
      contextReferences: input.contextReferences,
    },
    wikiPages: input.wikiPages.map(toManifestWikiPage),
    pullRequests: input.pullRequests.map(toManifestPullRequest),
    commits: input.commits.map(toManifestCommit),
    links: input.links,
    warnings: input.warnings,
    errors: input.errors,
  };
}

export function workItemMarkdownFile(id: number, type: string): string {
  return `${id}.${compactWorkItemType(type)}.md`;
}

function toManifestPullRequest(
  artifact: PullRequestArtifact,
): ManifestPullRequest {
  const raw = asRecord(artifact.raw);
  const repositoryDir = safeBoundedFileName(
    artifact.repositoryName ?? artifact.repositoryId ?? 'unknown-repository',
  );
  const baseDir = `pull-requests/${repositoryDir}/pr-${artifact.id}`;
  return {
    id: artifact.id,
    repository: artifact.repositoryName,
    repositoryId: artifact.repositoryId,
    title: stringFrom(raw.title),
    status: stringFrom(raw.status),
    sourceWorkItemIds: sourceWorkItemIds(artifact.sources),
    sourceWorkItemActivities: sourceActivities(artifact.sources),
    sourceRelationType: artifact.sources[0]?.sourceRelationType,
    file: `${baseDir}/pr.md`,
    commentsFile: artifact.comments ? `${baseDir}/comments.md` : undefined,
    changesFile: artifact.changes ? `${baseDir}/changes.md` : undefined,
    checksFile: artifact.checks ? `${baseDir}/checks.md` : undefined,
  };
}

function toManifestCommit(artifact: CommitArtifact): ManifestCommit {
  const raw = asRecord(artifact.raw);
  return {
    hash: artifact.hash,
    repository: artifact.repositoryName,
    repositoryId: artifact.repositoryId,
    comment: stringFrom(raw.comment),
    sourceWorkItemIds: sourceWorkItemIds(artifact.sources),
    sourceWorkItemActivities: sourceActivities(artifact.sources),
    file: 'commits/commits.md',
  };
}

function toManifestWikiPage(artifact: WikiArtifact): ManifestWikiPage {
  return {
    title: artifact.title,
    path: artifact.path,
    wikiId: artifact.wikiId,
    file: `wiki/pages/${artifact.key}.md`,
    source: artifact.source,
    sourceWorkItemIds: sourceWorkItemIds(artifact.sources),
  };
}

function sourceWorkItemIds(
  sources: Array<{ sourceWorkItemId: number }>,
): number[] {
  return [...new Set(sources.map((source) => source.sourceWorkItemId))].sort(
    (left, right) => left - right,
  );
}

function sourceActivities(
  sources: Array<{ sourceWorkItemActivity: string }>,
): string[] {
  return [...new Set(sources.map((source) => source.sourceWorkItemActivity))];
}

function stringFrom(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
