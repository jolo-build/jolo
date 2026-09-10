/** Shared by the prompt's session menu and the headless session commands. */
export function parseSessionCommand(text) {
  const parts = text.trim().split(/\s+/);
  if (!["/session", "/sessions"].includes(parts[0])) return null;
  const action = parts[1] ?? "list";
  if (!["list", "restore", "delete"].includes(action) || parts.length > 3 || (action === "list" && parts[2])) return { error: "Use /session list, /session restore <id>, or /session delete <id>" };
  return { action, sessionId: parts[2] ?? null };
}

export async function listSessions(client, projectId, includeArchived = true) {
  const filter = projectId ? { projectId } : {};
  const reports = await Promise.all([client.call("session.list", filter), ...(includeArchived ? [client.call("session.list", { ...filter, state: "archived" })] : [])]);
  return reports.flatMap((report) => report.sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getSession(client, sessionId, projectId) {
  const { session } = await client.call("session.page", { sessionId });
  if (projectId && session.projectId !== projectId) throw new Error("This session belongs to another project. Use jolo session restore <id> to open it.");
  return session;
}

export async function restoreSession(client, sessionId, projectId) {
  let session = await getSession(client, sessionId, projectId);
  if (session.state === "archived") session = (await client.call("session.archive", { sessionId, expectedRevision: session.revision, archived: false })).session;
  return session;
}

export async function deleteSession(client, session) {
  // The revision is the one the user reviewed. A changed or running session must be refreshed first.
  return client.call("session.delete", { sessionId: session.id, expectedRevision: session.revision });
}
