import { useCallback, useEffect, useRef, useState } from 'react';

import {
  canSubmitDecision,
  decisionRefusal,
  type DecisionSubmissions,
  markSubmissionsUnknown,
  mergeDecisionPage,
  normalizeDecisionAnswer,
  settleUnknownSubmissions,
  submissionKey,
  useInbox,
} from '@entities/inbox';
import { useWorkspace } from '@entities/workspace';

import type { PendingDecision } from '@shared/api/host';

const CHANGE_DEBOUNCE_MS = 400;
const MAX_NOTICES = 4;

type DecisionNotice = { id: string; tone: 'success' | 'warning' | 'danger'; text: string };
type DecisionList = {
  decisions: PendingDecision[];
  total: number;
  nextPage: number | null;
  receivedAt: number | null;
};
type PageRequest = { id: string; replace: boolean };

const EMPTY_LIST: DecisionList = { decisions: [], total: 0, nextPage: null, receivedAt: null };
const QUESTION_EXCERPT_LENGTH = 80;

const withoutSubmission = (submissions: DecisionSubmissions, key: string) => {
  const next = new Map(submissions);
  next.delete(key);
  return next;
};

const excerpt = (question: string) =>
  question.length > QUESTION_EXCERPT_LENGTH
    ? `${question.slice(0, QUESTION_EXCERPT_LENGTH - 1)}…`
    : question;

export const usePendingDecisions = (active: boolean) => {
  const { client, connected, hostCapabilities } = useWorkspace();
  const { decisionsSupported } = useInbox();
  const [list, setList] = useState<DecisionList>(EMPTY_LIST);
  const [loading, setLoading] = useState(false);
  const [submissions, setSubmissions] = useState<DecisionSubmissions>(new Map());
  const submissionsRef = useRef<DecisionSubmissions>(submissions);
  const [notices, setNotices] = useState<DecisionNotice[]>([]);
  const listRef = useRef(list);
  const pageRequest = useRef<PageRequest | null>(null);
  const inflight = useRef(new Map<string, PendingDecision>());
  const changeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastHost = useRef<string | null>(hostCapabilities?.hostId ?? null);

  useEffect(() => {
    listRef.current = list;
  }, [list]);

  const updateSubmissions = useCallback(
    (change: (current: DecisionSubmissions) => DecisionSubmissions) => {
      submissionsRef.current = change(submissionsRef.current);
      setSubmissions(submissionsRef.current);
    },
    [],
  );

  const addNotice = useCallback((tone: DecisionNotice['tone'], text: string) => {
    setNotices(current =>
      [{ id: `${Date.now()}-${current.length}`, tone, text }, ...current].slice(0, MAX_NOTICES),
    );
  }, []);

  const request = useCallback(
    (page: number, replace: boolean) => {
      const requestId = client.requestId();
      pageRequest.current = { id: requestId, replace };
      setLoading(true);
      if (client.requestDecisions(page, requestId)) return;
      pageRequest.current = null;
      setLoading(false);
    },
    [client],
  );

  const refresh = useCallback(() => request(0, true), [request]);

  const loadMore = useCallback(() => {
    const { nextPage } = listRef.current;
    if (nextPage !== null && !pageRequest.current) request(nextPage, false);
  }, [request]);

  const decide = useCallback(
    (decision: PendingDecision, choice: string, note: string) => {
      const answer = normalizeDecisionAnswer(choice, note);
      if (!answer || !canSubmitDecision(submissionsRef.current, decision)) return false;
      const key = submissionKey(decision);
      const requestId = client.requestId();
      inflight.current.set(requestId, decision);
      updateSubmissions(current => new Map(current).set(key, 'sending'));
      if (client.decide(decision.id, answer.choice, answer.note, requestId)) return true;
      inflight.current.delete(requestId);
      updateSubmissions(current => withoutSubmission(current, key));
      addNotice('warning', 'Not connected to the host. The answer was not sent.');
      return false;
    },
    [client, updateSubmissions, addNotice],
  );

  const settle = useCallback(
    (decision: PendingDecision, removeFromList: boolean) => {
      updateSubmissions(current => withoutSubmission(current, submissionKey(decision)));
      if (!removeFromList) return;
      setList(current => ({
        ...current,
        decisions: current.decisions.filter(item => item.id !== decision.id),
        total: Math.max(0, current.total - 1),
      }));
    },
    [updateSubmissions],
  );

  useEffect(
    () =>
      client.subscribe(event => {
        if (event.type === 'decisions') {
          const page = pageRequest.current;
          if (!page || event.requestId !== page.id) return;
          pageRequest.current = null;
          setLoading(false);
          setList(current => ({
            decisions: mergeDecisionPage(current.decisions, event.decisions, page.replace),
            total: event.total,
            nextPage: event.nextPage,
            receivedAt: Date.now(),
          }));
          updateSubmissions(settleUnknownSubmissions);
        } else if (event.type === 'decided') {
          const decision = event.requestId ? inflight.current.get(event.requestId) : undefined;
          if (!decision || !event.requestId) return;
          inflight.current.delete(event.requestId);
          settle(decision, true);
          addNotice('success', `Answer recorded: "${excerpt(decision.question)}".`);
        } else if (event.type === 'error' && event.requestId) {
          if (event.requestId === pageRequest.current?.id) {
            pageRequest.current = null;
            setLoading(false);
            addNotice('warning', event.message);
            return;
          }
          const decision = inflight.current.get(event.requestId);
          if (!decision) return;
          inflight.current.delete(event.requestId);
          const refusal = decisionRefusal(event.code);
          settle(decision, !!refusal);
          addNotice(
            refusal ? 'danger' : 'warning',
            refusal
              ? `"${excerpt(decision.question)}": ${refusal}`
              : `The host refused the answer: ${event.message}`,
          );
        } else if (event.type === 'capabilities') {
          const host = event.hostId ?? '';
          if (lastHost.current === host) return;
          lastHost.current = host;
          inflight.current.clear();
          setList(EMPTY_LIST);
          updateSubmissions(() => new Map());
        } else if (event.type === 'attentionInboxChanged') {
          clearTimeout(changeTimer.current);
          if (active) changeTimer.current = setTimeout(refresh, CHANGE_DEBOUNCE_MS);
        } else if (event.type === 'disconnected') {
          clearTimeout(changeTimer.current);
          pageRequest.current = null;
          setLoading(false);
          if (inflight.current.size === 0) return;
          const keys = [...inflight.current.values()].map(submissionKey);
          inflight.current.clear();
          updateSubmissions(current => markSubmissionsUnknown(current, keys));
          addNotice(
            'warning',
            'The connection dropped before the answer was confirmed. It will not be resent; check the list after reconnecting.',
          );
        }
      }),
    [client, active, refresh, settle, addNotice, updateSubmissions],
  );

  useEffect(() => () => clearTimeout(changeTimer.current), []);

  const advertised = hostCapabilities?.decisions === true;
  useEffect(() => {
    if (!active || !connected || !advertised) return;
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [active, connected, advertised, refresh]);

  return {
    supported: decisionsSupported,
    connected,
    decisions: list.decisions,
    total: list.total,
    nextPage: list.nextPage,
    receivedAt: list.receivedAt,
    loading,
    submissions,
    notices,
    dismissNotice: (id: string) =>
      setNotices(current => current.filter(notice => notice.id !== id)),
    refresh,
    loadMore,
    decide,
  };
};
