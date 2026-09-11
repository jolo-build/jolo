import { TASK_STATES, TASK_PRIORITIES, LABEL_COLORS, TASK_LIMITS } from '../../../../packages/protocol/src/tasks.js';
import { formValue } from '../security.js';
export class TaskError extends Error {
  constructor(status, message) { super(message); this.status=status; }
}
export function value(form, key, max=200, required=false) {
  const item=formValue(form,key);
  if (item===null || item.length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item) || (required&&!item.trim())) throw new TaskError(400, `Check the ${key.replaceAll('_',' ')} field.`);
  return item.trim();
}
export const optional = (form,key,max=100) => form.has(key) ? value(form,key,max) || null : null;
export function choice(form,key,choices) { const item=value(form,key,100,true); if (!choices.includes(item)) throw new TaskError(400,`Choose a valid ${key}.`); return item; }
export function revision(form) { const r=value(form,'revision',12,true); if (!/^[1-9]\d*$/.test(r)||!Number.isSafeInteger(Number(r))) throw new TaskError(400,'Refresh the page before saving.'); return Number(r); }
export function commentBody(form) {
  const body = value(form, 'body', 8192, true);
  if (new TextEncoder().encode(body).byteLength > 8192) throw new TaskError(400, 'A comment must fit within 8 KiB.');
  return body;
}
export function taskFields(form) {
  const labels=form.getAll('label');
  if (labels.length>TASK_LIMITS.labels || new Set(labels).size!==labels.length || labels.some(id=>!uuid(id))) throw new TaskError(400,'Choose up to eight labels from this task’s workspace.');
  const description=value(form,'description',8192);
  if (new TextEncoder().encode(description).byteLength>TASK_LIMITS.descriptionBytes) throw new TaskError(400,'The description must fit within 8 KiB.');
  return { title:value(form,'title',200,true),description,project:value(form,'project',100),state:choice(form,'state',Object.keys(TASK_STATES)),priority:choice(form,'priority',TASK_PRIORITIES),labels,team:optional(form,'team'),assignee:optional(form,'assignee'),requestID:optional(form,'request_id') };
}
export const uuid = value => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const labelFields = form => ({name:value(form,'name',40,true),color:choice(form,'color',LABEL_COLORS)});
export function inviteFields(form) {
  const email=value(form,'email',254,true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TaskError(400,'Enter a valid email address.');
  return {email,role:choice(form,'role',['admin','member','viewer'])};
}
