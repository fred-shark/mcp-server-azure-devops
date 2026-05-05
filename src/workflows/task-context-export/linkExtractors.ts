import { WorkItem } from '../../features/work-items';
import { ExtractedLink } from './types';

const urlPattern = /https?:\/\/[^\s<>"')]+/gi;
const pullRequestArtifactPattern =
  /vstfs:\/\/\/Git\/PullRequestId\/([^/%\s]+)(?:%2F|\/)([^/%\s]+)(?:%2F|\/)(\d+)/i;
const commitArtifactPattern =
  /vstfs:\/\/\/Git\/Commit\/([^/%\s]+)(?:%2F|\/)([^/%\s]+)(?:%2F|\/)([a-f0-9]{7,40})/i;
const branchArtifactPattern =
  /vstfs:\/\/\/Git\/Ref\/([^/%\s]+)(?:%2F|\/)([^/%\s]+)(?:%2F|\/)(.+)$/i;
const buildArtifactPattern = /vstfs:\/\/\/Build\/Build\/(\d+)/i;

export function extractLinksFromWorkItem(workItem: WorkItem): ExtractedLink[] {
  const workItemId = workItem.id;
  const links: ExtractedLink[] = [];

  for (const [fieldName, value] of Object.entries(workItem.fields ?? {})) {
    if (typeof value === 'string') {
      links.push(
        ...extractLinksFromText(value, `field:${fieldName}`, workItemId),
      );
    }
  }

  for (const relation of workItem.relations ?? []) {
    const relationType = relation.rel;
    const url = relation.url ?? '';
    const attributesText = JSON.stringify(relation.attributes ?? {});
    links.push(
      classifyUrl(url, `relation:${relationType}`, workItemId, relationType),
    );
    links.push(
      ...extractLinksFromText(
        attributesText,
        `relation-attributes:${relationType}`,
        workItemId,
        relationType,
      ),
    );
  }

  return dedupeLinks(links);
}

export function extractLinksFromText(
  text: string,
  source: string,
  sourceWorkItemId?: number,
  relationType?: string,
): ExtractedLink[] {
  const urls = text.match(urlPattern) ?? [];
  return dedupeLinks(
    urls.map((url) => classifyUrl(url, source, sourceWorkItemId, relationType)),
  );
}

export function classifyUrl(
  rawUrl: string,
  source: string,
  sourceWorkItemId?: number,
  relationType?: string,
): ExtractedLink {
  const url = trimUrl(rawUrl);
  const decoded = safeDecode(url);

  const pullRequestArtifact = decoded.match(pullRequestArtifactPattern);
  if (pullRequestArtifact) {
    return {
      kind: 'pull-request',
      url,
      source,
      sourceWorkItemId,
      relationType,
      repositoryId: pullRequestArtifact[2],
      pullRequestId: Number(pullRequestArtifact[3]),
    };
  }

  const commitArtifact = decoded.match(commitArtifactPattern);
  if (commitArtifact) {
    return {
      kind: 'commit',
      url,
      source,
      sourceWorkItemId,
      relationType,
      repositoryId: commitArtifact[2],
      commitId: commitArtifact[3],
    };
  }

  const branchArtifact = decoded.match(branchArtifactPattern);
  if (branchArtifact) {
    return {
      kind: 'branch',
      url,
      source,
      sourceWorkItemId,
      relationType,
      repositoryId: branchArtifact[2],
      branchName: branchArtifact[3],
    };
  }

  const buildArtifact = decoded.match(buildArtifactPattern);
  if (buildArtifact) {
    return {
      kind: 'build',
      url,
      source,
      sourceWorkItemId,
      relationType,
      buildId: Number(buildArtifact[1]),
    };
  }

  const prUrl = parsePullRequestUrl(decoded);
  if (prUrl) {
    return {
      kind: 'pull-request',
      url,
      source,
      sourceWorkItemId,
      relationType,
      repositoryName: prUrl.repositoryName,
      pullRequestId: prUrl.pullRequestId,
    };
  }

  const commitUrl = parseCommitUrl(decoded);
  if (commitUrl) {
    return {
      kind: 'commit',
      url,
      source,
      sourceWorkItemId,
      relationType,
      repositoryName: commitUrl.repositoryName,
      commitId: commitUrl.commitId,
    };
  }

  const wikiUrl = parseWikiUrl(decoded);
  if (wikiUrl) {
    return {
      kind: 'wiki',
      url,
      source,
      sourceWorkItemId,
      relationType,
      wikiId: wikiUrl.wikiId,
      wikiPath: wikiUrl.path,
      wikiPageId: wikiUrl.pageId,
      wikiProjectId: wikiUrl.projectId,
      wikiOrganizationId: wikiUrl.organizationId,
    };
  }

  if (decoded.startsWith('vstfs:///')) {
    return {
      kind: 'unknown-artifact',
      url,
      source,
      sourceWorkItemId,
      relationType,
    };
  }

  return {
    kind: 'external',
    url,
    source,
    sourceWorkItemId,
    relationType,
  };
}

export function dedupeLinks(links: ExtractedLink[]): ExtractedLink[] {
  const seen = new Set<string>();
  const result: ExtractedLink[] = [];

  for (const link of links) {
    const key = [
      link.kind,
      link.url,
      link.source,
      link.sourceWorkItemId ?? '',
      link.relationType ?? '',
    ].join('|');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(link);
    }
  }

  return result;
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/g, '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePullRequestUrl(
  url: string,
): { repositoryName?: string; pullRequestId: number } | undefined {
  const match = url.match(/\/_git\/([^/?#]+)\/pullrequest\/(\d+)/i);
  if (!match) {
    return undefined;
  }
  return { repositoryName: match[1], pullRequestId: Number(match[2]) };
}

function parseCommitUrl(
  url: string,
): { repositoryName?: string; commitId: string } | undefined {
  const match = url.match(/\/_git\/([^/?#]+)\/commit\/([a-f0-9]{7,40})/i);
  if (!match) {
    return undefined;
  }
  return { repositoryName: match[1], commitId: match[2] };
}

function parseWikiUrl(url: string):
  | {
      wikiId?: string;
      path?: string;
      pageId?: number;
      projectId?: string;
      organizationId?: string;
    }
  | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }

  const segments = parsedUrl.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment));
  const wikiMarkerIndex = segments.findIndex(
    (segment, index) => segment === '_wiki' && segments[index + 1] === 'wikis',
  );

  if (wikiMarkerIndex < 0) {
    return undefined;
  }

  const wikiId = segments[wikiMarkerIndex + 2];
  const firstPageSegment = segments[wikiMarkerIndex + 3];
  const pageId =
    firstPageSegment && /^\d+$/.test(firstPageSegment)
      ? Number(firstPageSegment)
      : undefined;

  if (wikiId) {
    return {
      wikiId,
      pageId,
      path: pageId
        ? undefined
        : firstPageSegment
          ? `/${segments.slice(wikiMarkerIndex + 3).join('/')}`
          : '/',
      projectId: segments[wikiMarkerIndex - 1],
      organizationId: inferOrganizationId(segments, wikiMarkerIndex),
    };
  }

  const match = url.match(/\/_wiki\/wikis\/([^/]+)(?:\/\d+)?(\/[^?#]*)?/i);
  if (!match) {
    return undefined;
  }
  return {
    wikiId: match[1],
    path: match[2] ? safeDecode(match[2]) : '/',
  };
}

function inferOrganizationId(
  segments: string[],
  wikiMarkerIndex: number,
): string | undefined {
  if (wikiMarkerIndex < 2) {
    return undefined;
  }
  const possibleTfsSegment = segments[wikiMarkerIndex - 3];
  if (possibleTfsSegment?.toLowerCase() === 'tfs') {
    return segments[wikiMarkerIndex - 2];
  }
  return segments[wikiMarkerIndex - 2];
}
