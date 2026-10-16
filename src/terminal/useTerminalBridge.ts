import { useEffect, useRef, useState } from 'react';

import {
  parseTerminalEvent,
  TERMINAL_CHANNEL,
  type TerminalCommand,
  type TerminalHandle,
  type TerminalViewProps,
} from './types';

const MAX_PENDING_CHARACTERS = 2 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const OVERFLOW_NOTICE =
  '\r\n\x1b[33m[Podgląd pominął starsze dane: wyjście napływało zbyt szybko.]\x1b[0m\r\n';

/** Batch terminal bytes without making every output packet a React render. */
export function useTerminalBridge(
  props: TerminalViewProps,
  send: (command: TerminalCommand) => void,
) {
  const callbacks = useRef(props);
  const sender = useRef(send);
  const initialOutput = useRef(props.initialOutput ?? '');
  const pending = useRef(initialOutput.current.slice(-MAX_PENDING_CHARACTERS));
  const dropped = useRef(initialOutput.current.length > MAX_PENDING_CHARACTERS);
  const ready = useRef(false);
  const mounted = useRef(true);
  const pendingReset = useRef(false);
  const pendingFocus = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef<number | null>(null);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const [isReady, setIsReady] = useState(false);
  callbacks.current = props;
  sender.current = send;

  function dispatch(command: { type: 'write'; data: string } | { type: 'reset' | 'focus' }) {
    const id = ++sequence.current;
    // A posted message is not a completed xterm write. Keep a single chunk in
    // flight until its parser callback acknowledges completion in the renderer.
    if (command.type === 'write') inFlight.current = id;
    sender.current({ channel: TERMINAL_CHANNEL, id, ...command });
  }

  function flush() {
    frame.current = null;
    if (!mounted.current || !ready.current || inFlight.current !== null) return;
    if (pendingReset.current) {
      dispatch({ type: 'reset' });
      pendingReset.current = false;
    }
    if (dropped.current) {
      dispatch({ type: 'reset' });
      dispatch({ type: 'write', data: OVERFLOW_NOTICE });
      dropped.current = false;
      // The overflow notice is also a write and needs its own completion ACK.
      return;
    }
    if (pending.current) {
      // Keep surrogate pairs intact across bridge chunks.
      let end = Math.min(CHUNK_SIZE, pending.current.length);
      const last = pending.current.charCodeAt(end - 1);
      if (end < pending.current.length && last >= 0xd800 && last <= 0xdbff) end--;
      const data = pending.current.slice(0, end);
      pending.current = pending.current.slice(end);
      dispatch({ type: 'write', data });
    }
    if (pendingFocus.current) {
      dispatch({ type: 'focus' });
      pendingFocus.current = false;
    }
    if (pending.current) schedule();
  }

  function schedule() {
    if (ready.current && mounted.current && inFlight.current === null && frame.current === null) {
      frame.current = requestAnimationFrame(flush);
    }
  }

  const handle: TerminalHandle = {
    write(data) {
      if (!mounted.current || !data) return;
      pending.current += data;
      if (pending.current.length > MAX_PENDING_CHARACTERS) {
        pending.current = pending.current.slice(-MAX_PENDING_CHARACTERS);
        dropped.current = true;
      }
      schedule();
    },
    reset() {
      pending.current = '';
      dropped.current = false;
      pendingReset.current = true;
      schedule();
    },
    focus() {
      if (ready.current) dispatch({ type: 'focus' });
      else pendingFocus.current = true;
    },
  };

  function receive(value: unknown) {
    if (!mounted.current) return;
    const event = parseTerminalEvent(value);
    if (!event) return;
    if (event.type === 'ready') {
      if (ready.current) return;
      ready.current = true;
      setIsReady(true);
      schedule();
      callbacks.current.onReady?.();
    } else if (event.type === 'data') {
      callbacks.current.onData(event.data);
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
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);

  return { handle, receive, isReady };
}
