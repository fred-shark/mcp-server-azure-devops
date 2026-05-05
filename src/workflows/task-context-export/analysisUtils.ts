import { createReadStream } from 'fs';
import { open, stat } from 'fs/promises';
import { createInterface } from 'readline';

export interface ChangedFilesSummary {
  totalChangedFiles: number;
  files: string[];
  topLevelDirectories: string[];
  categories: Record<string, number>;
  signals: string[];
}

export type CommitMessageCategory =
  | 'feature implementation'
  | 'bug fix'
  | 'tests'
  | 'refactoring'
  | 'configuration'
  | 'database/migrations'
  | 'documentation'
  | 'merge'
  | 'unclear';

export function truncateText(value: unknown, limit: number): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value)
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export async function safeReadTextExcerpt(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  try {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

export function extractMarkdownHeadings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 80);
}

export function extractSectionExcerpts(
  text: string,
  sectionKeywords: string[],
  maxChars: number,
): Record<string, string> {
  const lower = text.toLowerCase();
  const result: Record<string, string> = {};

  for (const keyword of sectionKeywords) {
    const index = lower.indexOf(keyword.toLowerCase());
    if (index >= 0) {
      result[keyword] = truncateText(
        text.slice(index, index + maxChars),
        maxChars,
      );
    }
  }

  return result;
}

export async function summarizeChangedFilesFromDiffOrMarkdown(
  filePath: string,
  maxFiles: number = 100,
): Promise<ChangedFilesSummary> {
  const files = new Set<string>();
  const signals = new Set<string>();
  let rl;
  try {
    rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return emptyChangedFilesSummary();
  }

  try {
    for await (const line of rl) {
      const pathFromHeading = line.match(/^##\s+(.+)$/)?.[1];
      const pathFromDiff = line.match(/^diff --git a\/(.+?) b\/(.+)$/)?.[2];
      const changedPath = normalizeChangedPath(pathFromHeading ?? pathFromDiff);
      if (changedPath) {
        files.add(changedPath);
      }
      detectSignals(line).forEach((signal) => signals.add(signal));
    }
  } catch {
    return emptyChangedFilesSummary();
  }

  const fileList = [...files];
  const topLevelDirectories = [
    ...new Set(
      fileList.map((file) => file.split('/').filter(Boolean)[0] ?? file),
    ),
  ].sort();
  const categories = fileList.reduce<Record<string, number>>((acc, file) => {
    const category = classifyChangedFile(file);
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});

  return {
    totalChangedFiles: fileList.length,
    files: fileList.slice(0, maxFiles),
    topLevelDirectories,
    categories,
    signals: [...signals].sort(),
  };
}

function emptyChangedFilesSummary(): ChangedFilesSummary {
  return {
    totalChangedFiles: 0,
    files: [],
    topLevelDirectories: [],
    categories: {},
    signals: [],
  };
}

export function classifyChangedFile(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (/\.(test|spec)\.|(^|\/)tests?\//.test(lower)) return 'tests';
  if (/migration|migrations|\.sql$|database|db\//.test(lower)) {
    return 'db/migrations';
  }
  if (/\.ya?ml$|\.json$|appsettings|config|\.config$/.test(lower)) {
    return 'config';
  }
  if (/docker|helm|charts?|deploy|k8s|pipeline/.test(lower)) {
    return 'deployment';
  }
  if (/readme|docs?\/|\.md$/.test(lower)) return 'docs';
  if (/\.(tsx|jsx|vue|scss|css|html)$|frontend|client|ui\//.test(lower)) {
    return 'frontend';
  }
  if (/\.(cs|java|kt|go|py|ts|js)$|api|server|service|controller/.test(lower)) {
    return 'backend';
  }
  return 'unknown';
}

export function classifyCommitMessage(message: string): CommitMessageCategory {
  const lower = message.toLowerCase();
  if (/^merge\b|merge branch|merge pull request/.test(lower)) return 'merge';
  if (/fix|bug|исправ/.test(lower)) return 'bug fix';
  if (/test|spec|тест/.test(lower)) return 'tests';
  if (/refactor|cleanup|рефактор/.test(lower)) return 'refactoring';
  if (/config|settings|appsettings|yaml|yml|конфиг/.test(lower)) {
    return 'configuration';
  }
  if (/migration|sql|database|db|миграц/.test(lower)) {
    return 'database/migrations';
  }
  if (/doc|readme|докум/.test(lower)) return 'documentation';
  if (/add|implement|feature|добав|реализ/.test(lower)) {
    return 'feature implementation';
  }
  return 'unclear';
}

export function detectDocumentType(
  title: string,
  path: string,
  file: string,
  headings: string[] = [],
): string {
  const haystack =
    `${title} ${path} ${file} ${headings.join(' ')}`.toLowerCase();
  if (haystack.includes('техническое задание') || /\bтз\b/.test(haystack)) {
    return 'техническое задание';
  }
  if (haystack.includes('техническое решение')) return 'техническое решение';
  if (haystack.includes('архитектурное решение'))
    return 'архитектурное решение';
  if (haystack.includes('adr')) return 'ADR';
  if (haystack.includes('инструкция')) return 'инструкция';
  return 'прочее';
}

export function detectWikiPriority(input: {
  documentType: string;
  sourceWorkItemIds: number[];
  developmentWorkItemIds: number[];
  rootWorkItemId: number;
}): 'high' | 'medium' | 'low' {
  if (
    [
      'техническое задание',
      'техническое решение',
      'архитектурное решение',
      'ADR',
    ].includes(input.documentType)
  ) {
    return 'high';
  }
  if (
    input.sourceWorkItemIds.includes(input.rootWorkItemId) ||
    input.sourceWorkItemIds.some((id) =>
      input.developmentWorkItemIds.includes(id),
    )
  ) {
    return 'high';
  }
  return input.sourceWorkItemIds.length > 0 ? 'medium' : 'low';
}

function normalizeChangedPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'Pull Request Changes') return undefined;
  return trimmed.replace(/^a\//, '').replace(/^b\//, '');
}

function detectSignals(line: string): string[] {
  const lower = line.toLowerCase();
  const signals: string[] = [];
  if (/controller|api|endpoint|route/.test(lower))
    signals.push('controller/api/endpoint');
  if (/dto|contract|schema|request|response/.test(lower))
    signals.push('dto/contract');
  if (/migration|sql|database|db/.test(lower)) signals.push('migration/sql/db');
  if (/test|spec/.test(lower)) signals.push('test/spec');
  if (/pipeline|\.ya?ml|azure-pipelines/.test(lower))
    signals.push('pipeline/yaml');
  if (/appsettings|config|settings/.test(lower))
    signals.push('config/appsettings');
  return signals;
}
