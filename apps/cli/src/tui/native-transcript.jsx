import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp } from "ink";
import { clean, line, plainTextLines, renderMarkdown } from "./markdown.js";
import { Welcome } from "./welcome.jsx";

const MAX_REASONING_LINES = 24;

/** One message as terminal lines. Every kind is bounded: scrollback is the terminal's, but the writing is ours. */
export function messageLines(message, width, showTools, detailsOnly = false) {
  if (message.evicted) return [line("[older text released]", { dim: true })];
  if (message.role === "user") return [...plainTextLines(`› ${message.text}`, width, { color: "cyan", bold: true }), line(" ")];
  if (message.kind === "reasoning") {
    const body = plainTextLines(message.text, width, { dim: true });
    const shown = body.slice(0, MAX_REASONING_LINES);
    if (body.length > shown.length) shown.push(line(`… ${body.length - shown.length} more reasoning lines`, { dim: true }));
    return [line("reasoning", { dim: true, italic: true }), ...shown, line(" ")];
  }
  if (message.kind === "tool") {
    const [head, ...rest] = message.text.split("\n");
    return [...(detailsOnly ? [] : [line(`→ ${head}`, { dim: true })]), ...(showTools ? rest.slice(0, 40).flatMap((row) => plainTextLines(row, width, { dim: true })) : []), line(" ")];
  }
  return [...renderMarkdown(message.text, { width }).lines, line(" ")];
}

export function TranscriptLines({ lines }) {
  return lines.map((entry, i) => <Text key={i} wrap="truncate-end">{entry.spans.map((span, j) => <Text key={j} color={span.color} bold={span.bold} dimColor={span.dim} italic={span.italic} underline={span.underline}>{span.text}</Text>)}</Text>);
}

// Completed messages belong to the terminal's scrollback, not a virtual viewport.
// Each batch is printed once. Replacing Static's identity releases Ink's replay
// string for the previous batch; the terminal retains the history independently.
export function useNativeTranscript({ projection, revision, opened, width, showTools, permission }) {
  const { waitUntilRenderFlush } = useApp();
  const printedOrdinal = useRef(-1);
  const expandedTools = useRef(new Set());
  const printedPermissions = useRef(new Set());
  const printedRuns = useRef(new Map());
  const flushing = useRef(true);
  const [flushed, setFlushed] = useState(0);
  const [batch, setBatch] = useState({ id: 0, items: [{ id: "welcome", welcome: true }] });
  useEffect(() => {
    if (!opened || flushing.current) return;
    const items = [];
    for (const message of projection.ordered()) {
      if (message.ordinal <= printedOrdinal.current) {
        if (showTools && message.kind === "tool" && !expandedTools.current.has(message.id)) {
          items.push({ id: `${message.id}:details`, lines: messageLines(message, width, true, true) });
          expandedTools.current.add(message.id);
        }
        continue;
      }
      if (message.status === "streaming" || (!message.evicted && message.renderedBytes < message.committedBytes)) break;
      items.push({ id: message.id, lines: messageLines(message, width, showTools) });
      if (showTools && message.kind === "tool") expandedTools.current.add(message.id);
      printedOrdinal.current = message.ordinal;
    }
    if (permission && !printedPermissions.current.has(permission.permissionId)) {
      items.push({ id: permission.permissionId, lines: [
        ...plainTextLines(`Allow the agent to run: ${permission.summary}`, width, { bold: true, color: "yellow" }),
        ...plainTextLines(`cwd ${permission.cwd} · isolation none (your user privileges)`, width, { dim: true }),
        line("[1] Deny  [2] Allow once"), line("[3] Allow task  [4] Allow project"), line(" "),
      ] });
      printedPermissions.current.add(permission.permissionId);
    }
    for (const run of projection.runs.values()) {
      // Keyed by revision, not by run: a paused run that is resumed and finishes reports its outcome again.
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.state) || printedRuns.current.get(run.id) === run.revision) continue;
      if (projection.messagesFor(run.id).some((message) => message.ordinal > printedOrdinal.current)) continue;
      items.push({ id: `${run.id}:${run.revision}:result`, lines: [
        ...(run.failure ? plainTextLines(run.failure, width, { color: "red" }) : []),
        ...(run.verification ? [line(`verification: ${run.verification.status}`, { dim: true })] : []), line(" "),
      ] });
      printedRuns.current.set(run.id, run.revision);
    }
    if (items.length) {
      flushing.current = true;
      setBatch((previous) => ({ id: previous.id + 1, items }));
    }
  }, [projection, revision, opened, width, showTools, flushed, permission]);
  useEffect(() => {
    let mounted = true;
    void waitUntilRenderFlush().then(() => {
      if (!mounted) return;
      flushing.current = false;
      setFlushed((value) => value + 1);
    });
    return () => { mounted = false; };
  }, [batch.id, waitUntilRenderFlush]);
  const live = useMemo(() => opened ? projection.ordered()
    .filter((message) => !message.evicted && message.status === "streaming" && message.text)
    .flatMap((message) => messageLines(message, width, showTools)) : [], [projection, revision, opened, width, showTools]);
  return { batch, live };
}

export function NativeTranscript({ batch, project, columns, restored = false, sessionTitle, update = null }) {
  return <Static key={batch.id} items={batch.items}>{(item) => <Box key={item.id} flexDirection="column">
    {item.welcome ? <><Text bold>Jolo <Text dimColor>{clean(project)}</Text></Text>{restored ? <Text bold>{sessionTitle ? `Restored: ${clean(sessionTitle)}` : "New session"}</Text> : <Welcome height={12} columns={columns} update={update} />}<Text> </Text></> : <TranscriptLines lines={item.lines} />}
  </Box>}</Static>;
}
