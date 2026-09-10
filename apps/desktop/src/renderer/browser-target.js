// Chat may reveal its own page, but only a user can replace another workspace's browser.
export function browserTarget(controllers, workspaceId, activeId) {
  const entries = [...controllers];
  if (entries.some(([, controller]) => controller.hasBrowser && controller.workspaceId !== workspaceId)) {
    throw Object.assign(new Error('the inline browser is open in another workspace; its page has been left untouched'), { code: 'browser_busy' });
  }
  const matches = entries.filter(([, controller]) => controller.workspaceId === workspaceId);
  const target = matches.find(([, controller]) => controller.hasBrowser) ?? matches.find(([id]) => id === activeId) ?? matches[0];
  if (!target) throw new Error('the requested workspace is no longer open');
  return target;
}
