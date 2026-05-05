import path from 'path';
import {
  classifyChangedFile,
  classifyCommitMessage,
  detectDocumentType,
  detectWikiPriority,
  extractMarkdownHeadings,
  extractSectionExcerpts,
  getFileSize,
  safeReadTextExcerpt,
  summarizeChangedFilesFromDiffOrMarkdown,
  truncateText,
} from './analysisUtils';
import { writeJsonFile, writeMarkdownFile } from './fileWriters';
import { writeCompactInventory } from './inventory';
import {
  ExtractedLink,
  Manifest,
  ManifestCommit,
  ManifestPullRequest,
  WorkItemSummary,
} from './types';

interface CompactWorkItem {
  id: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  activity?: string;
  relationType?: string;
  sourceWorkItemId?: number;
  descriptionExcerpt: string;
  acceptanceCriteriaExcerpt: string;
  relationsSummary: string[];
  linkedPullRequestIds: number[];
  linkedCommitHashes: string[];
  linkedWikiLinks: string[];
  sourceFile?: string;
  fullCollection?: boolean;
}

interface WorkItemsCompact {
  root: CompactWorkItem;
  activities: Record<string, CompactWorkItem[]>;
  contextReferences: CompactWorkItem[];
}

interface WikiIndexPage {
  title: string;
  path: string;
  file: string;
  source: string;
  sourceWorkItemIds: number[];
  fileSize: number;
  documentType: string;
  priority: 'high' | 'medium' | 'low';
  headings: string[];
  excerpt: string;
  sectionExcerpts: Record<string, string>;
}

interface PrIndexItem {
  id: number;
  repository: string;
  title: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  linkedWorkItemIds: number[];
  linkedActivities: string[];
  priority: 'high' | 'medium' | 'low';
  descriptionExcerpt: string;
  commentsSummary: CommentsSummary;
  checksSummary: ChecksSummary;
  changesSummary: {
    totalChangedFiles: number;
    files: string[];
    topLevelDirectories: string[];
    categories: Record<string, number>;
    signals: string[];
  };
  file?: string;
  commentsFile?: string;
  changesFile?: string;
  checksFile?: string;
}

interface CommentsSummary {
  count: number;
  statusCounts: Record<string, number>;
  importantComments: string[];
}

interface ChecksSummary {
  statusCounts: Record<string, number>;
  policyOrBuildNames: string[];
}

interface CommitsCompact {
  totalCommitCount: number;
  repositories: string[];
  sourceWorkItemIds: number[];
  sourceWorkItemActivities: string[];
  groupedCommitMessages: Record<string, string[]>;
  sampleCommits: Array<{
    hash: string;
    repository?: string;
    comment?: string;
    category: string;
    sourceWorkItemIds: number[];
    sourceWorkItemActivities: string[];
  }>;
  lowQualityCommitMessagesCount: number;
  detectedPullRequestReferences: string[];
  detectedWorkItemReferences: string[];
}

const wikiSectionKeywords = [
  'требован',
  'requirements',
  'api',
  'contract',
  'контракт',
  'database',
  'migration',
  'миграц',
  'integration',
  'интеграц',
  'deployment',
  'testing',
  'тест',
  'risk',
  'риск',
];

export async function writeCompactAnalysisPack(
  outputDir: string,
  manifest: Manifest,
): Promise<void> {
  await writeCompactInventory(outputDir, manifest);

  const workItems = await buildWorkItemsCompact(outputDir, manifest);
  await writeJsonFile(
    outputDir,
    'output/analysis/01-work-items-compact.json',
    workItems,
  );
  await writeMarkdownFile(
    outputDir,
    'output/analysis/01-work-items-compact.md',
    renderWorkItemsCompact(workItems),
  );

  const wikiIndex = await buildWikiIndex(outputDir, manifest);
  await writeJsonFile(
    outputDir,
    'output/analysis/02-wiki-index.json',
    wikiIndex,
  );
  await writeMarkdownFile(
    outputDir,
    'output/analysis/02-wiki-index.md',
    renderWikiIndex(wikiIndex),
  );

  const prIndex = await buildPrIndex(outputDir, manifest);
  await writeJsonFile(outputDir, 'output/analysis/03-pr-index.json', prIndex);
  await writeMarkdownFile(
    outputDir,
    'output/analysis/03-pr-index.md',
    renderPrIndex(prIndex),
  );

  const commits = buildCommitsCompact(manifest.commits);
  await writeJsonFile(
    outputDir,
    'output/analysis/04-commits-compact.json',
    commits,
  );
  await writeMarkdownFile(
    outputDir,
    'output/analysis/04-commits-compact.md',
    renderCommitsCompact(commits),
  );

  await writeMarkdownFile(
    outputDir,
    'output/analysis/05-analysis-input.md',
    renderAnalysisInput(manifest, workItems, wikiIndex, prIndex, commits),
  );
}

async function buildWorkItemsCompact(
  outputDir: string,
  manifest: Manifest,
): Promise<WorkItemsCompact> {
  const root = await toCompactWorkItem(
    outputDir,
    manifest.workItems.root,
    manifest.links,
    1200,
    1200,
  );
  const activities: Record<string, CompactWorkItem[]> = {};
  for (const [activity, items] of Object.entries(
    manifest.workItems.activities,
  )) {
    activities[activity] = await Promise.all(
      items.map((item) =>
        toCompactWorkItem(outputDir, item, manifest.links, 1000, 1000),
      ),
    );
  }
  const contextReferences = await Promise.all(
    manifest.workItems.contextReferences.map((item) =>
      toCompactWorkItem(outputDir, item, manifest.links, 600, 600),
    ),
  );
  return { root, activities, contextReferences };
}

async function toCompactWorkItem(
  outputDir: string,
  item: WorkItemSummary,
  links: ExtractedLink[],
  descriptionLimit: number,
  acceptanceLimit: number,
): Promise<CompactWorkItem> {
  const text = item.file
    ? await safeReadTextExcerpt(path.join(outputDir, item.file), 64 * 1024)
    : '';
  const sections = extractWorkItemSections(text);
  const itemLinks = links.filter((link) => link.sourceWorkItemId === item.id);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    state: item.state,
    assignedTo: item.assignedTo,
    activity: item.activity,
    relationType: item.relationType,
    sourceWorkItemId: item.sourceWorkItemId,
    descriptionExcerpt: truncateText(sections.description, descriptionLimit),
    acceptanceCriteriaExcerpt: truncateText(
      sections.acceptanceCriteria,
      acceptanceLimit,
    ),
    relationsSummary: sections.relations,
    linkedPullRequestIds: uniqueNumbers(
      itemLinks
        .filter((link) => link.kind === 'pull-request')
        .map((link) => link.pullRequestId),
    ),
    linkedCommitHashes: uniqueStrings(
      itemLinks
        .filter((link) => link.kind === 'commit')
        .map((link) => link.commitId),
    ),
    linkedWikiLinks: uniqueStrings(
      itemLinks.filter((link) => link.kind === 'wiki').map((link) => link.url),
    ),
    sourceFile: item.file,
    fullCollection: item.fullCollection,
  };
}

async function buildWikiIndex(
  outputDir: string,
  manifest: Manifest,
): Promise<WikiIndexPage[]> {
  const developmentWorkItemIds = new Set(
    Object.entries(manifest.workItems.activities)
      .filter(([activity]) => activity.toLowerCase().includes('development'))
      .flatMap(([, items]) => items.map((item) => item.id)),
  );
  return Promise.all(
    manifest.wikiPages.map(async (page) => {
      const fullPath = path.join(outputDir, page.file);
      const text = await safeReadTextExcerpt(fullPath, 96 * 1024);
      const headings = extractMarkdownHeadings(text);
      const documentType = detectDocumentType(
        page.title,
        page.path,
        page.file,
        headings,
      );
      return {
        title: page.title,
        path: page.path,
        file: page.file,
        source: page.source,
        sourceWorkItemIds: page.sourceWorkItemIds,
        fileSize: await getFileSize(fullPath),
        documentType,
        priority: detectWikiPriority({
          documentType,
          sourceWorkItemIds: page.sourceWorkItemIds,
          developmentWorkItemIds: [...developmentWorkItemIds],
          rootWorkItemId: manifest.rootWorkItemId,
        }),
        headings: headings.slice(0, 60),
        excerpt: truncateText(text, 1500),
        sectionExcerpts: extractSectionExcerpts(text, wikiSectionKeywords, 900),
      };
    }),
  );
}

async function buildPrIndex(
  outputDir: string,
  manifest: Manifest,
): Promise<PrIndexItem[]> {
  return Promise.all(
    manifest.pullRequests.map(async (pullRequest) => {
      const prText = pullRequest.file
        ? await safeReadTextExcerpt(
            path.join(outputDir, pullRequest.file),
            64 * 1024,
          )
        : '';
      const description = sectionBetween(prText, '## Description');
      const changesSummary = pullRequest.changesFile
        ? await summarizeChangedFilesFromDiffOrMarkdown(
            path.join(outputDir, pullRequest.changesFile),
          )
        : {
            totalChangedFiles: 0,
            files: [],
            topLevelDirectories: [],
            categories: {},
            signals: [],
          };
      return {
        id: pullRequest.id,
        repository:
          pullRequest.repository ?? pullRequest.repositoryId ?? 'Unknown',
        title: pullRequest.title ?? '',
        status: pullRequest.status ?? '',
        sourceBranch: extractBulletValue(prText, 'Source Branch'),
        targetBranch: extractBulletValue(prText, 'Target Branch'),
        linkedWorkItemIds: pullRequest.sourceWorkItemIds,
        linkedActivities: pullRequest.sourceWorkItemActivities,
        priority: detectPrPriority(pullRequest),
        descriptionExcerpt: truncateText(description, 1200),
        commentsSummary: pullRequest.commentsFile
          ? await summarizeComments(
              path.join(outputDir, pullRequest.commentsFile),
            )
          : { count: 0, statusCounts: {}, importantComments: [] },
        checksSummary: pullRequest.checksFile
          ? await summarizeChecks(path.join(outputDir, pullRequest.checksFile))
          : { statusCounts: {}, policyOrBuildNames: [] },
        changesSummary,
        file: pullRequest.file,
        commentsFile: pullRequest.commentsFile,
        changesFile: pullRequest.changesFile,
        checksFile: pullRequest.checksFile,
      };
    }),
  );
}

function buildCommitsCompact(commits: ManifestCommit[]): CommitsCompact {
  const groupedCommitMessages: Record<string, string[]> = {};
  let lowQualityCommitMessagesCount = 0;
  const prRefs = new Set<string>();
  const workItemRefs = new Set<string>();

  for (const commit of commits) {
    const comment = commit.comment ?? '';
    const category = classifyCommitMessage(comment);
    groupedCommitMessages[category] = groupedCommitMessages[category] ?? [];
    if (groupedCommitMessages[category].length < 20) {
      groupedCommitMessages[category].push(truncateText(comment, 180));
    }
    if (comment.trim().length < 8 || category === 'unclear') {
      lowQualityCommitMessagesCount += 1;
    }
    for (const match of comment.matchAll(/(?:PR|pull request)\s*#?(\d+)/gi)) {
      prRefs.add(match[1]);
    }
    for (const match of comment.matchAll(/#(\d{4,})\b/g)) {
      workItemRefs.add(match[1]);
    }
  }

  return {
    totalCommitCount: commits.length,
    repositories: uniqueStrings(commits.map((commit) => commit.repository)),
    sourceWorkItemIds: uniqueNumbers(
      commits.flatMap((commit) => commit.sourceWorkItemIds),
    ),
    sourceWorkItemActivities: uniqueStrings(
      commits.flatMap((commit) => commit.sourceWorkItemActivities),
    ),
    groupedCommitMessages,
    sampleCommits: commits.slice(0, 30).map((commit) => ({
      hash: commit.hash,
      repository: commit.repository,
      comment: truncateText(commit.comment, 180),
      category: classifyCommitMessage(commit.comment ?? ''),
      sourceWorkItemIds: commit.sourceWorkItemIds,
      sourceWorkItemActivities: commit.sourceWorkItemActivities,
    })),
    lowQualityCommitMessagesCount,
    detectedPullRequestReferences: [...prRefs],
    detectedWorkItemReferences: [...workItemRefs],
  };
}

async function summarizeComments(filePath: string): Promise<CommentsSummary> {
  const text = await safeReadTextExcerpt(filePath, 80 * 1024);
  const statusCounts = countMatches(text, /^- Status: (.+)$/gim);
  const importantComments = text
    .split(/^### Comment .+$/gim)
    .map((part) => truncateText(stripBoilerplate(part), 500))
    .filter(Boolean)
    .slice(0, 5);
  return {
    count: (text.match(/^### Comment /gim) ?? []).length,
    statusCounts,
    importantComments,
  };
}

async function summarizeChecks(filePath: string): Promise<ChecksSummary> {
  const text = await safeReadTextExcerpt(filePath, 64 * 1024);
  const statusCounts = countMatches(
    text,
    /:\s*(succeeded|failed|skipped|pending|approved|rejected|queued|running)\b/gim,
  );
  const policyOrBuildNames = uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.match(/^-\s+(.+?):/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => truncateText(value, 120)),
  ).slice(0, 30);
  return { statusCounts, policyOrBuildNames };
}

function renderWorkItemsCompact(compact: WorkItemsCompact): string {
  const lines = ['# Work Items Compact', '', '## Root', ''];
  pushWorkItem(lines, compact.root);
  lines.push('', '## Activity Groups', '');
  for (const [activity, items] of Object.entries(compact.activities)) {
    lines.push(`### ${activity}`, '', `- Count: ${items.length}`, '');
    for (const item of items) {
      pushWorkItem(lines, item);
      lines.push('');
    }
  }
  lines.push('## Context References', '');
  if (compact.contextReferences.length === 0) {
    lines.push('Not found.');
  } else {
    for (const item of compact.contextReferences) {
      pushWorkItem(lines, item, true);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderWikiIndex(pages: WikiIndexPage[]): string {
  const lines = ['# Wiki Index', ''];
  if (pages.length === 0) {
    lines.push('No wiki pages found.');
    return `${lines.join('\n')}\n`;
  }
  for (const page of pages) {
    lines.push(`## ${page.title}`, '');
    lines.push(`- Path: ${page.path}`);
    lines.push(`- File: \`${page.file}\``);
    lines.push(`- Source: ${page.source}`);
    lines.push(`- Source work items: ${page.sourceWorkItemIds.join(', ')}`);
    lines.push(`- File size: ${page.fileSize}`);
    lines.push(`- Document type: ${page.documentType}`);
    lines.push(`- Priority: ${page.priority}`);
    lines.push(
      `- Headings: ${page.headings.slice(0, 20).join(' | ') || 'Not found'}`,
    );
    lines.push('', '### Excerpt', '', page.excerpt || 'Not found', '');
    if (Object.keys(page.sectionExcerpts).length > 0) {
      lines.push('### Matched Sections', '');
      for (const [keyword, excerpt] of Object.entries(page.sectionExcerpts)) {
        lines.push(`- ${keyword}: ${excerpt}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderPrIndex(items: PrIndexItem[]): string {
  const lines = ['# Pull Request Index', ''];
  if (items.length === 0) {
    lines.push('No pull requests found.');
    return `${lines.join('\n')}\n`;
  }
  for (const pr of items) {
    lines.push(`## PR ${pr.id}: ${pr.title}`, '');
    lines.push(`- Repository: ${pr.repository}`);
    lines.push(`- Status: ${pr.status}`);
    lines.push(`- Source branch: ${pr.sourceBranch}`);
    lines.push(`- Target branch: ${pr.targetBranch}`);
    lines.push(`- Work items: ${pr.linkedWorkItemIds.join(', ')}`);
    lines.push(`- Activities: ${pr.linkedActivities.join(', ')}`);
    lines.push(`- Priority: ${pr.priority}`);
    lines.push(`- Files changed: ${pr.changesSummary.totalChangedFiles}`);
    lines.push(
      `- Top directories: ${pr.changesSummary.topLevelDirectories.join(', ')}`,
    );
    lines.push(`- Categories: ${formatRecord(pr.changesSummary.categories)}`);
    lines.push(`- Signals: ${pr.changesSummary.signals.join(', ')}`);
    lines.push(`- Comments: ${pr.commentsSummary.count}`);
    lines.push(
      `- Comment statuses: ${formatRecord(pr.commentsSummary.statusCounts)}`,
    );
    lines.push(`- Checks: ${formatRecord(pr.checksSummary.statusCounts)}`);
    lines.push(
      '',
      '### Description Excerpt',
      '',
      pr.descriptionExcerpt || 'Not found',
      '',
    );
    if (pr.changesSummary.files.length > 0) {
      lines.push('### Changed Files', '');
      for (const file of pr.changesSummary.files) {
        lines.push(`- ${file} (${classifyChangedFile(file)})`);
      }
      lines.push('');
    }
    if (pr.commentsSummary.importantComments.length > 0) {
      lines.push('### Important Comments', '');
      for (const comment of pr.commentsSummary.importantComments) {
        lines.push(`- ${comment}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderCommitsCompact(compact: CommitsCompact): string {
  const lines = ['# Commits Compact', ''];
  lines.push(`- Total commit count: ${compact.totalCommitCount}`);
  lines.push(
    `- Repositories: ${compact.repositories.join(', ') || 'Not found'}`,
  );
  lines.push(
    `- Source work items: ${compact.sourceWorkItemIds.join(', ') || 'Not found'}`,
  );
  lines.push(
    `- Activities: ${compact.sourceWorkItemActivities.join(', ') || 'Not found'}`,
  );
  lines.push(
    `- Low-quality commit messages: ${compact.lowQualityCommitMessagesCount}`,
    '',
    '## Groups',
    '',
  );
  for (const [category, messages] of Object.entries(
    compact.groupedCommitMessages,
  )) {
    lines.push(`### ${category}`, '');
    for (const message of messages) {
      lines.push(`- ${message || 'Not found'}`);
    }
    lines.push('');
  }
  lines.push('## Sample Commits', '');
  for (const commit of compact.sampleCommits) {
    lines.push(
      `- ${commit.hash} | ${commit.repository ?? 'Unknown'} | ${commit.category} | ${commit.comment ?? ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderAnalysisInput(
  manifest: Manifest,
  workItems: WorkItemsCompact,
  wikiPages: WikiIndexPage[],
  pullRequests: PrIndexItem[],
  commits: CommitsCompact,
): string {
  const lines = [
    '# Compact Analysis Input',
    '',
    'Use only files in `output/analysis/` unless a compact file explicitly points to a small source excerpt. Do not read raw JSON, full PR diffs/comments, full wiki pages, `commits.md`, or `links/extracted-links.md` into model context.',
    'Do not invent missing facts. Mark missing or uncertain data as `not found` or `uncertain`.',
    'Context references are text-only. PR/commits/checks are collected only for root and direct child work items.',
    '',
    '## Root Summary',
    '',
    `- ID: ${workItems.root.id}`,
    `- Type: ${workItems.root.type}`,
    `- Title: ${workItems.root.title}`,
    `- State: ${workItems.root.state}`,
    `- Description: ${workItems.root.descriptionExcerpt || 'Not found'}`,
    `- Acceptance Criteria: ${workItems.root.acceptanceCriteriaExcerpt || 'Not found'}`,
    '',
    '## Activity Overview',
    '',
  ];
  for (const [activity, items] of Object.entries(workItems.activities)) {
    lines.push(`- ${activity}: ${items.length}`);
  }
  lines.push('', '## Development Details', '');
  const development = workItems.activities.Development ?? [];
  if (development.length === 0) {
    lines.push('Development activity not found.');
  } else {
    for (const item of development.slice(0, 30)) {
      lines.push(`### ${item.id}: ${item.title}`, '');
      lines.push(`- State: ${item.state}`);
      lines.push(`- Description: ${item.descriptionExcerpt || 'Not found'}`);
      lines.push(
        `- Acceptance Criteria: ${item.acceptanceCriteriaExcerpt || 'Not found'}`,
      );
      lines.push(
        `- PRs: ${item.linkedPullRequestIds.join(', ') || 'Not found'}`,
      );
      lines.push('');
    }
  }
  lines.push('## High Priority Wiki Docs', '');
  for (const page of wikiPages
    .filter((page) => page.priority === 'high')
    .slice(0, 20)) {
    lines.push(
      `- ${page.title} | ${page.documentType} | ${page.path} | \`${page.file}\``,
    );
  }
  lines.push('', '## Pull Request Overview', '');
  for (const pr of pullRequests.slice(0, 40)) {
    lines.push(
      `- PR ${pr.id} | ${pr.repository} | ${pr.status} | ${pr.priority} | files=${pr.changesSummary.totalChangedFiles} | ${pr.title}`,
    );
  }
  lines.push('', '## Commits Overview', '');
  lines.push(`- Total: ${commits.totalCommitCount}`);
  lines.push(
    `- Repositories: ${commits.repositories.join(', ') || 'Not found'}`,
  );
  lines.push(
    `- Activities: ${commits.sourceWorkItemActivities.join(', ') || 'Not found'}`,
  );
  lines.push('', '## Warnings / Errors', '');
  for (const warning of manifest.warnings) {
    lines.push(`- Warning: ${truncateText(warning.message, 300)}`);
  }
  for (const error of manifest.errors) {
    lines.push(`- Error: ${truncateText(error.message, 300)}`);
  }
  if (manifest.warnings.length === 0 && manifest.errors.length === 0) {
    lines.push('- None');
  }
  lines.push('', '## Compact Sources', '');
  lines.push('- `output/analysis/01-work-items-compact.md`');
  lines.push('- `output/analysis/02-wiki-index.md`');
  lines.push('- `output/analysis/03-pr-index.md`');
  lines.push('- `output/analysis/04-commits-compact.md`');
  return `${lines.join('\n')}\n`;
}

function extractWorkItemSections(text: string): {
  description: string;
  acceptanceCriteria: string;
  relations: string[];
} {
  return {
    description: sectionBetween(text, '## Description'),
    acceptanceCriteria: sectionBetween(text, '## Acceptance Criteria'),
    relations: sectionBetween(text, '## Relations')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .slice(0, 30),
  };
}

function sectionBetween(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const afterHeading = text.slice(start + heading.length);
  const nextHeading = afterHeading.search(/\n##\s+/);
  return (
    nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading
  ).trim();
}

function extractBulletValue(text: string, label: string): string {
  return truncateText(
    text.match(new RegExp(`^- ${label}: (.+)$`, 'im'))?.[1] ?? '',
    200,
  );
}

function detectPrPriority(
  pullRequest: ManifestPullRequest,
): 'high' | 'medium' | 'low' {
  if (
    pullRequest.sourceWorkItemActivities.some((activity) =>
      activity.toLowerCase().includes('development'),
    )
  ) {
    return 'high';
  }
  return pullRequest.sourceWorkItemIds.length > 0 ? 'medium' : 'low';
}

function pushWorkItem(
  lines: string[],
  item: CompactWorkItem,
  contextReference: boolean = false,
): void {
  lines.push(`### ${item.id}: ${item.title}`, '');
  lines.push(`- Type: ${item.type}`);
  lines.push(`- State: ${item.state}`);
  lines.push(`- Assigned To: ${item.assignedTo ?? 'Unknown'}`);
  lines.push(`- Activity: ${item.activity ?? 'Unknown'}`);
  lines.push(`- Source file: \`${item.sourceFile ?? ''}\``);
  if (contextReference) {
    lines.push(`- Relation type: ${item.relationType ?? 'Unknown'}`);
    lines.push(`- Source work item: ${item.sourceWorkItemId ?? 'Unknown'}`);
  }
  lines.push(`- PRs: ${item.linkedPullRequestIds.join(', ') || 'Not found'}`);
  lines.push(`- Commits: ${item.linkedCommitHashes.join(', ') || 'Not found'}`);
  lines.push(`- Wiki links: ${item.linkedWikiLinks.length}`);
  lines.push(
    '',
    '#### Description Excerpt',
    '',
    item.descriptionExcerpt || 'Not found',
  );
  lines.push(
    '',
    '#### Acceptance Criteria Excerpt',
    '',
    item.acceptanceCriteriaExcerpt || 'Not found',
  );
}

function countMatches(text: string, pattern: RegExp): Record<string, number> {
  const result: Record<string, number> = {};
  for (const match of text.matchAll(pattern)) {
    const key = truncateText(match[1] ?? 'unknown', 80).toLowerCase();
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function stripBoilerplate(text: string): string {
  return text
    .replace(/^#.+$/gim, '')
    .replace(/^## Thread .+$/gim, '')
    .replace(/^- Author:.+$/gim, '')
    .replace(/^- Date:.+$/gim, '')
    .replace(/^- Status:.+$/gim, '')
    .trim();
}

function formatRecord(record: Record<string, number>): string {
  return (
    Object.entries(record)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ') || 'Not found'
  );
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [
    ...new Set(values.filter((value): value is number => value !== undefined)),
  ];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ].sort();
}
