import React from "react";
import { Box, Text } from "ink";
import { clean } from "./markdown.js";

/** A padded composer; keep controls below it so the typing area has its own surface. */
// User-approved style: preserve the surface, padding, straight edge, and footer when adding behavior.
export function Prompt({ value, model, columns }) {
  const text = clean(value).replace(/\n/g, " ");
  return <Box flexDirection="column" width="100%">
    <Box flexDirection="column" width="100%" backgroundColor="#242424">
      <Text color="#737373">▎</Text>
      <Box height={1}>
        <Text color="#737373">▎ </Text><Text color="#f5f5f5" bold>› </Text>
        <Box flexGrow={1} minWidth={0} paddingRight={2}>
          <Text color="#f5f5f5" wrap="truncate-start">{text}{text ? <Text inverse> </Text> : <><Text inverse> </Text><Text color="#a3a3a3">Ask Jolo anything…</Text></>}</Text>
        </Box>
      </Box>
      <Text color="#737373">▎</Text>
    </Box>
    <Box width={Math.min(columns, 64)} paddingLeft={2} height={1}>
      <Text dimColor wrap="truncate-end">{clean(model)} · /model · /sessions</Text>
    </Box>
  </Box>;
}
