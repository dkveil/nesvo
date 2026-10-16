import { forwardRef, useImperativeHandle, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { TERMINAL_HTML } from './generated';
import type { TerminalHandle, TerminalViewProps } from './types';
import { useTerminalBridge } from './useTerminalBridge';

export type { TerminalHandle, TerminalViewProps } from './types';

const HTML_SOURCE = { html: TERMINAL_HTML };

const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    // WebView 14 defaults its extra-props generic to undefined, which intersects
    // the props to never under TypeScript 6. unknown preserves its actual props.
    const webView = useRef<WebView<unknown>>(null);
    const bridge = useTerminalBridge(props, (command) => {
      webView.current?.postMessage(JSON.stringify(command));
    });
    useImperativeHandle(ref, () => bridge.handle);

    return (
      <View style={styles.container} accessibilityLabel="Terminal sesji">
        <WebView<unknown>
          ref={webView}
          source={HTML_SOURCE}
          style={styles.webView}
          containerStyle={styles.container}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
          onMessage={(event) => bridge.receive(event.nativeEvent.data)}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          allowsLinkPreview={false}
          dataDetectorTypes="none"
          mixedContentMode="never"
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          keyboardDisplayRequiresUserAction
          hideKeyboardAccessoryView
          textZoom={100}
          setBuiltInZoomControls={false}
          renderError={() => (
            <View style={styles.loading}>
              <Text style={styles.error}>
                Nie udało się otworzyć terminala. Otwórz sesję ponownie.
              </Text>
            </View>
          )}
        />
        {!bridge.isReady && (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color="#F4F4F4" accessibilityLabel="Ładowanie terminala" />
          </View>
        )}
      </View>
    );
  },
);

export default TerminalView;

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, backgroundColor: '#0B0B0B' },
  webView: { flex: 1, backgroundColor: '#0B0B0B' },
  loading: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0B0B0B',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  error: { color: '#A1A1A1', textAlign: 'center', fontSize: 14 },
});
