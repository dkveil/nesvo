import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseWorkflowShareDeepLink } from '@nesvo/contracts/workflow-share';

import { ShareUnavailable } from '@/components/share/share-unavailable';
import { ShareView } from '@/components/share/share-view';
import { outlineWorkflow } from '@/shares/workflow-outline';

import { createBundle } from './support/bundles';

const ID = 'Ab0_'.repeat(8);
const NOW = Date.parse('2026-11-18T12:00:00Z');
const EXPIRES_AT = NOW + 6 * 24 * 60 * 60 * 1000 + 1000;

const renderShare = () =>
  renderToStaticMarkup(
    <ShareView
      id={ID}
      origin="https://nesvo.dev"
      bundle={createBundle()}
      expiresAt={EXPIRES_AT}
      now={NOW}
    />,
  );

describe('Share page', () => {
  it('shows the workflow, its steps in order and the command content escaped', () => {
    const html = renderShare();

    expect(html).toContain('release');
    expect(html).toContain('Lint and test before a release.');
    expect(html.indexOf('>lint<')).toBeLessThan(html.indexOf('>review<'));
    expect(html).toContain(
      'bun run lint &amp;&amp; echo &quot;&lt;done&gt;&quot;',
    );
    expect(html).not.toContain('"<done>"');
    expect(html).toContain('Runs commands');
  });

  it('warns that the workflow runs commands and shows the expiry', () => {
    const html = renderShare();

    expect(html).toContain('This workflow runs commands on your computer');
    expect(html).toContain('Expires in 6 days');
    expect(html).toContain('Nov 24, 2026');
  });

  it('opens the share in Nesvo and offers the download as a fallback', () => {
    const html = renderShare();
    const link = /href="(nesvo:\/\/[^"]+)"/
      .exec(html)?.[1]
      ?.replace(/&amp;/g, '&');

    expect(link).toBe(
      `nesvo://import-workflow?share=${ID}&origin=https%3A%2F%2Fnesvo.dev`,
    );
    expect(parseWorkflowShareDeepLink(link ?? '')).toEqual({
      id: ID,
      origin: 'https://nesvo.dev',
    });
    expect(html).toContain('Download Nesvo');
  });

  it('explains an expired link', () => {
    const html = renderToStaticMarkup(<ShareUnavailable reason="expired" />);

    expect(html).toContain('This shared workflow has expired');
    expect(html).toContain('Shared links last 7 days');
  });
});

describe('Step outline', () => {
  const outlineOf = (stepContent: string) =>
    outlineWorkflow(
      createBundle({
        steps: [{ fileName: 'check.md', content: stepContent }],
      }),
    ).steps[0];

  it('treats only a single known non-shell type as safe to collapse', () => {
    expect(outlineOf('---\ntype: agent\n---\nReview.\n')?.runsShell).toBe(
      false,
    );
    expect(outlineOf('---\ntype: "human"\n---\nApprove?\n')?.runsShell).toBe(
      false,
    );
  });

  it('shows steps in full when the type is ambiguous or unknown', () => {
    expect(outlineOf('---\ntype : command\n---\nrm -rf x\n')?.runsShell).toBe(
      true,
    );
    expect(
      outlineOf('---\ntype: agent\ntype: command\n---\nrm -rf x\n')?.runsShell,
    ).toBe(true);
    expect(
      outlineOf('---\ntype: agent # reviewer\nmeta:\n  type: agent\n---\nx\n')
        ?.runsShell,
    ).toBe(true);
    expect(outlineOf('﻿---\ntype: agent\n---\nrm -rf x\n')?.runsShell).toBe(
      true,
    );
    expect(outlineOf('---\ntype: shell\n---\nrm -rf x\n')?.runsShell).toBe(
      true,
    );
  });
});
