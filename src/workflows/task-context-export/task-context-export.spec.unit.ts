import { WorkItem } from '../../features/work-items';
import { PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  classifyChangedFile,
  classifyCommitMessage,
  detectDocumentType,
  safeReadTextExcerpt,
  summarizeChangedFilesFromDiffOrMarkdown,
} from './analysisUtils';
import { writeCompactAnalysisPack } from './compactAnalysis';
import {
  activityOf,
  classifyWorkItemRelations,
  collectTaskContext,
  collectWikiPages,
  defaultOutputDir,
  isRemovedWorkItem,
  shouldCollectPullRequest,
} from './collectTaskContext';
import { getWorkItem } from '../../features/work-items/get-work-item/feature';
import {
  getPullRequest,
  getPullRequestChanges,
  getPullRequestChecks,
  getPullRequestComments,
} from '../../features/pull-requests';
import { getWikiPage, listWikiPages } from '../../features/wikis';
import { resetOutputDirectory, writeCommits } from './fileWriters';
import { buildCompactInventory, writeCompactInventory } from './inventory';
import { extractLinksFromText } from './linkExtractors';
import { buildManifest, createWorkItemSummary } from './manifest';
import {
  renderWorkItemMarkdown,
  safeBoundedFileName,
  safeFileName,
} from './markdownRenderers';
import {
  CollectionIssue,
  CommitArtifact,
  ExtractedLink,
  PullRequestArtifact,
  TaskContextCollectOptions,
  WikiArtifact,
  WorkItemWithActivity,
} from './types';

jest.mock('../../features/wikis');
jest.mock('../../features/work-items/get-work-item/feature');
jest.mock('../../features/pull-requests');

describe('task context export workflow units', () => {
  const mockedGetWorkItem = getWorkItem as jest.MockedFunction<
    typeof getWorkItem
  >;
  const mockedGetPullRequest = getPullRequest as jest.MockedFunction<
    typeof getPullRequest
  >;
  const mockedGetPullRequestChanges =
    getPullRequestChanges as jest.MockedFunction<typeof getPullRequestChanges>;
  const mockedGetPullRequestChecks =
    getPullRequestChecks as jest.MockedFunction<typeof getPullRequestChecks>;
  const mockedGetPullRequestComments =
    getPullRequestComments as jest.MockedFunction<
      typeof getPullRequestComments
    >;
  const mockedGetWikiPage = getWikiPage as jest.MockedFunction<
    typeof getWikiPage
  >;
  const mockedListWikiPages = listWikiPages as jest.MockedFunction<
    typeof listWikiPages
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('extracts Azure DevOps pull request, commit, wiki, and external links', () => {
    const links = extractLinksFromText(
      [
        'https://dev.azure.com/org/project/_git/Service.Api/pullrequest/456',
        'https://dev.azure.com/org/project/_git/Service.Api/commit/abcdef1234567890',
        'https://dev.azure.com/org/project/_wiki/wikis/MyWiki/123/Technical-Solution',
        'https://example.com/spec',
      ].join(' '),
      'test',
      123,
    );

    expect(links.map((link) => link.kind)).toEqual([
      'pull-request',
      'commit',
      'wiki',
      'external',
    ]);
    expect(links[0].pullRequestId).toBe(456);
    expect(links[1].commitId).toBe('abcdef1234567890');
    expect(links[2].wikiId).toBe('MyWiki');
  });

  test('extracts TFS wiki UI links with page id and project context', () => {
    const [link] = extractLinksFromText(
      'https://tfs.rts-tender.ru/tfs/defaultcollection/RTS.Market/_wiki/wikis/RTS.MarketZmo.wiki/18550/Разработка.-Регламенты-и-правила-работы',
      'test',
      123,
    );

    expect(link.kind).toBe('wiki');
    expect(link.wikiOrganizationId).toBe('defaultcollection');
    expect(link.wikiProjectId).toBe('RTS.Market');
    expect(link.wikiId).toBe('RTS.MarketZmo.wiki');
    expect(link.wikiPageId).toBe(18550);
    expect(link.wikiPath).toBeUndefined();
  });

  test('extracts artifact links from work item relations and classifies scope', () => {
    const workItem = createWorkItem(100, {
      relations: [
        relation('System.LinkTypes.Hierarchy-Forward', 101),
        relation('System.LinkTypes.Hierarchy-Reverse', 99),
        relation('System.LinkTypes.Related', 500),
        {
          rel: 'ArtifactLink',
          url: 'vstfs:///Git/PullRequestId/project%2Frepo-id%2F77',
        },
      ],
    });

    const classified = classifyWorkItemRelations(workItem);

    expect(classified.directChildIds).toEqual([101]);
    expect(classified.contextReferenceIds).toEqual([
      {
        id: 500,
        relationType: 'System.LinkTypes.Related',
        sourceWorkItemId: 100,
      },
    ]);
    expect(classified.links.some((link) => link.pullRequestId === 77)).toBe(
      true,
    );
  });

  test('uses dynamic Activity with Unknown fallback', () => {
    expect(
      activityOf(
        createWorkItem(101, {
          fields: { 'Microsoft.VSTS.Common.Activity': 'Development' },
        }),
      ),
    ).toBe('Development');
    expect(activityOf(createWorkItem(102))).toBe('Unknown');
  });

  test('detects removed work items case-insensitively', () => {
    expect(
      isRemovedWorkItem(
        createWorkItem(101, {
          fields: { 'System.State': ' REMOVED ' },
        }),
      ),
    ).toBe(true);
    expect(isRemovedWorkItem(createWorkItem(102))).toBe(false);
  });

  test('collects only completed non-draft pull requests', () => {
    expect(
      shouldCollectPullRequest({ status: 'completed', isDraft: false }),
    ).toBe(true);
    expect(
      shouldCollectPullRequest({ status: PullRequestStatus.Completed }),
    ).toBe(true);
    expect(shouldCollectPullRequest({ status: 'Completed' })).toBe(true);
    expect(shouldCollectPullRequest({ status: 'active' })).toBe(false);
    expect(shouldCollectPullRequest({ status: PullRequestStatus.Active })).toBe(
      false,
    );
    expect(shouldCollectPullRequest({ status: 'abandoned' })).toBe(false);
    expect(
      shouldCollectPullRequest({ status: 'completed', isDraft: true }),
    ).toBe(false);
  });

  test('fails removed root work item before cleaning existing output', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      await writeFile(path.join(outputDir, 'manifest.json'), 'existing');
      mockedGetWorkItem.mockResolvedValue(
        createWorkItem(123, {
          fields: { 'System.State': 'Removed' },
        }),
      );

      await expect(
        collectTaskContext({
          ...taskContextOptions(),
          outputDir,
        }),
      ).rejects.toThrow('Work item 123 is Removed and cannot be collected');
      await expect(
        readFile(path.join(outputDir, 'manifest.json'), 'utf8'),
      ).resolves.toBe('existing');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('skips removed child work items and context references', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      const root = createWorkItem(123, {
        relations: [
          relation('System.LinkTypes.Hierarchy-Forward', 124),
          relation('System.LinkTypes.Related', 500),
        ],
      });
      const removedChild = createWorkItem(124, {
        fields: {
          'System.State': 'Removed',
          'System.Description':
            'https://dev.azure.com/org/project/_git/Repo/pullrequest/10',
        },
      });
      const removedReference = createWorkItem(500, {
        fields: { 'System.State': 'Removed' },
      });
      mockedGetWorkItem.mockImplementation(async (_connection, id) => {
        if (id === 123) {
          return root;
        }
        if (id === 124) {
          return removedChild;
        }
        if (id === 500) {
          return removedReference;
        }
        throw new Error(`Unexpected work item ${id}`);
      });

      const manifest = await collectTaskContext({
        ...taskContextOptions(),
        connection: taskContextConnection(),
        outputDir,
        includePrs: true,
      });

      expect(manifest.workItems.activities).toEqual({});
      expect(manifest.workItems.contextReferences).toEqual([]);
      expect(manifest.pullRequests).toEqual([]);
      expect(mockedGetPullRequest).not.toHaveBeenCalled();
      expect(manifest.warnings.map((warning) => warning.message)).toEqual([
        'Skipped removed work item 124',
        'Skipped removed work item 500',
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('skips active abandoned and draft pull requests before details collection', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      const root = createWorkItem(123, {
        fields: {
          'System.Description': [
            'https://dev.azure.com/org/project/_git/Repo/pullrequest/10',
            'https://dev.azure.com/org/project/_git/Repo/pullrequest/11',
            'https://dev.azure.com/org/project/_git/Repo/pullrequest/12',
            'https://dev.azure.com/org/project/_git/Repo/pullrequest/13',
          ].join(' '),
        },
      });
      mockedGetWorkItem.mockResolvedValue(root);
      mockedGetPullRequest.mockImplementation(async (_connection, options) => {
        const pullRequest = {
          pullRequestId: options.pullRequestId,
          repository: { id: 'repo', name: 'Repo' },
          title: `PR ${options.pullRequestId}`,
          status:
            options.pullRequestId === 10
              ? 'completed'
              : options.pullRequestId === 11
                ? 'active'
                : options.pullRequestId === 12
                  ? 'abandoned'
                  : 'completed',
          isDraft: options.pullRequestId === 13,
        };
        return pullRequest as unknown as Awaited<
          ReturnType<typeof getPullRequest>
        >;
      });
      mockedGetPullRequestChanges.mockResolvedValue({
        files: [],
      } as unknown as Awaited<ReturnType<typeof getPullRequestChanges>>);
      mockedGetPullRequestComments.mockResolvedValue([]);
      mockedGetPullRequestChecks.mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof getPullRequestChecks>>,
      );

      const manifest = await collectTaskContext({
        ...taskContextOptions(),
        connection: taskContextConnection(),
        outputDir,
        includePrs: true,
        includeComments: true,
        includeChecks: true,
      });

      expect(
        manifest.pullRequests.map((pullRequest) => pullRequest.id),
      ).toEqual([10]);
      expect(mockedGetPullRequestChanges).toHaveBeenCalledTimes(1);
      expect(mockedGetPullRequestComments).toHaveBeenCalledTimes(1);
      expect(mockedGetPullRequestChecks).toHaveBeenCalledTimes(1);
      expect(manifest.warnings.map((warning) => warning.message)).toEqual([
        'Skipped pull request 11 because it is not completed (status: active)',
        'Skipped pull request 12 because it is not completed (status: abandoned)',
        'Skipped pull request 13 because it is not completed (status: completed, draft: true)',
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('creates safe file names and default output directory', () => {
    expect(safeFileName('UI Development / ТЗ')).toBe('UI-Development-ТЗ');
    expect(defaultOutputDir(12345)).toBe('.ai-context/tasks/12345');
  });

  test('bounds long wiki file names with a stable hash suffix', () => {
    const longName =
      'RTS.MarketZmo.wiki/' +
      'Описание продукта/Маркет/Технические задания/Витрина поставщиков/Новый ЛК Маркета/ЛК Маркет. Заявки на добавление или изменение информации пользователей';

    const fileName = safeBoundedFileName(longName);

    expect(fileName.length).toBeLessThanOrEqual(96);
    expect(fileName).toMatch(/[a-f0-9]{10}$/);
  });

  test('caches wiki page lists while resolving multiple wiki page-id links', async () => {
    mockedListWikiPages.mockResolvedValue([
      { id: 11, path: '/Docs/One' },
      { id: 22, path: '/Docs/Two' },
    ]);
    mockedGetWikiPage.mockImplementation(async ({ pagePath }) => {
      return `content:${pagePath}`;
    });

    const warnings: CollectionIssue[] = [];
    const artifacts = await collectWikiPages(
      taskContextOptions(),
      scopedWorkItems(),
      [
        wikiPageIdLink(11, 'https://dev.azure.com/org/project/wiki/one'),
        wikiPageIdLink(22, 'https://dev.azure.com/org/project/wiki/two'),
      ],
      warnings,
    );

    expect(mockedListWikiPages).toHaveBeenCalledTimes(1);
    expect(mockedListWikiPages).toHaveBeenCalledWith({
      organizationId: undefined,
      projectId: 'Project',
      wikiId: 'wiki',
    });
    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      '/Docs/One',
      '/Docs/Two',
    ]);
    expect(mockedGetWikiPage).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });

  test('does not share wiki page list cache between collections', async () => {
    mockedListWikiPages.mockResolvedValue([{ id: 11, path: '/Docs/One' }]);
    mockedGetWikiPage.mockResolvedValue('content');

    const options = taskContextOptions();
    const scoped = scopedWorkItems();
    const links = [
      wikiPageIdLink(11, 'https://dev.azure.com/org/project/wiki'),
    ];

    await collectWikiPages(options, scoped, links, []);
    await collectWikiPages(options, scoped, links, []);

    expect(mockedListWikiPages).toHaveBeenCalledTimes(2);
  });

  test('renders work item markdown with core fields', () => {
    const markdown = renderWorkItemMarkdown(
      createWorkItem(123, {
        fields: {
          'System.WorkItemType': 'User Story',
          'System.Title': 'Add export',
          'System.State': 'Closed',
          'System.Description': '<p>Done</p>',
        },
      }),
    );

    expect(markdown).toContain('# User Story 123: Add export');
    expect(markdown).toContain('## Description');
    expect(markdown).toContain('Done');
  });

  test('builds manifest with deduplicated artifact source ids', () => {
    const root = createWorkItem(123, {
      fields: { 'System.Title': 'Root title', 'System.WorkItemType': 'Bug' },
    });
    const rootSummary = createWorkItemSummary(
      root,
      'work-items/root/123.Bug.md',
      'work-items/root/raw/123.json',
      { fullCollection: true },
    );
    const pullRequests: PullRequestArtifact[] = [
      {
        key: 'repo:1',
        id: 1,
        repositoryId: 'repo',
        repositoryName: 'Repo',
        raw: { title: 'PR title', status: 'completed' },
        sources: [
          { sourceWorkItemId: 124, sourceWorkItemActivity: 'Development' },
          { sourceWorkItemId: 124, sourceWorkItemActivity: 'Development' },
        ],
      },
    ];
    const commits: CommitArtifact[] = [
      {
        key: 'repo:abc',
        hash: 'abc',
        repositoryId: 'repo',
        raw: { comment: 'commit' },
        sources: [
          { sourceWorkItemId: 124, sourceWorkItemActivity: 'Development' },
        ],
      },
    ];
    const wikiPages: WikiArtifact[] = [
      {
        key: 'wiki-page',
        title: 'Page',
        path: '/Page',
        wikiId: 'wiki',
        source: 'explicit-link',
        sources: [{ sourceWorkItemId: 123, sourceWorkItemActivity: 'Unknown' }],
      },
    ];

    const manifest = buildManifest({
      generatedAt: '2026-04-30T00:00:00.000Z',
      project: 'Project',
      rootWorkItem: root,
      outputDir: '.ai-context/tasks/123',
      rootSummary,
      activities: { Development: [] },
      contextReferences: [],
      wikiPages,
      pullRequests,
      commits,
      links: [],
      warnings: [],
      errors: [],
    });

    expect(manifest.rootWorkItemTitle).toBe('Root title');
    expect(manifest.pullRequests[0].sourceWorkItemIds).toEqual([124]);
    expect(manifest.pullRequests[0].repository).toBe('Repo');
    expect(manifest.pullRequests[0].file).toBe('pull-requests/Repo/pr-1/pr.md');
    expect(manifest.commits[0].file).toBe('commits/commits.md');
    expect(manifest.wikiPages[0].file).toBe('wiki/pages/wiki-page.md');
  });

  test('writes commit artifacts instead of null raw placeholders', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      const commits: CommitArtifact[] = [
        {
          key: 'repo:abc',
          hash: 'abc',
          repositoryId: 'repo',
          raw: { commitId: 'abc', comment: 'explicit commit' },
          sources: [
            {
              sourceWorkItemId: 124,
              sourceWorkItemActivity: 'Development',
            },
          ],
        },
      ];

      await writeCommits(outputDir, commits, true);

      const raw = JSON.parse(
        await readFile(
          path.join(outputDir, 'commits/raw/commits.json'),
          'utf8',
        ),
      ) as CommitArtifact[];
      expect(raw[0].raw).toEqual({
        commitId: 'abc',
        comment: 'explicit commit',
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('writes compact inventory without embedding large artifact content', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      const root = createWorkItem(123, {
        fields: {
          'System.Title': 'Root title',
          'System.WorkItemType': 'Bug',
        },
      });
      const rootSummary = createWorkItemSummary(
        root,
        'work-items/root/123.Bug.md',
        'work-items/root/raw/123.json',
        { fullCollection: true },
      );
      const manifest = buildManifest({
        generatedAt: '2026-04-30T00:00:00.000Z',
        project: 'Project',
        rootWorkItem: root,
        outputDir,
        rootSummary,
        activities: {
          Development: [
            {
              id: 124,
              type: 'Task',
              title: 'A'.repeat(300),
              state: 'Closed',
              activity: 'Development',
              file: 'work-items/activities/Development/124.Task.md',
              fullCollection: true,
            },
          ],
        },
        contextReferences: [],
        wikiPages: [
          {
            key: 'wiki-page',
            title: 'Техническое решение',
            path: '/Docs/Техническое решение',
            wikiId: 'wiki',
            source: 'explicit-link',
            sources: [
              { sourceWorkItemId: 123, sourceWorkItemActivity: 'Unknown' },
            ],
          },
        ],
        pullRequests: [
          {
            key: 'repo:1',
            id: 1,
            repositoryId: 'repo',
            repositoryName: 'Repo',
            raw: { title: 'PR title', status: 'completed' },
            changes: { files: [] },
            sources: [
              { sourceWorkItemId: 124, sourceWorkItemActivity: 'Development' },
            ],
          },
        ],
        commits: [],
        links: [],
        warnings: [{ source: 'test', message: 'W'.repeat(500) }],
        errors: [],
      });

      await writeCompactInventory(outputDir, manifest);
      const inventory = await buildCompactInventory(outputDir, manifest);
      const md = await readFile(
        path.join(outputDir, 'output/analysis/00-inventory.md'),
        'utf8',
      );
      const json = JSON.parse(
        await readFile(
          path.join(outputDir, 'output/analysis/00-inventory.json'),
          'utf8',
        ),
      ) as Awaited<ReturnType<typeof buildCompactInventory>>;

      expect(
        inventory.activities.Development[0].title.length,
      ).toBeLessThanOrEqual(160);
      expect(json.wikiPages[0].documentTypeCandidates).toContain(
        'техническое решение',
      );
      expect(md).toContain('pull-requests/**/changes.md');
      expect(json.warnings[0].length).toBeLessThanOrEqual(300);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('output cleanup preserves user output files and removes generated analysis only', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      await mkdir(path.join(outputDir, 'output/analysis'), { recursive: true });
      await writeFile(path.join(outputDir, 'output/summary.md'), 'summary');
      await writeFile(
        path.join(outputDir, 'output/summary-review.md'),
        'review',
      );
      await writeFile(path.join(outputDir, 'output/notes.md'), 'notes');
      await writeFile(
        path.join(outputDir, 'output/analysis/01-work-items-compact.md'),
        'generated',
      );

      await resetOutputDirectory(outputDir);

      await expect(
        readFile(path.join(outputDir, 'output/summary.md'), 'utf8'),
      ).resolves.toBe('summary');
      await expect(
        readFile(path.join(outputDir, 'output/summary-review.md'), 'utf8'),
      ).resolves.toBe('review');
      await expect(
        readFile(path.join(outputDir, 'output/notes.md'), 'utf8'),
      ).resolves.toBe('notes');
      await expect(
        readFile(
          path.join(outputDir, 'output/analysis/01-work-items-compact.md'),
          'utf8',
        ),
      ).rejects.toThrow();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('generates compact analysis pack files', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      const manifest = buildSampleManifest(outputDir);
      await mkdir(path.join(outputDir, 'work-items/root'), { recursive: true });
      await mkdir(path.join(outputDir, 'work-items/activities/Development'), {
        recursive: true,
      });
      await mkdir(path.join(outputDir, 'work-items/context-references'), {
        recursive: true,
      });
      await mkdir(path.join(outputDir, 'wiki/pages'), { recursive: true });
      await mkdir(path.join(outputDir, 'pull-requests/Repo/pr-1'), {
        recursive: true,
      });

      await writeFile(
        path.join(outputDir, 'work-items/root/123.Bug.md'),
        '# Bug 123: Root\n\n## Description\n\nRoot description\n\n## Acceptance Criteria\n\nRoot AC\n\n## Relations\n\n- related\n',
      );
      await writeFile(
        path.join(outputDir, 'work-items/activities/Development/124.Task.md'),
        '# Task 124: Child\n\n## Description\n\nChild description\n\n## Acceptance Criteria\n\nChild AC\n',
      );
      await writeFile(
        path.join(outputDir, 'work-items/context-references/500.Bug.md'),
        '# Bug 500: Related\n\n## Description\n\nReference description\n',
      );
      await writeFile(
        path.join(outputDir, 'wiki/pages/wiki-page.md'),
        '# Техническое решение\n\n## API\n\nUse endpoint\n\n## Risks\n\nRisk note\n',
      );
      await writeFile(
        path.join(outputDir, 'pull-requests/Repo/pr-1/pr.md'),
        '# Pull Request 1: PR title\n\n- Source Branch: refs/heads/feature\n- Target Branch: refs/heads/master\n\n## Description\n\nPR description\n',
      );
      await writeFile(
        path.join(outputDir, 'pull-requests/Repo/pr-1/changes.md'),
        '# Pull Request Changes\n\n## src/api/Controller.cs\n\n```diff\n+ api\n```\n\n## tests/ControllerTests.cs\n\n```diff\n+ test\n```\n',
      );
      await writeFile(
        path.join(outputDir, 'pull-requests/Repo/pr-1/comments.md'),
        '# Pull Request Comments\n\n## Thread 1\n- Status: active\n\n### Comment 1\n- Author: Dev\n\nLooks good\n',
      );
      await writeFile(
        path.join(outputDir, 'pull-requests/Repo/pr-1/checks.md'),
        '# Pull Request Checks\n\n- Build: succeeded - ok\n',
      );

      await writeCompactAnalysisPack(outputDir, manifest);

      const analysisInput = await readFile(
        path.join(outputDir, 'output/analysis/05-analysis-input.md'),
        'utf8',
      );
      const workItems = JSON.parse(
        await readFile(
          path.join(outputDir, 'output/analysis/01-work-items-compact.json'),
          'utf8',
        ),
      ) as { contextReferences: Array<{ fullCollection?: boolean }> };
      const prIndex = JSON.parse(
        await readFile(
          path.join(outputDir, 'output/analysis/03-pr-index.json'),
          'utf8',
        ),
      ) as Array<{ changesSummary: { categories: Record<string, number> } }>;

      expect(analysisInput).toContain('Use only files in `output/analysis/`');
      expect(workItems.contextReferences[0].fullCollection).toBe(false);
      expect(prIndex[0].changesSummary.categories.backend).toBe(1);
      expect(prIndex[0].changesSummary.categories.tests).toBe(1);
      await expect(
        readFile(
          path.join(outputDir, 'output/analysis/00-inventory.md'),
          'utf8',
        ),
      ).resolves.toContain('# Inventory');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('classifies compact analysis helpers', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'task-context-'));
    try {
      const filePath = path.join(outputDir, 'changes.md');
      await writeFile(
        filePath,
        '## src/Controllers/OrdersController.cs\n## db/migrations/001.sql\n',
      );

      const summary = await summarizeChangedFilesFromDiffOrMarkdown(filePath);
      const excerpt = await safeReadTextExcerpt(filePath, 12);

      expect(classifyChangedFile('src/Controllers/OrdersController.cs')).toBe(
        'backend',
      );
      expect(classifyChangedFile('db/migrations/001.sql')).toBe(
        'db/migrations',
      );
      expect(classifyCommitMessage('fix order validation')).toBe('bug fix');
      expect(
        detectDocumentType('Техническое решение', '/Docs', 'file.md'),
      ).toBe('техническое решение');
      expect(summary.totalChangedFiles).toBe(2);
      expect(excerpt.length).toBeLessThanOrEqual(12);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function buildSampleManifest(outputDir: string) {
  const root = createWorkItem(123, {
    fields: {
      'System.Title': 'Root title',
      'System.WorkItemType': 'Bug',
      'System.State': 'Closed',
    },
  });
  const rootSummary = createWorkItemSummary(
    root,
    'work-items/root/123.Bug.md',
    undefined,
    { fullCollection: true, activity: 'Unknown' },
  );

  return buildManifest({
    generatedAt: '2026-04-30T00:00:00.000Z',
    project: 'Project',
    rootWorkItem: root,
    outputDir,
    rootSummary,
    activities: {
      Development: [
        {
          id: 124,
          type: 'Task',
          title: 'Child',
          state: 'Closed',
          activity: 'Development',
          file: 'work-items/activities/Development/124.Task.md',
          fullCollection: true,
        },
      ],
    },
    contextReferences: [
      {
        id: 500,
        type: 'Bug',
        title: 'Related',
        state: 'Active',
        relationType: 'System.LinkTypes.Related',
        sourceWorkItemId: 123,
        file: 'work-items/context-references/500.Bug.md',
        fullCollection: false,
      },
    ],
    wikiPages: [
      {
        key: 'wiki-page',
        title: 'Техническое решение',
        path: '/Docs/Техническое решение',
        wikiId: 'wiki',
        source: 'explicit-link',
        sources: [{ sourceWorkItemId: 123, sourceWorkItemActivity: 'Unknown' }],
      },
    ],
    pullRequests: [
      {
        key: 'repo:1',
        id: 1,
        repositoryId: 'repo',
        repositoryName: 'Repo',
        raw: {
          title: 'PR title',
          status: 'completed',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/master',
          description: 'PR description',
        },
        changes: { files: [] },
        comments: [],
        checks: {},
        sources: [
          { sourceWorkItemId: 124, sourceWorkItemActivity: 'Development' },
        ],
      },
    ],
    commits: [
      {
        key: 'repo:abc',
        hash: 'abc',
        repositoryName: 'Repo',
        raw: { comment: 'fix order validation #123' },
        sources: [
          { sourceWorkItemId: 124, sourceWorkItemActivity: 'Development' },
        ],
      },
    ],
    links: [
      {
        kind: 'pull-request',
        url: 'https://example/pr/1',
        source: 'test',
        sourceWorkItemId: 124,
        pullRequestId: 1,
      },
    ],
    warnings: [],
    errors: [],
  });
}

function taskContextOptions(): TaskContextCollectOptions {
  return {
    connection: taskContextConnection(),
    project: 'Project',
    workItemId: 123,
    outputDir: '.ai-context/tasks/123',
    includeWiki: true,
    includePrs: false,
    includeCommits: false,
    includeComments: false,
    includeChecks: false,
    includeRaw: false,
  };
}

function taskContextConnection(): TaskContextCollectOptions['connection'] {
  return {
    serverUrl: 'https://dev.azure.com/org',
    getGitApi: jest.fn().mockResolvedValue({}),
    getWorkItemTrackingApi: jest.fn().mockResolvedValue({
      getComments: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as TaskContextCollectOptions['connection'];
}

function scopedWorkItems(): WorkItemWithActivity[] {
  return [
    {
      workItem: createWorkItem(123),
      activity: 'Unknown',
      fullCollection: true,
    },
  ];
}

function wikiPageIdLink(pageId: number, url: string): ExtractedLink {
  return {
    kind: 'wiki',
    url,
    source: 'test',
    sourceWorkItemId: 123,
    wikiId: 'wiki',
    wikiPageId: pageId,
  };
}

function createWorkItem(
  id: number,
  options: {
    fields?: Record<string, unknown>;
    relations?: WorkItem['relations'];
  } = {},
): WorkItem {
  return {
    id,
    rev: 1,
    fields: {
      'System.Id': id,
      'System.WorkItemType': 'Task',
      'System.Title': `Work item ${id}`,
      'System.State': 'Closed',
      ...options.fields,
    },
    relations: options.relations,
    url: `https://dev.azure.com/org/project/_apis/wit/workItems/${id}`,
  } as WorkItem;
}

function relation(
  rel: string,
  targetId: number,
): NonNullable<WorkItem['relations']>[number] {
  return {
    rel,
    url: `https://dev.azure.com/org/project/_apis/wit/workItems/${targetId}`,
  };
}
