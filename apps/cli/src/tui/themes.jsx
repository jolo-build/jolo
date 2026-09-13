import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useTheme } from './theme.jsx';
import { clean } from './markdown.js';

export function ThemeMenu({ rows, columns, paused, onClose }) {
  const { store, theme, choose } = useTheme();
  const [catalog, setCatalog] = useState(() => store.list());
  const [selected, setSelected] = useState(theme.id);
  const [note, setNote] = useState('');
  useEffect(() => {
    const timer = setInterval(() => {
      try { const next = store.list(); setCatalog((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next); }
      catch (error) { setNote(error.message); }
    }, 1000);
    return () => clearInterval(timer);
  }, [store]);
  const index = Math.max(0, catalog.themes.findIndex((item) => item.id === selected));
  useInput((chunk, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || (key.ctrl && chunk === 'c')) { onClose(); return; }
    if (key.upArrow || key.downArrow) {
      const next = Math.max(0, Math.min(catalog.themes.length - 1, index + (key.upArrow ? -1 : 1)));
      setSelected(catalog.themes[next].id);
    } else if (key.return) {
      try { choose(catalog.themes[index].id); onClose(); }
      catch (error) { setNote(error.message); }
    }
  }, { isActive: !paused });
  if (rows < 8 || columns < 32) return <Text>Enlarge terminal · Esc closes themes</Text>;
  const count = Math.max(1, rows - 8);
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), catalog.themes.length - count));
  return <Box flexDirection="column" width="100%" borderStyle="round" borderColor="gray" paddingX={1}>
    <Text bold color="accent">Themes</Text>
    {catalog.themes.slice(start, start + count).map((item, offset) => <Text key={item.id} bold={index === start + offset} color={index === start + offset ? 'accent' : undefined} wrap="truncate-end">{index === start + offset ? '› ' : '  '}{item.name}{item.id === theme.id ? ' · current' : ''}{!item.builtin ? ' · installed' : ''}</Text>)}
    <Text dimColor wrap="truncate-end">↑/↓ select · Enter apply · Esc close</Text>
    <Text dimColor wrap="truncate-end">/theme create &lt;id&gt; --from &lt;id&gt; · /theme install &lt;file-or-url&gt;</Text>
    <Text dimColor wrap="truncate-end">{clean(note || catalog.errors[0] || 'Custom theme edits reload automatically.')}</Text>
  </Box>;
}
