import { forwardRef, useImperativeHandle, useRef } from 'react';

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { WebView } from 'react-native-webview';

import { colors } from '@shared/theme';

import { TERMINAL_HTML } from './generated';
import type { TerminalHandle, TerminalViewProps } from './types';
import { useTerminalBridge } from './use-terminal-bridge';

export type { TerminalHandle, TerminalViewProps } from './types';

const HTML_SOURCE = { html: TERMINAL_HTML };

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    // Keep the extra-props generic neutral across supported WebView versions.
    const webView = useRef<WebView<unknown>>(null);
    const bridge = useTerminalBridge(props, command => {
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
          onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
          onMessage={event => bridge.receive(event.nativeEvent.data)}
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
            <ActivityIndicator color={colors.accent} accessibilityLabel="Ładowanie terminala" />
          </View>
        )}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, backgroundColor: colors.background },
  webView: { flex: 1, backgroundColor: colors.background },
  loading: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  error: { color: colors.muted, textAlign: 'center', fontSize: 14 },
});
