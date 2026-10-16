import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Standalone integration test: the real React hook talks to the real bundled
// xterm in a sandboxed iframe. Delayed ACK delivery simulates a slow renderer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bundle = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backpressure-harness.jsx',
    loader: 'jsx',
    contents: `
      import React, { useEffect, useRef } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useTerminalBridge } from './src/terminal/useTerminalBridge';
      import { TERMINAL_HTML } from './src/terminal/generated';
      function Harness() {
        const iframe = useRef(null);
        const state = useRef({ ready: false, hold: false, held: [], outstanding: 0,
          maxOutstanding: 0, writes: 0, maxChunk: 0, characters: 0, resets: 0,
          overflowNotice: false });
        const bridge = useTerminalBridge({ onData() {}, onResize() {} }, command => {
          const stats = state.current;
          if (command.type === 'write') {
            stats.outstanding++;
            stats.maxOutstanding = Math.max(stats.maxOutstanding, stats.outstanding);
            stats.writes++;
            stats.maxChunk = Math.max(stats.maxChunk, command.data.length);
            stats.characters += command.data.length;
            stats.overflowNotice ||= command.data.includes('Podgląd pominął starsze dane');
          } else if (command.type === 'reset') stats.resets++;
          iframe.current.contentWindow.postMessage(command, '*');
        });
        const receiver = useRef(bridge.receive);
        receiver.current = bridge.receive;
        const handle = useRef(bridge.handle);
        handle.current = bridge.handle;
        state.current.ready = bridge.isReady;
        useEffect(() => {
          function deliver(message) {
            if (message.type === 'written') state.current.outstanding--;
            receiver.current(message);
          }
          function receive(event) {
            if (event.source !== iframe.current.contentWindow) return;
            if (event.data.type === 'written' && state.current.hold) {
              state.current.held.push(event.data);
            } else deliver(event.data);
          }
          window.addEventListener('message', receive);
          window.harness = {
            stats: state.current,
            write: data => handle.current.write(data),
            reset: () => handle.current.reset(),
            hold: () => { state.current.hold = true; },
            release: () => {
              state.current.hold = false;
              for (const message of state.current.held.splice(0)) deliver(message);
            },
            invalidAck: () => receiver.current({ channel: 'pocket-terminal', type: 'written', id: 999999 }),
          };
          return () => window.removeEventListener('message', receive);
        }, []);
        return <iframe ref={iframe} title="Terminal stress test" sandbox="allow-scripts"
          srcDoc={TERMINAL_HTML} style={{width: 390, height: 600, border: 0}} />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});

try {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.harness?.stats.ready);
  const terminal = page.frameLocator('iframe');

  await page.evaluate(() => {
    window.harness.hold();
    window.harness.write('x'.repeat(65536));
  });
  await page.waitForFunction(() => window.harness.stats.held.length === 1);
  await page.evaluate(() => {
    for (let index = 0; index < 128; index++) window.harness.write('N'.repeat(65536));
    window.harness.write('\r\nTAIL_AFTER_FLOOD\r\n');
    window.harness.invalidAck();
  });
  // Several animation frames pass while the completion is withheld. Posting
  // more output must not fill xterm's internal WriteBuffer in that interval.
  await page.waitForTimeout(150);
  const stalled = await page.evaluate(() => window.harness.stats);
  assert.equal(stalled.writes, 1, 'No additional chunk before its matching ACK');
  assert.equal(stalled.outstanding, 1);

  await page.evaluate(() => window.harness.release());
  await terminal.getByText('TAIL_AFTER_FLOOD', { exact: false }).first().waitFor();
  await page.waitForFunction(() => window.harness.stats.outstanding === 0);
  const drained = await page.evaluate(() => window.harness.stats);
  assert.equal(drained.maxOutstanding, 1);
  assert.ok(drained.maxChunk <= 65536);
  assert.ok(drained.overflowNotice, 'Dropped output is visibly reported');
  assert.ok(
    drained.characters <= 2 * 1024 * 1024 + 65536 + 256,
    'Pending output remains capped at 2 MiB',
  );

  await page.evaluate(() => {
    window.harness.hold();
    window.harness.write('\r\nBEFORE_RESET\r\n');
  });
  await page.waitForFunction(() => window.harness.stats.held.length === 1);
  const resetsBefore = await page.evaluate(() => window.harness.stats.resets);
  await page.evaluate(() => {
    window.harness.reset();
    window.harness.write('AFTER_RESET\r\n');
  });
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => window.harness.stats.resets),
    resetsBefore,
    'Reset waits for the preceding write ACK',
  );
  await page.evaluate(() => window.harness.release());
  await terminal.getByText('AFTER_RESET', { exact: false }).first().waitFor();
  const text = await terminal.locator('.xterm-rows').innerText();
  assert.ok(!text.includes('BEFORE_RESET'));
  assert.equal(await page.evaluate(() => window.harness.stats.maxOutstanding), 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 8 MiB flood, one in-flight chunk, bounded 2 MiB pending output, overflow notice, stale ACK rejection and ordered reset.',
  );
} finally {
  await browser.close();
}
