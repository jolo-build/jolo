import { ProtocolError, WebTaskSchema, WebTaskSummarySchema } from '@jolo/protocol';
import { taskKey, taskReferences, taskContext, TASK_LIMITS } from '@jolo/protocol/tasks';

export class TaskService {
  constructor(account) { this.account=account; }
  /** @param {{q?:string,before?:number}} [options] `before` is the cursor the previous page returned */
  async list({q='',before}={}) {
    const query=new URLSearchParams({q}); if(before) query.set('before',String(before));
    const result=await this.account.taskRequest('/api/tasks?'+query);
    try {
      if(!Array.isArray(result.value.tasks)||result.value.tasks.length>20) throw new Error();
      const next=result.value.next;
      if(next!==null&&(!Number.isSafeInteger(next)||next<1)) throw new Error();
      return {tasks:result.value.tasks.map(task=>({...WebTaskSummarySchema.parse(task),url:`${result.origin}/tasks/${task.key}`})),next};
    } catch { throw new ProtocolError('unavailable','The task service returned an invalid task list.'); }
  }
  async read(key) {
    const normalized=taskKey(key);
    if(!normalized) throw new ProtocolError('invalid_params','Use a task ID such as JOLO-123.');
    const result=await this.account.taskRequest(`/api/tasks/${normalized}`);
    let task;
    try {
      task=WebTaskSchema.parse(result.value.task);
      if(task.key!==normalized||task.archivedAt||Buffer.byteLength(task.description)>TASK_LIMITS.descriptionBytes) throw new Error();
    } catch { throw new ProtocolError('unavailable',`Could not validate ${normalized}. Refresh the task and try again.`); }
    return {...result,task:{...task,url:`${result.origin}/tasks/${normalized}`}};
  }
  async get({key}) { return {task:(await this.read(key)).task}; }
  async resolve(prompt) {
    const keys=taskReferences(prompt);
    if(keys.length>TASK_LIMITS.references) throw new ProtocolError('limit_exceeded','Reference up to four web tasks in one message.');
    const results=await Promise.all(keys.map(key=>this.read(key)));
    const refs=results.map(result=>({...result.task,origin:result.origin,accountId:result.accountId}));
    if(Buffer.byteLength(taskContext(refs))>TASK_LIMITS.contextBytes) throw new ProtocolError('limit_exceeded','The referenced tasks are too large for one message. Reference fewer tasks.');
    return {references:refs,assertCurrent:()=>{
      if(results.some(result=>!result.current()||result.accountId!==results[0].accountId||result.origin!==results[0].origin)) throw new ProtocolError('conflict','Your account connection changed. Send the message again.');
    }};
  }
}
