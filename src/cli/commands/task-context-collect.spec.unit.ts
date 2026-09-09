import { resolveTaskContextArtifactIncludes } from './task-context-collect';

describe('task-context-collect CLI options', () => {
  test('includes comments in the default artifact set', () => {
    expect(resolveTaskContextArtifactIncludes({ workItemId: 123 })).toEqual({
      includeWiki: true,
      includePrs: true,
      includeCommits: true,
      includeComments: true,
      includeChecks: false,
    });
  });

  test('requires include-comments in selective artifact mode', () => {
    expect(
      resolveTaskContextArtifactIncludes({
        workItemId: 123,
        includePrs: true,
      }),
    ).toEqual({
      includeWiki: false,
      includePrs: true,
      includeCommits: false,
      includeComments: false,
      includeChecks: false,
    });

    expect(
      resolveTaskContextArtifactIncludes({
        workItemId: 123,
        includeComments: true,
      }).includeComments,
    ).toBe(true);
  });
});
