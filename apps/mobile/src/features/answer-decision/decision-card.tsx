import { useState } from 'react';

import { StyleSheet, Text, TextInput, View } from 'react-native';

import { MAX_DECISION_CHOICE_LENGTH, MAX_DECISION_NOTE_LENGTH } from '@entities/inbox';

import type { PendingDecision } from '@shared/api/host';
import { colors, mono } from '@shared/theme';
import { Button, common, formatAge, formatRemaining, hasElapsed, Pill } from '@shared/ui';

type DecisionCardProps = {
  decision: PendingDecision;
  focused: boolean;
  submission: 'sending' | 'unknown' | undefined;
  connected: boolean;
  now: number;
  onDecide: (choice: string, note: string) => void;
};

const submissionLabel = (submission: DecisionCardProps['submission']) =>
  submission === 'sending'
    ? 'Sending…'
    : submission === 'unknown'
      ? 'Awaiting confirmation after reconnect'
      : 'Send answer';

export const DecisionCard = ({
  decision,
  focused,
  submission,
  connected,
  now,
  onDecide,
}: DecisionCardProps) => {
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const expired = hasElapsed(decision.expiresAt, now);
  const locked = !!submission || !connected || expired;
  return (
    <View style={[common.card, focused && styles.focused]} testID={`decision-${decision.id}`}>
      <View style={styles.meta}>
        <Pill
          label={expired ? 'Expired' : `Expires ${formatRemaining(decision.expiresAt, now)}`}
          color={expired ? colors.danger : colors.warning}
        />
        <Text style={styles.metaText}>
          {decision.audience === 'owner' ? 'For you' : 'For the coordinator or you'} · asked{' '}
          {formatAge(decision.createdAt, now)}
        </Text>
      </View>
      <Text style={styles.run} numberOfLines={2}>
        {decision.run.title || 'Untitled run'}
      </Text>
      <Text style={styles.question} selectable>
        {decision.question}
      </Text>
      <Text style={styles.provenance} selectable>
        decision {decision.id} · revision {decision.revision} · run {decision.run.id}
      </Text>
      <View>
        <Text style={common.label}>Answer</Text>
        <TextInput
          value={answer}
          onChangeText={setAnswer}
          editable={!locked}
          maxLength={MAX_DECISION_CHOICE_LENGTH}
          multiline
          placeholder="Type an answer"
          placeholderTextColor={colors.faint}
          accessibilityLabel="Decision answer"
          style={[common.input, styles.multiline]}
        />
      </View>
      <View>
        <Text style={common.label}>Note (optional)</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          editable={!locked}
          maxLength={MAX_DECISION_NOTE_LENGTH}
          multiline
          placeholder="Extra context for the agent"
          placeholderTextColor={colors.faint}
          accessibilityLabel="Decision note"
          style={[common.input, styles.multiline]}
        />
      </View>
      <Button
        label={submissionLabel(submission)}
        icon="send-outline"
        disabled={locked || !answer.trim()}
        onPress={() => onDecide(answer, note)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  focused: { borderColor: colors.accent },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  metaText: { color: colors.faint, fontFamily: mono, fontSize: 12 },
  run: { color: colors.muted, fontFamily: mono, fontSize: 13 },
  question: { color: colors.text, fontSize: 16, lineHeight: 24 },
  provenance: { color: colors.faint, fontFamily: mono, fontSize: 11 },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
});
