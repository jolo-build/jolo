import { ProtocolError, WebTaskSchema, WebTaskSummarySchema } from '@jolo/protocol';
import { taskKey, taskReferences, taskLinkReferences, webTaskPath, taskContext, TASK_LIMITS } from '@jolo/protocol/tasks';

export class TaskService {
  constructor(account) { this.account=account; }
  /** @param {{q?:string,before?:number,team?:string}} [options] `before` is the cursor the previous page returned */
  async list({q='',before,team}={}) {
    const query=new URLSearchParams({q}); if(before) query.set('before',String(before)); if(team) query.set('team',team);
    const result=await this.account.taskRequest('/api/tasks?'+query);
    try {
      if(!Array.isArray(result.value.tasks)||result.value.tasks.length>20) throw new Error();
      const next=result.value.next;
      if(next!==null&&(!Number.isSafeInteger(next)||next<1)) throw new Error();
      return {tasks:result.value.tasks.map(task=>({...WebTaskSummarySchema.parse(task),url:`${result.origin}${webTaskPath(task,result.accountId)}`})),next};
    } catch { throw new ProtocolError('unavailable','The task service returned an invalid task list.'); }
  }
  /** @param {string} key @param {{team?:string,link?:ReturnType<typeof taskLinkReferences>[number]}} [options] */
  async read(key, {team, link} = {}) {
    const normalized=taskKey(key);
    if(!normalized) throw new ProtocolError('invalid_params','Use a task ID such as JOLO-123.');
    const result=await this.account.taskRequest(link ? `/api${link.path}` : `/api/tasks/${normalized}${team?'?team='+encodeURIComponent(team):''}`);
    let task;
    try {
      task=WebTaskSchema.parse(result.value.task);
      if ((team && (task.team?.id ?? 'personal') !== team) || (link && (result.origin !== link.origin || (link.kind === 'teams' ? task.team?.id !== link.scope : task.team !== null || result.accountId !== link.scope)))) throw new Error();
      if(task.key!==normalized||task.archivedAt||Buffer.byteLength(task.description)>TASK_LIMITS.descriptionBytes) throw new Error();
    } catch { throw new ProtocolError('unavailable',`Could not validate ${normalized}. Refresh the task and try again.`); }
    return {...result,task:{...task,url:`${result.origin}${webTaskPath(task,result.accountId)}`}};
  }
  async get({key,team=undefined}) { return {task:(await this.read(key,{team})).task}; }
  async resolve(prompt) {
    const keys=taskReferences(prompt), links=taskLinkReferences(prompt,this.account.origin);
    if(keys.length+links.length>TASK_LIMITS.references) throw new ProtocolError('limit_exceeded','Reference up to four web tasks in one message.');
    const results=await Promise.all([...keys.map(key=>this.read(key)),...links.map(link=>this.read(link.key,{link}))]);
    const refs=results.map(result=>({...result.task,origin:result.origin,accountId:result.accountId}));
    if(Buffer.byteLength(taskContext(refs))>TASK_LIMITS.contextBytes) throw new ProtocolError('limit_exceeded','The referenced tasks are too large for one message. Reference fewer tasks.');
    return {references:refs,assertCurrent:()=>{
      if(results.some(result=>!result.current()||result.accountId!==results[0].accountId||result.origin!==results[0].origin)) throw new ProtocolError('conflict','Your account connection changed. Send the message again.');
    }};
  }
}
