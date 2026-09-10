// Opaque continuation data belongs to an endpoint, protocol and model. Legacy data is Responses-only.
export function nativeFor(item, options) {
  if (!item.payload.native) return null;
  const tag = item.payload.nativeRef;
  if (!tag) return options.protocol === 'openai-responses' ? item.payload.native : null;
  return tag.protocol === options.protocol && tag.model === options.model && tag.preset === (options.preset ?? 'openai') && (!tag.baseUrl || tag.baseUrl === options.baseUrl) ? item.payload.native : null;
}
export function portableItems(items, options) {
  return items.flatMap(item => {
    const native = nativeFor(item, options);
    if (item.kind === 'reasoning' && !native) return [];
    return [{ ...item, payload: { ...item.payload, native } }];
  });
}
export function itemGroups(items) {
  const groups = [];
  for (const item of items) {
    if (groups.at(-1)?.id !== item.groupId) groups.push({ id: item.groupId, items: [] });
    groups.at(-1).items.push(item);
  }
  return groups;
}
// A cancelled or paused batch can leave a tool call without a result. Every protocol rejects such history,
// so the request answers it in place; the stored transcript is untouched and a resumed run still executes it.
export function completeToolCalls(items) {
  const answered = new Set(items.filter(item => item.kind === 'tool_result').map(item => item.payload.callId));
  return itemGroups(items).flatMap(group => [...group.items, ...group.items
    .filter(item => item.kind === 'tool_call' && !answered.has(item.payload.callId))
    .map(item => ({ ...item, kind: 'tool_result', payload: { callId: item.payload.callId, output: JSON.stringify({ ok: false, error: 'This tool call was interrupted before it ran. Call it again if its result is still needed.' }) } }))]);
}
// Preserve ordering within an assistant turn; merge adjacent roles for Messages/GenerateContent.
export function appendContent(messages, role, parts, field = 'content') {
  if (!parts.length) return;
  if (messages.at(-1)?.role === role) messages.at(-1)[field].push(...parts);
  else messages.push({ role, [field]: parts });
}
