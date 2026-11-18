import type { SessionStageRecord } from '@nesvo/contracts';
import { modeLabel, type Session } from '@/entities/session';
import { Separator } from '@/shared/ui/separator';
import { StatusMessage } from '@/shared/ui/status-message';
import { MessageBody } from '@/widgets/conversation/message-body';
import { PlanDecision } from './plan-decision';
import { QuestionAnswer } from './question-answer';
import { ReportCard } from './report-card';
import { actorText, type StageActions } from './use-stage-decisions';

type Props = {
  session: Session;
  record: SessionStageRecord;
  actions: StageActions;
};

const decisionVerbs = {
  accept: 'Plan approved by',
  correct: 'Correction requested by',
  decline: 'Plan rejected by',
} as const;

type DecisionRecord = Extract<SessionStageRecord, { kind: 'decision' }>;

const decisionLabel = (record: DecisionRecord) => {
  const outcome = `${record.outcome ?? 'decided'}${record.by ? ` by ${actorText(record.by)}` : ''}`;
  if (record.childTitle)
    return record.status === 'needed'
      ? `${record.childTitle} waits for your decision · ${record.title}`
      : `${record.childTitle} · ${record.title} · ${outcome}`;
  return record.status === 'needed'
    ? `Waiting for the owner's decision · ${record.title}`
    : `${record.title} · ${outcome}`;
};

export function StageRecord({ session, record, actions }: Props) {
  if (record.kind === 'plan') {
    const current =
      session.plan?.status === 'plan-ready' &&
      session.plan.id === record.planId;
    const answered = session.messages.some(
      message =>
        message.runId === record.runId &&
        message.author === 'agent' &&
        message.body.trim() === record.text.trim(),
    );
    return (
      <section
        id={`plan-${record.planId}`}
        aria-label="Plan"
        className="space-y-3 rounded-surface border bg-card p-4"
      >
        <h2 className="text-sm font-medium">
          {record.round > 0 ? `Revised plan ${record.round + 1}` : 'Plan'}
        </h2>
        {answered ? (
          <p className="text-xs text-muted-foreground">
            The plan is the answer above.
          </p>
        ) : (
          <MessageBody
            body={record.text || 'The session returned an empty plan.'}
            className="text-ui"
          />
        )}
        {current && <PlanDecision session={session} actions={actions} />}
      </section>
    );
  }
  if (record.kind === 'plan-decision')
    return (
      <Separator
        label={`${decisionVerbs[record.decision]} ${actorText(record.by)}`}
      />
    );
  if (record.kind === 'mode-change')
    return session.stageRecords.some(
      item => item.kind === 'plan-decision' && item.at === record.at,
    ) ? null : (
      <Separator
        label={`Mode changed to ${modeLabel(session.provider, record.to)} by ${actorText(record.by)}`}
      />
    );
  if (record.kind === 'report')
    return (
      <ReportCard
        id={`stage-${record.id}`}
        report={record.report}
        source={record.source}
      />
    );
  if (record.kind === 'report-invalid')
    return (
      <StatusMessage tone="warning" variant="notice">
        The report in the final answer is invalid: {record.error}
      </StatusMessage>
    );
  if (record.kind === 'progress')
    return (
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        Progress · {record.text}
      </p>
    );
  if (record.kind === 'decision')
    return <Separator label={decisionLabel(record)} />;
  const { question } = record;
  return (
    <section
      id={`question-${record.id}`}
      aria-label="Question"
      className="space-y-3 rounded-surface border bg-card p-4"
    >
      <p className="text-2xs text-muted-foreground">
        {question.kind === 'product'
          ? 'Product question'
          : 'Technical question'}
      </p>
      <h2 className="text-sm font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">
        {question.question}
      </h2>
      <ul className="space-y-1.5 text-ui">
        {question.options.map(option => (
          <li key={option.label} className="[overflow-wrap:anywhere]">
            <span className="font-medium">{option.label}</span>
            <span className="text-muted-foreground">
              {' '}
              · {option.consequences}
            </span>
          </li>
        ))}
      </ul>
      {question.recommendation && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Recommendation: {question.recommendation}
        </p>
      )}
      {record.status === 'pending' ? (
        <QuestionAnswer session={session} record={record} actions={actions} />
      ) : (
        record.answer && (
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Answered by {actorText(record.answer.by)}
            {record.answer.option ? `: ${record.answer.option}` : ''}
            {record.answer.text ? ` · ${record.answer.text}` : ''}
          </p>
        )
      )}
    </section>
  );
}
