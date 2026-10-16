import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { TERMINAL_HTML } from './generated';
import type { TerminalHandle, TerminalViewProps } from './types';
import { useTerminalBridge } from './use-terminal-bridge';

export type { TerminalHandle, TerminalViewProps } from './types';

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    const iframe = useRef<HTMLIFrameElement>(null);
    const bridge = useTerminalBridge(props, command => {
      // A sandboxed srcDoc has an opaque origin; source identity authenticates the peer.
      iframe.current?.contentWindow?.postMessage(command, '*');
    });
    const receiver = useRef(bridge.receive);
    receiver.current = bridge.receive;
    useImperativeHandle(ref, () => bridge.handle);

    useEffect(() => {
      function onMessage(event: MessageEvent) {
        if (event.source !== iframe.current?.contentWindow) return;
        receiver.current(event.data);
      }
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);

    return (
      <View style={styles.container} accessibilityLabel="Terminal sesji">
        <iframe
          ref={iframe}
          inert={props.interactive === false}
          tabIndex={props.interactive === false ? -1 : 0}
          srcDoc={TERMINAL_HTML}
          title="Terminal sesji"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{
            width: '100%',
            height: '100%',
            minHeight: 0,
            flex: 1,
            border: 0,
            background: '#0D100E',
          }}
        />
        {!bridge.isReady && (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color="#E7EEE9" accessibilityLabel="Ładowanie terminala" />
          </View>
        )}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, backgroundColor: '#0D100E' },
  loading: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0D100E',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
