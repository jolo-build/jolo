import React from 'react';
import { Box, Text } from './theme.jsx';

export function CommandMenu({ commands, index, count }) {
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), commands.length - count));
  return <Box flexDirection="column" paddingLeft={1}>
    {commands.slice(start, start + count).map((item, offset) => <Text key={item.command} color={index === start + offset ? 'accent' : undefined} bold={index === start + offset} wrap="truncate-end">{index === start + offset ? '› ' : '  '}{item.command}  <Text dimColor>{item.description}</Text></Text>)}
    <Text dimColor wrap="truncate-end">↑/↓ select · Enter open · Tab complete · Esc close</Text>
  </Box>;
}
