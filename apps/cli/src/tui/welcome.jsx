// First-run panel for the interactive client: the shortcuts a new user needs,
// degrading by height so a short terminal still shows something useful.
import React from "react";
import { Box, Text } from "ink";

const LOGO = [
  "     _       _       ",
  "    | | ___ | | ___  ",
  " _  | |/ _ \\| |/ _ \\ ",
  "| |_| | (_) | | (_) |",
  " \\___/ \\___/|_|\\___/ ",
];

/**
 * `hasHistory` decides which pair of shortcuts is worth showing first. Its one caller does not
 * pass it, so the panel shows the shortcuts for a terminal with nothing above it.
 * @param {{ height: number, columns: number, hasHistory?: boolean, update?: { latest?: string } | null }} props
 */
export function Welcome({ height, columns, hasHistory, update = null }) {
  const roomy = height >= 12;
  // A new release is news, not an interruption: one line, and only where there is room for it.
  const release = update?.latest && /^[0-9A-Za-z.-]{1,64}$/.test(update.latest) ? update.latest : null;
  return <Box flexDirection="column" height={height} justifyContent="center" alignItems="center" overflow="hidden">
    {roomy && <Box flexDirection="column" marginBottom={1}>{LOGO.map((row, i) => <Text bold key={i}>{row}</Text>)}</Box>}
    {height > 0 && <Text bold wrap="truncate-end">Welcome to Jolo</Text>}
    {height > 2 && <Text dimColor wrap="truncate-end">{columns >= 60 ? "Build something. Fix a bug. Explore your project." : "What would you like to build?"}</Text>}
    {roomy && <Box flexDirection="column" marginTop={1} alignItems="center">
      <Text dimColor wrap="truncate-end">{hasHistory ? <>Type <Text>a task</Text>  ·  Enter <Text>view chat</Text></> : <>Enter <Text>send</Text>  ·  Tab <Text>tool output</Text></>}</Text>
      <Text dimColor wrap="truncate-end">↑/↓ <Text>prompts</Text>  ·  Ctrl+C <Text>exit</Text></Text>
      <Text dimColor wrap="truncate-end">/model <Text>configure</Text>  ·  /sessions <Text>saved chats</Text></Text>
      {release && <Text dimColor wrap="truncate-end">Jolo {release} available  ·  <Text>jolo update</Text></Text>}
    </Box>}
  </Box>;
}
