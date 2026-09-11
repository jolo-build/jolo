import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { clean } from "./markdown.js";
import { deleteSession, getSession, listSessions, restoreSession } from "../sessions.js";

export function SessionMenu({ client, project, currentId, command, rows, columns, paused, onRestore, onDelete, onClose }) {
  const [sessions, setSessions] = useState([]);
  const [index, setIndex] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const [note, setNote] = useState("Loading sessions…");
  // Either the name of the work in progress, which decides what Escape does, or false for idle.
  const [busy, setBusy] = useState(/** @type {"loading" | "restoring" | "deleting" | false} */ ("loading"));
  const mounted = useRef(true);
  const load = () => listSessions(client, project.projectId);
  const open = async (session) => {
    setBusy("restoring"); setNote("Restoring session…");
    try {
      const restored = await restoreSession(client, session.id, project.projectId);
      if (mounted.current) onRestore(restored);
    } catch (error) { if (mounted.current) { setNote(error.message); setBusy(false); } }
  };
  useEffect(() => {
    mounted.current = true;
    void load().then(async (saved) => {
      // A known ID remains usable even when it falls outside the bounded recent list.
      if (command.sessionId && !saved.some((session) => session.id === command.sessionId)) {
        saved = [await getSession(client, command.sessionId, project.projectId), ...saved];
      }
      if (!mounted.current) return;
      setSessions(saved); setBusy(false); setNote(saved.length ? "" : "No saved sessions in this project.");
      if (command.sessionId) {
        const found = saved.findIndex((session) => session.id === command.sessionId);
        if (found < 0) setNote("Session not found in this project's saved sessions.");
        else {
          setIndex(found);
          if (command.action === "delete") setConfirm(saved[found]);
          if (command.action === "restore") void open(saved[found]);
        }
      }
    }).catch((error) => { if (mounted.current) { setNote(error.message); setBusy(false); } });
    return () => { mounted.current = false; };
  }, [client, project.projectId, command]);

  const remove = async () => {
    setBusy("deleting");
    try {
      await deleteSession(client, confirm);
      if (!mounted.current) return;
      if (confirm.id === currentId) { onDelete(confirm.id); return; }
      const remaining = await load();
      if (!mounted.current) return;
      setSessions(remaining); setIndex(Math.max(0, Math.min(index, remaining.length - 1))); setConfirm(null); setNote("Session deleted.");
    } catch (error) { if (mounted.current) { setNote(error.message); setConfirm(null); } }
    finally { if (mounted.current) setBusy(false); }
  };

  useInput((chunk, key) => {
    if (key.eventType === "release") return;
    if ((key.ctrl && chunk === "c") || key.escape) {
      if (busy && busy !== "loading") return;
      if (confirm) { setConfirm(null); setNote(""); } else onClose();
      return;
    }
    if (busy || rows < 8 || columns < 32) return;
    if (confirm) { if (key.return) void remove(); return; }
    if (key.upArrow) setIndex(Math.max(0, index - 1));
    else if (key.downArrow) setIndex(Math.min(sessions.length - 1, index + 1));
    else if (sessions[index] && (chunk === "d" || key.delete)) { setConfirm(sessions[index]); setNote(""); }
    else if (key.return && sessions[index]) {
      if (command.action === "delete") setConfirm(sessions[index]); else void open(sessions[index]);
    }
  }, { isActive: !paused });

  if (rows < 8 || columns < 32) return <Text wrap="truncate-end">Enlarge terminal · Esc closes sessions</Text>;
  const count = Math.max(1, rows - 7);
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), sessions.length - count));
  return <Box flexDirection="column" width="100%" borderStyle="round" borderColor="gray" paddingX={1}>
    <Text bold>Sessions{confirm ? " / Delete" : " / Recent"}</Text>
    {confirm ? <>
      <Text wrap="truncate-end">Delete “{clean(confirm.title || "Untitled") }”?</Text>
      <Text dimColor wrap="truncate-end">{confirm.id}</Text>
      <Text wrap="truncate-end">This removes the saved conversation.</Text>
      <Text dimColor wrap="truncate-end">Enter delete · Esc cancel</Text>
    </> : <>
      <Text dimColor wrap="truncate-end">{clean(project.rootPath)}</Text>
      {sessions.slice(start, start + count).map((session, offset) => <Text key={session.id} bold={start + offset === index} wrap="truncate-end">{start + offset === index ? "› " : "  "}{clean(session.title || "Untitled")}{session.id === currentId ? " · current" : ""}{session.state === "archived" ? " · archived" : ""} · {session.updatedAt.slice(0, 10)}</Text>)}
      <Text dimColor wrap="truncate-end">{sessions[index]?.id ?? ""}</Text>
      <Text dimColor wrap="truncate-end">↑/↓ select · Enter restore · d delete · Esc close</Text>
    </>}
    {note && <Text dimColor wrap="truncate-end">{clean(note)}</Text>}
  </Box>;
}
