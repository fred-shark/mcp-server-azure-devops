import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import {
  CommitArtifact,
  ExtractedLink,
  Manifest,
  PullRequestArtifact,
  WikiArtifact,
} from './types';
import {
  renderChecksMarkdown,
  renderCommitsMarkdown,
  renderLinksMarkdown,
  renderPullRequestChangesMarkdown,
  renderPullRequestCommentsMarkdown,
  renderPullRequestMarkdown,
  renderReadme,
  renderSummaryPrompt,
  renderWikiIndexMarkdown,
  safeBoundedFileName,
} from './markdownRenderers';

export async function resetOutputDirectory(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    [
      'manifest.json',
      'README.md',
      'work-items',
      'wiki',
      'pull-requests',
      'commits',
      'links',
      'prompts',
    ].map((entry) =>
      rm(path.join(outputDir, entry), { recursive: true, force: true }),
    ),
  );
  await cleanGeneratedAnalysisFiles(outputDir);
}

export async function cleanGeneratedAnalysisFiles(
  outputDir: string,
): Promise<void> {
  await Promise.all(
    [
      'output/analysis/00-inventory.md',
      'output/analysis/00-inventory.json',
      'output/analysis/01-work-items-compact.md',
      'output/analysis/01-work-items-compact.json',
      'output/analysis/02-wiki-index.md',
      'output/analysis/02-wiki-index.json',
      'output/analysis/03-pr-index.md',
      'output/analysis/03-pr-index.json',
      'output/analysis/04-commits-compact.md',
      'output/analysis/04-commits-compact.json',
      'output/analysis/05-analysis-input.md',
    ].map((entry) =>
      rm(path.join(outputDir, entry), { recursive: true, force: true }),
    ),
  );
}

export async function writeJsonFile(
  outputDir: string,
  relativePath: string,
  data: unknown,
): Promise<string> {
  const fullPath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return relativePath;
}

export async function writeMarkdownFile(
  outputDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const fullPath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return relativePath;
}

export async function writeLinks(
  outputDir: string,
  links: ExtractedLink[],
): Promise<void> {
  await writeMarkdownFile(
    outputDir,
    'links/extracted-links.md',
    renderLinksMarkdown(links),
  );
  await writeJsonFile(outputDir, 'links/extracted-links.json', links);
}

export async function writePullRequests(
  outputDir: string,
  pullRequests: PullRequestArtifact[],
  includeRaw: boolean,
): Promise<void> {
  for (const pullRequest of pullRequests) {
    const repositoryDir = safeBoundedFileName(
      pullRequest.repositoryName ??
        pullRequest.repositoryId ??
        'unknown-repository',
    );
    const baseDir = `pull-requests/${repositoryDir}/pr-${pullRequest.id}`;
    await writeMarkdownFile(
      outputDir,
      `${baseDir}/pr.md`,
      renderPullRequestMarkdown(pullRequest),
    );
    if (pullRequest.comments) {
      await writeMarkdownFile(
        outputDir,
        `${baseDir}/comments.md`,
        renderPullRequestCommentsMarkdown(pullRequest.comments),
      );
    }
    if (pullRequest.changes) {
      await writeMarkdownFile(
        outputDir,
        `${baseDir}/changes.md`,
        renderPullRequestChangesMarkdown(pullRequest.changes),
      );
    }
    if (pullRequest.checks) {
      await writeMarkdownFile(
        outputDir,
        `${baseDir}/checks.md`,
        renderChecksMarkdown(pullRequest.checks),
      );
    }
    if (includeRaw) {
      await writeJsonFile(outputDir, `${baseDir}/raw/pr.json`, pullRequest.raw);
      if (pullRequest.comments) {
        await writeJsonFile(
          outputDir,
          `${baseDir}/raw/comments.json`,
          pullRequest.comments,
        );
      }
      if (pullRequest.changes) {
        await writeJsonFile(
          outputDir,
          `${baseDir}/raw/changes.json`,
          pullRequest.changes,
        );
      }
      if (pullRequest.checks) {
        await writeJsonFile(
          outputDir,
          `${baseDir}/raw/checks.json`,
          pullRequest.checks,
        );
      }
    }
  }
}

export async function writeCommits(
  outputDir: string,
  commits: CommitArtifact[],
  includeRaw: boolean,
): Promise<void> {
  await writeMarkdownFile(
    outputDir,
    'commits/commits.md',
    renderCommitsMarkdown(commits),
  );
  if (includeRaw) {
    await writeJsonFile(outputDir, 'commits/raw/commits.json', commits);
  }
}

export async function writeWiki(
  outputDir: string,
  wikiPages: WikiArtifact[],
  includeRaw: boolean,
): Promise<void> {
  await writeMarkdownFile(
    outputDir,
    'wiki/index.md',
    renderWikiIndexMarkdown(wikiPages),
  );
  for (const wikiPage of wikiPages) {
    await writeMarkdownFile(
      outputDir,
      `wiki/pages/${wikiPage.key}.md`,
      `# ${wikiPage.title}\n\n${wikiPage.content ?? 'Content not found.'}\n`,
    );
  }
  if (includeRaw) {
    await writeJsonFile(
      outputDir,
      'wiki/raw/wiki-pages.json',
      wikiPages.map((wikiPage) => ({
        key: wikiPage.key,
        title: wikiPage.title,
        path: wikiPage.path,
        wikiId: wikiPage.wikiId,
        source: wikiPage.source,
        sources: wikiPage.sources,
        raw: wikiPage.raw,
      })),
    );
  }
}

export async function writeManifestReadmeAndPrompt(
  outputDir: string,
  manifest: Manifest,
): Promise<void> {
  await writeJsonFile(outputDir, 'manifest.json', manifest);
  await writeMarkdownFile(outputDir, 'README.md', renderReadme(manifest));
  await writeMarkdownFile(
    outputDir,
    'prompts/summarize-task.prompt.md',
    renderSummaryPrompt(),
  );
}
