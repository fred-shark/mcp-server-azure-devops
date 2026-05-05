import { WebApi } from 'azure-devops-node-api';
import { WorkItem } from '../../features/work-items';

export interface TaskContextCollectOptions {
  connection: WebApi;
  project: string;
  workItemId: number;
  outputDir: string;
  organizationId?: string;
  activityFilter?: string;
  includeWiki: boolean;
  includePrs: boolean;
  includeCommits: boolean;
  includeComments: boolean;
  includeChecks: boolean;
  includeRaw: boolean;
}

export interface TaskContextCollectCliOptions {
  project?: string;
  workItemId: number;
  out?: string;
  activityFilter?: string;
  includeWiki?: boolean;
  includePrs?: boolean;
  includeCommits?: boolean;
  includeComments?: boolean;
  includeChecks?: boolean;
  includeRaw?: boolean;
}

export interface CollectionIssue {
  message: string;
  source?: string;
  error?: string;
}

export interface WorkItemSummary {
  id: number;
  type: string;
  title: string;
  state: string;
  activity?: string;
  assignedTo?: string;
  relationType?: string;
  sourceWorkItemId?: number;
  file: string;
  rawFile?: string;
  fullCollection?: boolean;
}

export interface ManifestPullRequest {
  id: number;
  repository?: string;
  repositoryId?: string;
  title?: string;
  status?: string;
  sourceWorkItemIds: number[];
  sourceWorkItemActivities: string[];
  sourceRelationType?: string;
  file: string;
  commentsFile?: string;
  changesFile?: string;
  checksFile?: string;
}

export interface ManifestCommit {
  hash: string;
  repository?: string;
  repositoryId?: string;
  comment?: string;
  sourceWorkItemIds: number[];
  sourceWorkItemActivities: string[];
  file: string;
}

export interface ManifestWikiPage {
  title: string;
  path: string;
  wikiId?: string;
  file: string;
  source: 'explicit-link' | 'search';
  sourceWorkItemIds: number[];
}

export interface ExtractedLink {
  kind:
    | 'wiki'
    | 'pull-request'
    | 'commit'
    | 'branch'
    | 'build'
    | 'external'
    | 'unknown-artifact';
  url: string;
  source: string;
  sourceWorkItemId?: number;
  relationType?: string;
  repositoryId?: string;
  repositoryName?: string;
  pullRequestId?: number;
  commitId?: string;
  branchName?: string;
  buildId?: number;
  wikiId?: string;
  wikiPath?: string;
  wikiPageId?: number;
  wikiProjectId?: string;
  wikiOrganizationId?: string;
}

export interface Manifest {
  schemaVersion: '1.0';
  generatedAt: string;
  collectionUrl?: string;
  project: string;
  rootWorkItemId: number;
  rootWorkItemTitle: string;
  outputDir: string;
  activityFilter: string | null;
  workItems: {
    root: WorkItemSummary;
    activities: Record<string, WorkItemSummary[]>;
    contextReferences: WorkItemSummary[];
  };
  wikiPages: ManifestWikiPage[];
  pullRequests: ManifestPullRequest[];
  commits: ManifestCommit[];
  links: ExtractedLink[];
  warnings: CollectionIssue[];
  errors: CollectionIssue[];
}

export interface ClassifiedWorkItems {
  directChildIds: number[];
  contextReferenceIds: Array<{
    id: number;
    relationType: string;
    sourceWorkItemId: number;
  }>;
  links: ExtractedLink[];
}

export interface WorkItemWithActivity {
  workItem: WorkItem;
  activity: string;
  fullCollection: boolean;
}

export interface ArtifactSource {
  sourceWorkItemId: number;
  sourceWorkItemActivity: string;
  sourceRelationType?: string;
}

export interface PullRequestArtifact {
  key: string;
  id: number;
  repositoryId?: string;
  repositoryName?: string;
  raw?: unknown;
  comments?: unknown;
  changes?: unknown;
  checks?: unknown;
  sources: ArtifactSource[];
}

export interface CommitArtifact {
  key: string;
  hash: string;
  repositoryId?: string;
  repositoryName?: string;
  raw?: unknown;
  sources: ArtifactSource[];
}

export interface WikiArtifact {
  key: string;
  title: string;
  path: string;
  wikiId?: string;
  content?: string;
  raw?: unknown;
  source: 'explicit-link' | 'search';
  sources: ArtifactSource[];
}

export interface FileWriteResult {
  path: string;
}
