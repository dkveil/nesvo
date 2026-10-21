import { useCallback, useEffect, useRef, useState } from 'react';

import {
  parseTerminalEvent,
  TERMINAL_CHANNEL,
  type TerminalCommand,
  type TerminalHandle,
  type TerminalViewport,
  type TerminalViewProps,
} from './types';

const MAX_PENDING_CHARACTERS = 2 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MAX_PENDING_SEGMENTS = 1024;
type OutputSegment = { data: string; allowResponses: boolean };
const OVERFLOW_NOTICE =
  '\r\n\x1b[33m[Preview skipped older data: output arrived too fast.]\x1b[0m\r\n';

/** Batch terminal bytes without making every output packet a React render. */
export function useTerminalBridge(
  props: TerminalViewProps,
  send: (command: TerminalCommand) => void,
) {
  const callbacks = useRef(props);
  const sender = useRef(send);
  const initialOutput = useRef(props.initialOutput ?? '');
  const pending = useRef<OutputSegment[]>(
    initialOutput.current
      ? [{ data: initialOutput.current.slice(-MAX_PENDING_CHARACTERS), allowResponses: true }]
      : [],
  );
  const pendingLength = useRef(Math.min(initialOutput.current.length, MAX_PENDING_CHARACTERS));
  const dropped = useRef(initialOutput.current.length > MAX_PENDING_CHARACTERS);
  const ready = useRef(false);
  const mounted = useRef(true);
  const pendingReset = useRef(false);
  const pendingFocus = useRef(false);
  const interactive = useRef(props.interactive !== false);
  const pendingViewport = useRef<TerminalViewport | null>({ readOnly: !!props.readOnly });
  const readOnly = useRef(!!props.readOnly);
  const sequence = useRef(0);
  const inFlight = useRef<number | null>(null);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const [isReady, setIsReady] = useState(false);
  callbacks.current = props;
  sender.current = send;

  const dispatch = useCallback(
    (
      command:
        | ({ type: 'write' } & OutputSegment)
        | { type: 'reset' | 'focus' | 'blur' }
        | { type: 'interaction'; enabled: boolean }
        | ({ type: 'configure' } & TerminalViewport),
    ) => {
      const id = ++sequence.current;
      // A posted message is not a completed xterm write. Keep a single chunk in
      // flight until its parser callback acknowledges completion in the renderer.
      if (command.type === 'write') inFlight.current = id;
      sender.current({ channel: TERMINAL_CHANNEL, id, ...command });
    },
    [],
  );

  function flush() {
    frame.current = null;
    if (!mounted.current || !ready.current || inFlight.current !== null) return;
    if (pendingViewport.current) {
      dispatch({ type: 'configure', ...pendingViewport.current });
      pendingViewport.current = null;
    }
    if (pendingReset.current) {
      dispatch({ type: 'reset' });
      pendingReset.current = false;
    }
    if (dropped.current) {
      dispatch({ type: 'reset' });
      dispatch({ type: 'write', data: OVERFLOW_NOTICE, allowResponses: false });
      dropped.current = false;
      // The overflow notice is also a write and needs its own completion ACK.
      return;
    }
    const segment = pending.current[0];
    if (segment) {
      // Keep surrogate pairs intact across bridge chunks.
      let end = Math.min(CHUNK_SIZE, segment.data.length);
      const last = segment.data.charCodeAt(end - 1);
      if (end < segment.data.length && last >= 0xd800 && last <= 0xdbff) end--;
      const data = segment.data.slice(0, end);
      segment.data = segment.data.slice(end);
      pendingLength.current -= end;
      if (!segment.data) pending.current.shift();
      dispatch({ type: 'write', data, allowResponses: segment.allowResponses });
    }
    if (pendingFocus.current) {
      dispatch({ type: 'focus' });
      pendingFocus.current = false;
    }
    if (pending.current.length) schedule();
  }

  function schedule() {
    if (ready.current && mounted.current && inFlight.current === null && frame.current === null) {
      frame.current = requestAnimationFrame(flush);
    }
  }

  const handle: TerminalHandle = {
    write(data, options) {
      if (!mounted.current || !data) return;
      const allowResponses = options?.allowResponses !== false;
      const tail = pending.current.at(-1);
      if (tail?.allowResponses === allowResponses) tail.data += data;
      else pending.current.push({ data, allowResponses });
      pendingLength.current += data.length;
      // Preserve response permission across coalescing while bounding both text
      // and alternating replay/live metadata, even when the renderer is stalled.
      while (
        pendingLength.current > MAX_PENDING_CHARACTERS ||
        pending.current.length > MAX_PENDING_SEGMENTS
      ) {
        const first = pending.current[0];
        if (!first) break;
        const remove =
          pending.current.length > MAX_PENDING_SEGMENTS
            ? first.data.length
            : Math.min(first.data.length, pendingLength.current - MAX_PENDING_CHARACTERS);
        first.data = first.data.slice(remove);
        pendingLength.current -= remove;
        if (!first.data) pending.current.shift();
        dropped.current = true;
      }
      schedule();
    },
    reset() {
      pending.current = [];
      pendingLength.current = 0;
      dropped.current = false;
      pendingReset.current = true;
      schedule();
    },
    focus() {
      if (readOnly.current || !interactive.current) return;
      if (ready.current) dispatch({ type: 'focus' });
      else pendingFocus.current = true;
    },
    blur() {
      pendingFocus.current = false;
      // Dismiss focus immediately, even when a large output write awaits its ACK.
      if (mounted.current && ready.current) dispatch({ type: 'blur' });
    },
    configure(options) {
      readOnly.current = options.readOnly;
      pendingViewport.current = options;
      if (options.readOnly) pendingFocus.current = false;
      schedule();
    },
  };

  function receive(value: unknown) {
    if (!mounted.current) return;
    const event = parseTerminalEvent(value);
    if (!event) return;
    if (event.type === 'ready') {
      if (ready.current) return;
      ready.current = true;
      dispatch({ type: 'interaction', enabled: interactive.current });
      setIsReady(true);
      schedule();
      callbacks.current.onReady?.();
    } else if (event.type === 'data') {
      if (!readOnly.current) callbacks.current.onData(event.data);
    } else if (event.type === 'written') {
      // Ignore stale, duplicated or fabricated acknowledgements. A reset waits
      // here too, so it cannot race a preceding asynchronous parser operation.
      if (event.id !== inFlight.current) return;
      inFlight.current = null;
      schedule();
    } else if (event.type === 'resize') {
      callbacks.current.onResize(event.cols, event.rows);
    }
  }

  useEffect(() => {
    interactive.current = props.interactive !== false;
    if (!interactive.current) pendingFocus.current = false;
    // Focus changes must not wait behind a large terminal write or its ACK.
    if (ready.current) dispatch({ type: 'interaction', enabled: interactive.current });
  }, [dispatch, props.interactive]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);

  return { handle, receive, isReady };
}
