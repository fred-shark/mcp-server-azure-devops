import { access } from 'fs/promises';
import path from 'path';
import { Manifest } from './types';
import { writeJsonFile, writeMarkdownFile } from './fileWriters';

interface InventoryWorkItem {
  id?: number;
  type: string;
  title: string;
  state: string;
  activity?: string;
  file?: string;
  rawFile?: string;
  fullCollection?: boolean;
  relationType?: string;
  sourceWorkItemId?: number;
}

interface InventoryWikiPage {
  title: string;
  path: string;
  file?: string;
  source: string;
  sourceWorkItemIds: number[];
  documentTypeCandidates: string[];
}

interface InventoryPullRequest {
  id: number;
  repository: string;
  title: string;
  status: string;
  sourceWorkItemIds: number[];
  sourceWorkItemActivities: string[];
  file?: string;
  hasComments: boolean;
  hasChanges: boolean;
  hasChecks: boolean;
}

export interface CompactInventory {
  root: InventoryWorkItem;
  activities: Record<string, InventoryWorkItem[]>;
  contextReferences: InventoryWorkItem[];
  wikiPages: InventoryWikiPage[];
  pullRequests: InventoryPullRequest[];
  commits: {
    count: number;
    repositories: string[];
    activities: string[];
    file: string | null;
  };
  linksCount: number;
  warnings: string[];
  errors: string[];
  largeFiles: string[];
  suggestedNextSteps: string[];
}

const wikiDocumentKeywords = [
  'тз',
  'техническое задание',
  'техническое решение',
  'архитектурное решение',
  'adr',
];

const suggestedNextSteps = [
  '01-work-items.md',
  '02-wiki.md',
  '03-pull-requests.md',
  '04-commits-and-checks.md',
  '05-risks-and-knowledge.md',
  'summary.md',
];

export async function writeCompactInventory(
  outputDir: string,
  manifest: Manifest,
): Promise<void> {
  const inventory = await buildCompactInventory(outputDir, manifest);
  await writeJsonFile(
    outputDir,
    'output/analysis/00-inventory.json',
    inventory,
  );
  await writeMarkdownFile(
    outputDir,
    'output/analysis/00-inventory.md',
    renderInventoryMarkdown(inventory),
  );
}

export async function buildCompactInventory(
  outputDir: string,
  manifest: Manifest,
): Promise<CompactInventory> {
  const root = toInventoryWorkItem(manifest.workItems.root);
  const activities: Record<string, InventoryWorkItem[]> = {};
  for (const [activityName, items] of Object.entries(
    manifest.workItems.activities,
  )) {
    activities[activityName] = items.map(toInventoryWorkItem);
  }

  const pullRequests = await Promise.all(
    manifest.pullRequests.map(async (pullRequest) => {
      const file = pullRequest.file;
      return {
        id: pullRequest.id,
        repository: short(pullRequest.repository ?? pullRequest.repositoryId),
        title: short(pullRequest.title),
        status: short(pullRequest.status),
        sourceWorkItemIds: pullRequest.sourceWorkItemIds,
        sourceWorkItemActivities: pullRequest.sourceWorkItemActivities,
        file,
        hasComments:
          Boolean(pullRequest.commentsFile) ||
          (await siblingExists(outputDir, file, 'comments.md')),
        hasChanges:
          Boolean(pullRequest.changesFile) ||
          (await siblingExists(outputDir, file, 'changes.md')),
        hasChecks:
          Boolean(pullRequest.checksFile) ||
          (await siblingExists(outputDir, file, 'checks.md')),
      };
    }),
  );

  const commitRepositories = sortedUnique(
    manifest.commits.map((commit) => short(commit.repository)),
  );
  const commitActivities = sortedUnique(
    manifest.commits.flatMap((commit) => commit.sourceWorkItemActivities),
  );

  return {
    root,
    activities,
    contextReferences:
      manifest.workItems.contextReferences.map(toInventoryWorkItem),
    wikiPages: manifest.wikiPages.map((page) => {
      const haystack = `${page.title} ${page.path} ${page.file}`.toLowerCase();
      return {
        title: short(page.title),
        path: short(page.path, 240),
        file: page.file,
        source: page.source,
        sourceWorkItemIds: page.sourceWorkItemIds,
        documentTypeCandidates: wikiDocumentKeywords.filter((keyword) =>
          haystack.includes(keyword),
        ),
      };
    }),
    pullRequests,
    commits: {
      count: manifest.commits.length,
      repositories: commitRepositories,
      activities: commitActivities,
      file: (await fileExists(outputDir, 'commits/commits.md'))
        ? 'commits/commits.md'
        : null,
    },
    linksCount: manifest.links.length,
    warnings: manifest.warnings.map((warning) => shortIssue(warning)),
    errors: manifest.errors.map((error) => shortIssue(error)),
    largeFiles: listLargeFilePatterns(manifest),
    suggestedNextSteps,
  };
}

function renderInventoryMarkdown(inventory: CompactInventory): string {
  const lines: string[] = [];
  lines.push('# Inventory', '');
  lines.push('## Root work item', '');
  lines.push(`- ID: ${inventory.root.id ?? ''}`);
  lines.push(`- Type: ${inventory.root.type}`);
  lines.push(`- Title: ${inventory.root.title}`);
  lines.push(`- State: ${inventory.root.state}`);
  lines.push(`- File: \`${inventory.root.file ?? ''}\``);
  lines.push(`- Raw file: \`${inventory.root.rawFile ?? ''}\``, '');

  lines.push('## Activity groups', '');
  for (const [activityName, items] of Object.entries(inventory.activities)) {
    const marker =
      activityName === 'Development' ? ' **MAIN BACKEND ACTIVITY**' : '';
    lines.push(`### ${activityName}${marker}`, '');
    lines.push(`- Count: ${items.length}`, '');
    for (const item of items) {
      lines.push(
        `- ${item.id ?? ''} | ${item.type} | ${item.state} | fullCollection=${Boolean(item.fullCollection)} | ${item.title} | \`${item.file ?? ''}\``,
      );
    }
    lines.push('');
  }

  lines.push('## Context references', '');
  if (inventory.contextReferences.length === 0) {
    lines.push('Не найдено в evidence pack.');
  } else {
    for (const item of inventory.contextReferences) {
      lines.push(
        `- ${item.id ?? ''} | ${item.type} | ${item.state} | relation=${item.relationType ?? ''} | source=${item.sourceWorkItemId ?? ''} | ${item.title} | \`${item.file ?? ''}\``,
      );
    }
  }
  lines.push('');

  lines.push('## Wiki pages', '');
  if (inventory.wikiPages.length === 0) {
    lines.push('Не найдено в evidence pack.');
  } else {
    lines.push('| Title | Path | Source | Type candidates | File |');
    lines.push('|---|---|---|---|---|');
    for (const page of inventory.wikiPages) {
      lines.push(
        `| ${page.title} | ${page.path} | ${page.source} | ${page.documentTypeCandidates.join(', ')} | \`${page.file ?? ''}\` |`,
      );
    }
  }
  lines.push('');

  lines.push('## Pull Requests', '');
  if (inventory.pullRequests.length === 0) {
    lines.push('Не найдено в evidence pack.');
  } else {
    lines.push(
      '| PR | Repository | Status | Activities | Work items | Files | Title |',
    );
    lines.push('|---|---|---|---|---|---|---|');
    for (const pullRequest of inventory.pullRequests) {
      const files = [
        pullRequest.hasComments ? 'comments' : '',
        pullRequest.hasChanges ? 'changes' : '',
        pullRequest.hasChecks ? 'checks' : '',
      ].filter(Boolean);
      lines.push(
        `| ${pullRequest.id} | ${pullRequest.repository} | ${pullRequest.status} | ${pullRequest.sourceWorkItemActivities.join(', ')} | ${pullRequest.sourceWorkItemIds.join(', ')} | ${files.join(', ')} | ${pullRequest.title} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Commits', '');
  lines.push(`- Count: ${inventory.commits.count}`);
  lines.push(
    `- Repositories: ${inventory.commits.repositories.join(', ') || 'Не найдено в evidence pack'}`,
  );
  lines.push(
    `- Activities: ${inventory.commits.activities.join(', ') || 'Не найдено в evidence pack'}`,
  );
  lines.push(`- File: \`${inventory.commits.file ?? ''}\``, '');

  lines.push('## Warnings / errors', '');
  if (inventory.warnings.length === 0) {
    lines.push('- Warnings: none');
  } else {
    lines.push('### Warnings');
    for (const warning of inventory.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (inventory.errors.length === 0) {
    lines.push('- Errors: none');
  } else {
    lines.push('', '### Errors');
    for (const error of inventory.errors) {
      lines.push(`- ${error}`);
    }
  }
  lines.push('');

  lines.push('## Large files', '');
  lines.push('Do not read these files fully into model context:');
  for (const file of inventory.largeFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push('');

  lines.push('## Suggested analysis order', '');
  inventory.suggestedNextSteps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });
  lines.push('', '## Sources used', '', '- `manifest.json`');
  lines.push('- filesystem existence checks for PR sibling files', '');

  return `${lines.join('\n')}\n`;
}

function toInventoryWorkItem(item: {
  id?: number;
  type?: string;
  title?: string;
  state?: string;
  activity?: string;
  file?: string;
  rawFile?: string;
  fullCollection?: boolean;
  relationType?: string;
  sourceWorkItemId?: number;
}): InventoryWorkItem {
  return {
    id: item.id,
    type: short(item.type),
    title: short(item.title),
    state: short(item.state),
    activity: short(item.activity),
    file: item.file,
    rawFile: item.rawFile,
    fullCollection: item.fullCollection,
    relationType: short(item.relationType),
    sourceWorkItemId: item.sourceWorkItemId,
  };
}

function listLargeFilePatterns(manifest: Manifest): string[] {
  const files = new Set<string>([
    'manifest.json',
    'links/extracted-links.md',
    '**/raw/*.json',
    'pull-requests/**/changes.md',
    'pull-requests/**/comments.md',
    'commits/commits.md',
    'wiki/pages/*.md',
  ]);

  for (const pullRequest of manifest.pullRequests) {
    if (pullRequest.changesFile) {
      files.add(pullRequest.changesFile);
    }
    if (pullRequest.commentsFile) {
      files.add(pullRequest.commentsFile);
    }
    if (pullRequest.checksFile) {
      files.add(pullRequest.checksFile);
    }
  }

  for (const wikiPage of manifest.wikiPages) {
    files.add(wikiPage.file);
  }

  return [...files];
}

function shortIssue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const issue = value as {
      message?: unknown;
      source?: unknown;
      error?: unknown;
    };
    return short(
      [
        issue.source ? `[${String(issue.source)}]` : '',
        issue.message ? String(issue.message) : '',
        issue.error ? `(${String(issue.error)})` : '',
      ]
        .filter(Boolean)
        .join(' '),
      300,
    );
  }
  return short(value, 300);
}

function short(value: unknown, limit: number = 160): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function siblingExists(
  outputDir: string,
  filePath: string | undefined,
  siblingName: string,
): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  return fileExists(outputDir, path.join(path.dirname(filePath), siblingName));
}

async function fileExists(
  outputDir: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await access(path.join(outputDir, relativePath));
    return true;
  } catch {
    return false;
  }
}
