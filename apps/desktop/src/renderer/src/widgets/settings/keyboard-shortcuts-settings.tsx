import {
  shortcutGroups,
  shortcuts,
  type ShortcutId,
} from '@/shared/lib/keyboard-shortcuts';
import { KeyCombo } from '@/shared/ui/kbd';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';

const entries = Object.entries(shortcuts) as [
  ShortcutId,
  (typeof shortcuts)[ShortcutId],
][];

export function KeyboardShortcutsSettings() {
  return (
    <div className="space-y-8">
      {shortcutGroups.map(group => (
        <SettingsSection key={group} title={group}>
          {entries
            .filter(([, entry]) => entry.group === group)
            .map(([id, entry]) => (
              <SettingsRow
                key={id}
                title={entry.label}
                className="min-h-10 py-2"
              >
                <span className="sr-only">{entry.keys}</span>
                <KeyCombo keys={entry.keys} size="md" />
              </SettingsRow>
            ))}
        </SettingsSection>
      ))}
      <p className="px-3 text-xs text-muted-foreground">
        Ctrl shortcuts also accept ⌘ on macOS. Shortcuts only navigate and open
        views; sending, approving and deciding always need an explicit action.
      </p>
    </div>
  );
}
