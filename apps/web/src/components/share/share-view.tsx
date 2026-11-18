import {
  buildWorkflowShareDeepLink,
  type WorkflowShareBundle,
} from '@nesvo/contracts/workflow-share';

import { formatDateTimeUtc, formatTimeLeft } from '@/lib/format';
import { outlineWorkflow } from '@/shares/workflow-outline';

import { ShareShell } from './share-shell';
import { ShareStep } from './share-step';

type ShareViewProps = {
  id: string;
  origin: string;
  bundle: WorkflowShareBundle;
  expiresAt: number;
  now: number;
};

export const ShareView = ({
  id,
  origin,
  bundle,
  expiresAt,
  now,
}: ShareViewProps) => {
  const outline = outlineWorkflow(bundle);
  const stepCount = outline.steps.length;

  return (
    <ShareShell>
      <header className="share-header">
        <p className="section-label">Shared workflow</p>
        <h1 className="share-title">{bundle.name}</h1>
        {bundle.description ? (
          <p className="share-description">{bundle.description}</p>
        ) : null}
        <p className="share-meta">
          <span>
            {stepCount} {stepCount === 1 ? 'step' : 'steps'}
          </span>
          <span>
            Expires {formatTimeLeft(expiresAt, now)},{' '}
            <time dateTime={new Date(expiresAt).toISOString()}>
              {formatDateTimeUtc(expiresAt)}
            </time>
          </span>
          <span>Shared from Nesvo {bundle.createdWith.version}</span>
        </p>
      </header>

      <div className="warning" role="note">
        <p className="warning-title">
          This workflow runs commands on your computer
        </p>
        <p>
          Command and action steps run shell scripts in your project with your
          permissions.{' '}
          {outline.shellStepCount > 0
            ? `This workflow has ${outline.shellStepCount} of them. `
            : ''}
          Read every step below and import it only if you trust the person who
          shared it.
        </p>
      </div>

      <div className="share-actions">
        <a
          className="button button-primary"
          href={buildWorkflowShareDeepLink({ id, origin })}
        >
          Open in Nesvo
        </a>
        <a className="button" href="/">
          Download Nesvo
        </a>
        <p className="share-hint">
          Nothing happens? Install Nesvo, then open this page again.
        </p>
      </div>

      <section aria-labelledby="steps-title">
        <h2 id="steps-title" className="section-label">
          Steps
        </h2>
        {stepCount > 0 ? (
          <ol className="steps">
            {outline.steps.map((step, index) => (
              <ShareStep key={step.fileName} step={step} position={index + 1} />
            ))}
          </ol>
        ) : (
          <p className="share-description">This workflow has no step files.</p>
        )}
      </section>

      <details className="step-details workflow-file">
        <summary>Show workflow file {bundle.workflow.fileName}</summary>
        <pre className="code">
          <code>{bundle.workflow.content}</code>
        </pre>
      </details>
    </ShareShell>
  );
};
