// Route to the pane that owns this workspace, including a retained background scope.
export function browserTarget(controllers, workspaceId, activeId, sessionId = null) {
  const entries = [...controllers];
  if (sessionId) {
    const owner = entries.find(([, c]) => c.workspaceId === workspaceId && c.sessionId === sessionId)
      ?? entries.find(([, c]) => c.browserChatScopes?.some(origin => origin.workspaceId === workspaceId && origin.sessionId === sessionId));
    if (!owner) throw new Error('the requested chat is no longer open');
    return owner;
  }
  const matches = entries.filter(([, controller]) => controller.workspaceId === workspaceId);
  const target = matches.find(([, controller]) => controller.hasBrowser) ?? matches.find(([id]) => id === activeId) ?? matches[0]
    ?? entries.find(([, controller]) => controller.browserWorkspaceIds?.includes(workspaceId));
  if (!target) throw new Error('the requested workspace is no longer open');
  return target;
}
