import React from "react";
import { Box, Text } from "./theme.jsx";
import { clean } from "./markdown.js";
import { inputRows } from "./input.js";

/** Keep the padded composer and straight edge, using the active theme. */
export function Prompt({ value, cursor = value.length, model, columns, running = false, maxRows = 6 }) {
  const views = inputRows(value, cursor, Math.max(1, columns - 5), maxRows);
  return <Box flexDirection="column" width="100%">
    <Box flexDirection="column" width="100%" backgroundColor="surface">
      <Text color="accent">▎</Text>
      {views.map(view => <Box key={view.index} height={1}>
        <Text color="accent">▎</Text><Text bold color="accent">{view.index === 0 ? "❯ " : "· "}</Text>
        <Box flexGrow={1} minWidth={0} paddingRight={2}>
          <Text wrap="truncate-end">{view.before}<Text inverse={view.active}>{view.caret}</Text>{view.after}{!value && <Text dimColor>{running ? "Queue a message… Enter twice to send now" : "Ask Jolo anything…"}</Text>}</Text>
        </Box>
      </Box>)}
      <Text color="accent">▎</Text>
    </Box>
    <Box width={Math.min(columns, 64)} paddingLeft={1} height={1}>
      <Text wrap="truncate-end">{clean(model)}</Text>
    </Box>
  </Box>;
}
