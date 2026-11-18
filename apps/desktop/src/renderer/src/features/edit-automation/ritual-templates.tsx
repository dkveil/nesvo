import { Field } from '@/shared/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import type { AutomationValues } from './automation-form';
import type { AutomationEditorState } from './use-automation-editor';

const templates = [
  {
    name: 'Daily error triage',
    prompt:
      'Read the error dashboard I specified in the task spec. Summarize current issues by stable ID and prioritize follow-up.',
    time: '08:30',
    scheduleKind: 'daily',
    browser: true,
  },
  {
    name: 'Dependency update maintenance',
    prompt:
      'Find open dependency-update pull requests in this repository. In the session worktree, prepare updates to address conflicts and failing checks. Summarize the changes and tests.',
    time: '10:00',
    scheduleKind: 'daily',
    writable: true,
  },
  {
    name: 'Morning plan',
    prompt:
      'Review upcoming commitments and open work using the sources available to this session. Propose a short, prioritized plan with any decisions needed.',
    time: '09:00',
  },
  {
    name: 'Day summary',
    prompt:
      'Summarize completed work, open decisions and the next actions based on the information available to this session.',
    time: '17:00',
  },
  {
    name: 'Weekly Git summary',
    prompt:
      'Read the last week of Git history in this checkout. Summarize completed work by theme and note follow-ups supported by the history.',
    time: '16:00',
    scheduleKind: 'weekly',
    weekday: 5,
  },
] as const satisfies readonly Partial<AutomationValues>[];

export function RitualTemplates({ editor }: { editor: AutomationEditorState }) {
  if (
    !editor.supportsRituals ||
    editor.editing ||
    editor.values.reviewMode ||
    editor.values.workflow
  )
    return null;
  return (
    <Field
      id="ritual-template"
      label="Starter template"
      hint="Templates start paused."
    >
      <Select
        value=""
        disabled={editor.pending}
        onValueChange={name => {
          const template = templates.find(item => item.name === name);
          if (!template) return;
          editor.change({
            checkEnabled: false,
            redCi: false,
            browser: false,
            writable: false,
            scheduleKind: 'weekdays',
            ...template,
            promptSkill: undefined,
            active: false,
          });
        }}
      >
        <SelectTrigger id="ritual-template" size="md" className="w-full">
          <SelectValue placeholder="Choose a template" />
        </SelectTrigger>
        <SelectContent>
          {templates.map(item => (
            <SelectItem key={item.name} value={item.name}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
