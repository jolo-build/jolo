// The progress line: a spinner while a run is busy, its outcome symbol once it stops.
import React, { useEffect, useState } from "react";
import { Box, Text } from "./theme.jsx";
import { runProgress, elapsedTime } from "./progress.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Progress({ run, tools, message, compact = false }) {
  const progress = runProgress(run, tools, message);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!progress.busy) return;
    const timer = setInterval(() => setTick((value) => value + 1), 125);
    return () => clearInterval(timer);
  }, [progress.busy]);
  const elapsed = run && elapsedTime(run.createdAt, progress.busy ? new Date().toISOString() : run.updatedAt);
  const color = run?.state === "failed" ? "error" : run?.state === "completed" ? "success" : progress.busy ? "accent" : undefined;
  if (compact) return <Text color={color} wrap="truncate-end">{progress.busy ? FRAMES[tick % FRAMES.length] : progress.symbol} {progress.label}<Text dimColor>{elapsed ? ` · ${elapsed}` : ""}{progress.busy ? " · Esc stop" : ""}</Text></Text>;
  return <Box height={1} flexShrink={0}>
    <Text color={color}>{progress.busy ? FRAMES[tick % FRAMES.length] : progress.symbol} </Text>
    <Box flexGrow={1} minWidth={0}><Text wrap="truncate-end">{progress.label}<Text dimColor>{elapsed ? ` · ${elapsed}` : ""}{progress.completed ? ` · ${progress.completed} tool${progress.completed === 1 ? "" : "s"} done` : ""}</Text></Text></Box>
    {progress.busy && <Text dimColor> Esc stop</Text>}
  </Box>;
}
