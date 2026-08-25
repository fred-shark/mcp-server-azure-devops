import { WorkItem } from '../../features/work-items';
import { createHash } from 'crypto';
import {
  CommitArtifact,
  ExtractedLink,
  Manifest,
  PullRequestArtifact,
  WikiArtifact,
} from './types';

export function safeFileName(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\wа-яА-ЯёЁ.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'unknown';
}

export function safeBoundedFileName(
  value: string,
  maxLength: number = 96,
): string {
  const safe = safeFileName(value);
  if (safe.length <= maxLength) {
    return safe;
  }

  const hash = createHash('sha1').update(value).digest('hex').slice(0, 10);
  const prefixLength = Math.max(1, maxLength - hash.length - 1);
  return `${safe.slice(0, prefixLength).replace(/-+$/g, '')}-${hash}`;
}

export function compactWorkItemType(type: string): string {
  return safeFileName(type.replace(/\s+/g, ''));
}

export function renderWorkItemMarkdown(workItem: WorkItem): string {
  const fields = workItem.fields ?? {};
  const lines = [
    `# ${fieldString(fields, 'System.WorkItemType', 'Work Item')} ${workItem.id ?? ''}: ${fieldString(fields, 'System.Title', 'Untitled')}`,
    '',
    `- ID: ${workItem.id ?? 'unknown'}`,
    `- Type: ${fieldString(fields, 'System.WorkItemType', 'Unknown')}`,
    `- State: ${fieldString(fields, 'System.State', 'Unknown')}`,
    `- Assigned To: ${identityToString(fields['System.AssignedTo'])}`,
    `- Activity: ${fieldString(fields, 'Microsoft.VSTS.Common.Activity', 'Unknown')}`,
    `- Area Path: ${fieldString(fields, 'System.AreaPath', 'Unknown')}`,
    `- Iteration Path: ${fieldString(fields, 'System.IterationPath', 'Unknown')}`,
    '',
    '## Description',
    '',
    htmlToMarkdown(fieldString(fields, 'System.Description', 'Not found')),
    '',
    '## Acceptance Criteria',
    '',
    htmlToMarkdown(
      fieldString(
        fields,
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'Not found',
      ),
    ),
    '',
    '## Relations',
    '',
  ];

  const relations = workItem.relations ?? [];
  if (relations.length === 0) {
    lines.push('Not found');
  } else {
    for (const relation of relations) {
      lines.push(
        `- ${relation.rel ?? 'unknown'}: ${relation.url ?? 'unknown'}${relation.attributes?.name ? ` (${relation.attributes.name})` : ''}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function renderLinksMarkdown(links: ExtractedLink[]): string {
  const lines = ['# Extracted Links', ''];
  if (links.length === 0) {
    lines.push('No links found.');
    return `${lines.join('\n')}\n`;
  }

  for (const link of links) {
    lines.push(
      `- ${link.kind}: ${link.url} (source: ${link.source}${link.sourceWorkItemId ? `, work item: ${link.sourceWorkItemId}` : ''})`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderPullRequestMarkdown(
  artifact: PullRequestArtifact,
): string {
  const raw = asRecord(artifact.raw);
  const lines = [
    `# Pull Request ${artifact.id}: ${stringValue(raw.title, 'Untitled')}`,
    '',
    `- Repository: ${artifact.repositoryName ?? artifact.repositoryId ?? 'Unknown'}`,
    `- Status: ${stringValue(raw.status, 'Unknown')}`,
    `- Source Branch: ${stringValue(raw.sourceRefName, 'Unknown')}`,
    `- Target Branch: ${stringValue(raw.targetRefName, 'Unknown')}`,
    `- Created By: ${identityToString(raw.createdBy)}`,
    `- Creation Date: ${stringValue(raw.creationDate, 'Unknown')}`,
    `- Source Work Items: ${artifact.sources.map((source) => source.sourceWorkItemId).join(', ')}`,
    '',
    '## Description',
    '',
    stringValue(raw.description, 'Not found'),
  ];

  return `${lines.join('\n')}\n`;
}

export function renderPullRequestCommentsMarkdown(comments: unknown): string {
  const lines = ['# Pull Request Comments', ''];
  const threads = Array.isArray(comments) ? comments : [];
  if (threads.length === 0) {
    lines.push('No comments found or comments were not collected.');
    return `${lines.join('\n')}\n`;
  }

  for (const thread of threads) {
    const threadRecord = asRecord(thread);
    lines.push(`## Thread ${stringValue(threadRecord.id, 'unknown')}`);
    lines.push(`- Status: ${stringValue(threadRecord.status, 'unknown')}`);
    const threadComments = Array.isArray(threadRecord.comments)
      ? threadRecord.comments
      : [];
    for (const comment of threadComments) {
      const commentRecord = asRecord(comment);
      lines.push('');
      lines.push(`### Comment ${stringValue(commentRecord.id, 'unknown')}`);
      lines.push(`- Author: ${identityToString(commentRecord.author)}`);
      lines.push(
        `- Date: ${stringValue(commentRecord.publishedDate, 'unknown')}`,
      );
      lines.push('');
      lines.push(stringValue(commentRecord.content, ''));
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function renderPullRequestChangesMarkdown(changes: unknown): string {
  const record = asRecord(changes);
  const files = Array.isArray(record.files) ? record.files : [];
  const lines = ['# Pull Request Changes', ''];
  if (files.length === 0) {
    lines.push('No file changes found or changes were not collected.');
    return `${lines.join('\n')}\n`;
  }
  for (const file of files) {
    const fileRecord = asRecord(file);
    lines.push(`## ${stringValue(fileRecord.path, 'unknown')}`);
    lines.push('');
    lines.push('```diff');
    lines.push(stringValue(fileRecord.patch, ''));
    lines.push('```');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderChecksMarkdown(checks: unknown): string {
  const record = asRecord(checks);
  const statuses = Array.isArray(record.statuses) ? record.statuses : [];
  const policies = Array.isArray(record.policyEvaluations)
    ? record.policyEvaluations
    : [];
  const lines = ['# Pull Request Checks', '', '## Statuses', ''];
  if (statuses.length === 0) {
    lines.push('No statuses found.');
  } else {
    for (const status of statuses) {
      const item = asRecord(status);
      lines.push(
        `- ${stringValue(asRecord(item.context).name, 'unknown')}: ${stringValue(item.state, 'unknown')} - ${stringValue(item.description, '')}`,
      );
    }
  }
  lines.push('', '## Policy Evaluations', '');
  if (policies.length === 0) {
    lines.push('No policy evaluations found.');
  } else {
    for (const policy of policies) {
      const item = asRecord(policy);
      lines.push(
        `- ${stringValue(item.displayName, 'unknown')}: ${stringValue(item.status, 'unknown')} - ${stringValue(item.message, '')}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderCommitsMarkdown(commits: CommitArtifact[]): string {
  const lines = ['# Commits', ''];
  if (commits.length === 0) {
    lines.push('No commits found.');
    return `${lines.join('\n')}\n`;
  }

  for (const commit of commits) {
    const raw = asRecord(commit.raw);
    lines.push(`## ${commit.hash}`);
    lines.push(
      `- Repository: ${commit.repositoryName ?? commit.repositoryId ?? 'Unknown'}`,
    );
    lines.push(`- Comment: ${stringValue(raw.comment, 'Not found')}`);
    lines.push(`- Author: ${identityToString(raw.author)}`);
    lines.push(
      `- Source Work Items: ${commit.sources.map((source) => source.sourceWorkItemId).join(', ')}`,
    );
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function renderWikiIndexMarkdown(wikis: WikiArtifact[]): string {
  const lines = ['# Wiki Pages', ''];
  if (wikis.length === 0) {
    lines.push('No wiki pages found or wiki collection was unavailable.');
  } else {
    for (const wiki of wikis) {
      lines.push(`- ${wiki.title}: ${wiki.path} (${wiki.source})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderReadme(manifest: Manifest): string {
  const activities = Object.keys(manifest.workItems.activities);
  const lines = [
    `# Evidence pack for work item ${manifest.rootWorkItemId}`,
    '',
    `Collected project: ${manifest.project}`,
    `Root title: ${manifest.rootWorkItemTitle}`,
    `Generated at: ${manifest.generatedAt}`,
    '',
    '## Files',
    '',
    '- `manifest.json` is the main index.',
    '- `work-items/` contains normalized markdown and raw work item JSON.',
    '- `links/` contains extracted links.',
    '- `pull-requests/`, `commits/`, and `wiki/` contain related artifacts when available.',
    '- `prompts/summarize-task.prompt.md` contains a prompt template for the next AI analysis step.',
    '',
    '## Activities',
    '',
    activities.length > 0
      ? activities.map((activity) => `- ${activity}`).join('\n')
      : 'Not found',
    '',
    '## Warnings',
    '',
    manifest.warnings.length > 0
      ? manifest.warnings.map((warning) => `- ${warning.message}`).join('\n')
      : 'None',
    '',
    '## Errors',
    '',
    manifest.errors.length > 0
      ? manifest.errors.map((error) => `- ${error.message}`).join('\n')
      : 'None',
    '',
    '## Next step',
    '',
    'Use an AI tool with `manifest.json` as the main index and `prompts/summarize-task.prompt.md` as the instruction template. This collector does not generate `summary.md`.',
  ];

  return `${lines.join('\n')}\n`;
}

export function renderSummaryPrompt(): string {
  return `# Task evidence pack summarization prompt

Read \`manifest.json\` as the main index. Use only facts from this evidence pack. Do not invent missing details. Mark missing or ambiguous information as \`not found\` or \`uncertain\`.

Distinguish scope work items (root + direct children) from context references. Do not infer PR/commit/check behavior from context references, because the collector intentionally does not collect those artifacts for them.

Use Activity grouping from the manifest. Analyze Activity = Development in extra detail when present. Keep other activities concise unless the evidence pack clearly indicates they are important.

Produce \`summary.md\` with this structure:

# Summary по задаче

## Что было сделано

## Почему это было сделано

## Затронутые системы и репозитории

## Изменения API / контрактов

## Изменения БД / миграции

## Основные PR и commits

## Важные обсуждения из PR

## Ссылки на Wiki / ТЗ / техническое решение

## Информация по Activity

### Development

### UI Development

### Testing

### Deployment

### Other / Unknown

## Риски и backward compatibility

## Что стоит сохранить в долгоживущую базу знаний
`;
}

export function htmlToMarkdown(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function fieldString(
  fields: Record<string, unknown>,
  fieldName: string,
  fallback: string,
): string {
  return stringValue(fields[fieldName], fallback);
}

export function stringValue(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function identityToString(value: unknown): string {
  if (!value) {
    return 'Unassigned';
  }
  if (typeof value === 'string') {
    return value;
  }
  const record = asRecord(value);
  return (
    stringValue(record.displayName, '') ||
    stringValue(record.uniqueName, '') ||
    stringValue(record.name, '') ||
    JSON.stringify(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
