import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/renderer/components/conversation.jsx';
import { StopIndicator } from '../src/renderer/components/stop-indicator.jsx';
import { Icon } from '../src/renderer/components/icon.jsx';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

test('stop indicator rotates an HTML layer without rotating its stop glyph', () => {
  for (const size of [16, 20, 32]) {
    const html = renderToStaticMarkup(<StopIndicator size={size} />);
    expect(html).toContain(`<span class="stop-progress" style="width:${size}px;height:${size}px" aria-hidden="true">`);
    const rotor = html.match(/<span class="stop-progress-rotor">(.*?)<\/span>/s)?.[1];
    expect(rotor).toContain('class="stop-progress-arc"');
    expect(rotor).not.toContain('<rect');
    expect(html).toContain('<rect');
  }
  expect(styles.match(/\.stop-progress-arc\s*\{([^}]+)\}/)?.[1]).not.toMatch(/animation|transform/);
});

test('shared animated icons put animation classes on HTML layers, not SVG roots', () => {
  for (const size of [13, 15, 16]) {
    for (const animation of ['spin', 'pulse']) {
      const html = renderToStaticMarkup(<Icon name={animation === 'spin' ? 'spinner' : 'think'} size={size} className={`activity-icon activity-${animation}`} />);
      expect(html).toStartWith(`<span class="icon activity-icon activity-${animation}" style="width:${size}px;height:${size}px" aria-hidden="true"><svg`);
      expect(html).toContain(`width="${size}" height="${size}"`);
      expect(html.match(/<svg[^>]+>/)?.[0]).not.toContain('activity-');
      expect(html.match(new RegExp(`activity-${animation}`, 'g'))).toHaveLength(1);
      expect(html).toEndWith('</svg></span>');
    }
  }
  for (const className of ['', 'activity-icon', 'activity-spinner']) {
    const html = renderToStaticMarkup(<Icon name="check" className={className} />);
    expect(html).toStartWith(`<svg class="icon ${className}"`);
    expect(html).not.toContain('<span');
  }
});

test('shared activity animations declare compositing and release it for reduced motion', () => {
  expect(styles.match(/^\.activity-spin\s*\{([^}]+)\}/m)?.[1]).toContain('will-change: transform');
  expect(styles.match(/^\.activity-pulse\s*\{([^}]+)\}/m)?.[1]).toContain('will-change: opacity');
  expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.activity-spin, \.activity-pulse\s*\{[^}]*animation: none;[^}]*will-change: auto;/);
});

test('progress animation layers support compositing and reduced motion', () => {
  for (const name of ['stop-progress', 'board-progress']) {
    const rule = styles.match(new RegExp(`\\.${name}-rotor\\s*\\{([^}]+)\\}`))?.[1];
    expect(rule).toContain(`animation: ${name}-turn`);
    expect(rule).toContain('will-change: transform');
    expect(styles).toMatch(new RegExp(`@media \\(prefers-reduced-motion: reduce\\)\\s*\\{\\s*\\.${name}-rotor\\s*\\{[^}]*animation: none;[^}]*will-change: auto;`));
  }
});

// Model the tool/result/next-tool sequence that used to flash a checkmark.
// Only the activity summary's markup is read here, so the identifiers, review handles and callbacks
// a click would reach are left off and the props asserted; stubbing them would suggest this case
// exercises paths it never takes.
/**
 * @param {string | undefined} state
 * @param {string[]} statuses
 */
function summary(state, statuses) {
  const messages = statuses.map((status, index) => ({ id: `tool-${index}`, runId: 'run', kind: 'tool', role: 'tool', text: 'read file.js', status }));
  const projection = { ordered: () => messages, runs: new Map([['run', { id: 'run', state }]]) };
  const props = /** @type {import('react').ComponentProps<typeof Conversation>} */ ({ projection, hasProject: true });
  const html = renderToStaticMarkup(<Conversation {...props} />);
  return html.match(/<details class="activity-group"><summary>(.*?)<span class="activity-label"/s)[1];
}

test('activity icon stays stable through tool completion gaps and later calls', () => {
  const active = summary('tools', ['streaming']);
  expect(summary('model', ['complete'])).toBe(active);
  expect(summary('tools', ['complete', 'streaming'])).toBe(active);
  expect(summary('awaiting_permission', ['complete'])).toBe(active);
  expect(summary('completed', ['complete'])).not.toBe(active);
});

test('failed, interrupted, and missing run states never imply successful completion', () => {
  const active = summary('tools', ['streaming']);
  for (const state of ['failed', 'interrupted', 'cancelled', undefined]) {
    expect(summary(state, ['complete'])).toBe(active);
  }
});
