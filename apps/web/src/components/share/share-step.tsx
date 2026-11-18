import type { OutlinedStep } from '@/shares/workflow-outline';

type ShareStepProps = {
  step: OutlinedStep;
  position: number;
};

export const ShareStep = ({ step, position }: ShareStepProps) => (
  <li className="step" data-shell={step.runsShell}>
    <div className="step-header">
      <span className="step-position">{position}</span>
      <span className="step-name">{step.name}</span>
      <span className="step-type">{step.type}</span>
      {step.runsShell ? <span className="step-flag">Runs commands</span> : null}
    </div>
    {step.runsShell ? (
      <pre className="code" aria-label={`${step.fileName} content`}>
        <code>{step.content}</code>
      </pre>
    ) : (
      <details className="step-details">
        <summary>Show {step.fileName}</summary>
        <pre className="code">
          <code>{step.content}</code>
        </pre>
      </details>
    )}
  </li>
);
