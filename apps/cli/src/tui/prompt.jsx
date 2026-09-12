import React from "react";
import { Box, Text } from "ink";
import { clean } from "./markdown.js";

/** Keep the padded composer and straight edge, using the terminal’s own light or dark palette. */
export function Prompt({ value, model, columns }) {
  const text = clean(value).replace(/\n/g, " ");
  return <Box flexDirection="column" width="100%">
    <Box flexDirection="column" width="100%">
      <Text>▎</Text>
      <Box height={1}>
        <Text>▎</Text><Text bold>❯ </Text>
        <Box flexGrow={1} minWidth={0} paddingRight={2}>
          <Text wrap="truncate-start">{text}{text ? <Text inverse> </Text> : <><Text inverse> </Text><Text>Ask Jolo anything…</Text></>}</Text>
        </Box>
      </Box>
      <Text>▎</Text>
    </Box>
    <Box width={Math.min(columns, 64)} paddingLeft={1} height={1}>
      <Text wrap="truncate-end">{clean(model)} · /model · /sessions</Text>
    </Box>
  </Box>;
}
