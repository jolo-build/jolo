import { taskRepository } from './repository.js';
import { commentRepository } from './comments.js';
import { taskListPage, taskViewPage, taskFormPage, teamsPage, teamPage, labelsPage, taskErrorPage } from './pages.js';
import { canManage, canWriteTask, canCommentTask } from './permissions.js';
import { TaskError, value, optional, choice, revision, taskFields, commentBody, labelFields, inviteFields, uuid } from './validation.js';
import { formValue, readForm, hashToken } from '../security.js';
import { taskKey, TASK_STATES } from '../../../../packages/protocol/src/tasks.js';
import { deliverMail, invitationEmail, mailConfigured } from '../mail.js';

const html = (body,status=200) => new Response(body,{status,headers:{'Content-Type':'text/html; charset=utf-8'}});
const redirect = location => new Response(null,{status:303,headers:{Location:location}});
const fail = (status,message) => { throw new TaskError(status,message); };
const changed = result => result ?? fail(409,'This record changed or your permission was removed. Refresh the page and review before saving again.');

export function taskRoutes({env,config,repository:auth,session,now,mailFetch}) {
  const repo=env.ACCESS_DB?taskRepository(env.ACCESS_DB,now):null;
  const comments=env.ACCESS_DB?commentRepository(env.ACCESS_DB,now):null;
  async function selectedTeam(actor,id) { if (!id) return null; if(!uuid(id)) fail(404,'Workspace not found.'); return await repo.team(actor,id)??fail(404,'Workspace not found.'); }
  async function serialize(actor,row,description=true) {
    const labels=await repo.labels(actor,row.team_id), selected=JSON.parse(row.labels);
    return {key:`JOLO-${row.id}`,title:row.title,...(description?{description:row.description}:{}),project:row.project,state:row.state,priority:row.priority,revision:row.revision,labels:labels.filter(l=>selected.includes(l.id)).map(({id,name,color})=>({id,name,color})),team:row.team_id?{id:row.team_id,name:row.team_name}:null,assigneeId:row.assignee_id,archivedAt:row.archived_at?new Date(row.archived_at).toISOString():null,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
  }
  function filters(url) {
    const p=url.searchParams, result={q:p.get('q')??'',state:p.get('state')??'',team:p.get('team')??'',label:p.get('label')??'',project:p.get('project')??'',archived:p.get('archived')==='1',before:p.has('before')?Number(p.get('before')):null};
    if(result.project.length>100||result.q.length>100||result.team.length>100||result.label.length>100||(result.state&&!Object.hasOwn(TASK_STATES,result.state))||(result.before!==null&&(!Number.isSafeInteger(result.before)||result.before<1))) fail(400,'Invalid task filter.');
    return result;
  }
  async function taskForm(account,task,team,error=null,submitted=null) {
    return taskFormPage({account,task,teams:await repo.teams(account.id),team,labels:await repo.labels(account.id,team?.id),members:team?await repo.members(account.id,team.id):[],error,submitted});
  }
  async function taskView(account,task,team,error=null,{before=null,draft=null}={}) {
    const history=await comments.list(account.id,task.id,before);
    return taskViewPage({account,task,team,labels:await repo.labels(account.id,team?.id),members:team?await repo.members(account.id,team.id):[],...history,commentsBefore:before,commentDraft:draft,error});
  }
  return async (request,context) => {
    const url=new URL(request.url),path=url.pathname,api=path==='/api/tasks'||path.startsWith('/api/tasks/');
    if(!api&&!/^\/(tasks|teams|labels|invitations)(?:\/|$)/.test(path)) return null;
    try {
      let account;
      if(api) {
        if(request.method!=='GET') fail(405,'Task credentials allow reading only.');
        const token=/^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization')??'');
        account=token?await auth.getDevice(await hashToken(token[1])):null;
        if(!account) fail(401,'Sign in to Jolo to read tasks.');
        if(!account.scope?.split(' ').includes('tasks:read')) return Response.json({error:'insufficient_scope',message:'Approve task access in your Jolo account settings.'},{status:403});
      } else {
        account=await session(request);
        if(!account) return request.method==='GET'?redirect('/'):html(taskErrorPage('Sign in before changing tasks or teams.',401),401);
      }
      let form;
      if(request.method==='POST') {
        if(request.headers.get('origin')!==config.origin) fail(403,'The request origin could not be verified. Reopen this page from Jolo.');
        form=await readForm(request,40*1024);
        if(!form||formValue(form,'csrf')!==account.csrf) fail(403,'Your form session changed. Reload the page before saving.');
        if(env.ACCESS_RATE_LIMIT && !(await env.ACCESS_RATE_LIMIT.limit({key:`tasks:write:${account.id}`})).success) fail(429,'Too many changes. Wait a minute and try again.');
      }
      const actor=account.id;
      if((path==='/tasks'||path==='/api/tasks')&&request.method==='GET') {
        const query=filters(url);
        if(query.team&&query.team!=='personal') await selectedTeam(actor,query.team);
        const rows=await repo.list(actor,query),next=rows.length>20?rows[19].id:null,tasks=await Promise.all(rows.slice(0,20).map(r=>serialize(actor,r,false)));
        if(api) return Response.json({tasks,next});
        const teams=await repo.teams(actor);
        const scopes=query.team?[query.team==='personal'?null:query.team]:[null,...teams.map(t=>t.id)];
        const labels=(await Promise.all(scopes.map(scope=>repo.labels(actor,scope)))).flat();
        return html(taskListPage({tasks,teams,labels,filters:query,next}));
      }
      if(path==='/tasks/new'&&request.method==='GET') return html(await taskForm(account,null,await selectedTeam(actor,url.searchParams.get('team'))));
      if(path==='/tasks'&&request.method==='POST') {
        const team=await selectedTeam(actor,optional(form,'team'));
        if(team&&!['owner','admin','member'].includes(team.role)) fail(403,'Your role does not allow creating tasks.');
        let fields;
        try {
          fields=taskFields(form);
          if(!uuid(fields.requestID)) fail(400,'Reopen the new-task form before submitting.');
          const result=await repo.createTask(actor,fields);
          if(!result) fail(403,'The task contains an assignee or label you cannot use, or your permission changed.');
          return redirect(`/tasks/JOLO-${result.id}`);
        } catch(error) {
          if(!(error instanceof TaskError)) throw error;
          return html(await taskForm(account,null,team,error.message,fields??formDraft(form)),error.status);
        }
      }
      const commentMatch=/^\/tasks\/(JOLO-[1-9][0-9]{0,14})\/comments(?:\/([1-9][0-9]{0,14})\/(edit|delete))?$/i.exec(path);
      if(commentMatch&&request.method==='POST') {
        const key=taskKey(commentMatch[1]),id=commentMatch[2]?Number(commentMatch[2]):null,action=commentMatch[3]?.toLowerCase();
        const task=key?await repo.task(actor,Number(key.slice(5))):null;
        if(!task) fail(404,'Task not found.');
        if(!canCommentTask(task,actor)) fail(403,task.archived_at?'Restore this task before commenting.':'Your role allows reading comments only.');
        if(id) {
          const comment=await comments.get(actor,task.id,id);
          if(!comment) fail(404,'Comment not found.');
          if(comment.author_id!==actor) fail(403,'You can only change your own comments.');
        }
        try {
          let result;
          if(action==='delete') result=changed(await comments.remove(actor,task.id,id,revision(form)));
          else if(action==='edit') result=changed(await comments.edit(actor,task.id,id,commentBody(form),revision(form)));
          else {
            const body=commentBody(form),requestID=optional(form,'request_id');
            if(!uuid(requestID)) fail(400,'Reopen the comment form before submitting.');
            result=changed(await comments.create(actor,task.id,body,requestID));
            if(!result.deleted_at&&result.body!==body) fail(409,'This form already posted a different comment. Review the discussion before sending another.');
          }
          const before=action==='edit'?`?comments_before=${id+1}`:'';
          return redirect(`/tasks/${key}${before}#${result.deleted_at?'comments':`comment-${result.id}`}`);
        } catch(error) {
          if(!(error instanceof TaskError)) throw error;
          const latest=await repo.task(actor,task.id);
          if(!latest) fail(404,'Task not found.');
          const requestID=formValue(form,'request_id');
          const draft=action==='delete'?null:{id,body:formValue(form,'body')??'',requestID:error.status!==409&&uuid(requestID)?requestID:crypto.randomUUID()};
          return html(await taskView(account,latest,await selectedTeam(actor,latest.team_id),error.message,{before:id?id+1:null,draft}),error.status);
        }
      }
      const taskMatch=/^\/(?:api\/)?tasks\/(JOLO-[1-9][0-9]{0,14})(?:\/(edit|archive|restore))?$/i.exec(path);
      if(taskMatch) {
        const key=taskKey(taskMatch[1]),action=taskMatch[2]?.toLowerCase();
        if(!key) fail(404,'Task not found.');
        const task=await repo.task(actor,Number(key.slice(5)));
        if(!task) fail(404,'Task not found.');
        if(api) { if(task.archived_at||action) fail(404,'Task not found.'); return Response.json({task:await serialize(actor,task)}); }
        const team=await selectedTeam(actor,task.team_id);
        if(request.method==='GET') {
          if(!action) {
            const before=url.searchParams.has('comments_before')?Number(url.searchParams.get('comments_before')):null;
            if(before!==null&&(!Number.isSafeInteger(before)||before<1)) fail(400,'Invalid comment page.');
            return html(await taskView(account,task,team,null,{before}));
          }
          if(action==='edit') {
            if(!canWriteTask(task,actor)) fail(403,'Your role does not allow editing this task.');
            if(task.archived_at) return redirect(`/tasks/${key}`);
            return html(await taskForm(account,task,team));
          }
        }
        if(request.method==='POST') {
          if(action==='edit') fail(404,'Page not found.');
          if(!canWriteTask(task,actor)) fail(403,'Your role does not allow editing this task.');
          let fields;
          try {
            if(action) changed(await repo.archiveTask(actor,task.id,revision(form),action==='archive',task.team_id));
            else {
              fields=taskFields(form);
              if(fields.team!==task.team_id) fail(403,'A task cannot be moved between workspaces.');
              changed(await repo.updateTask(actor,task.id,fields,revision(form)));
            }
            return redirect(`/tasks/${key}`);
          } catch(error) {
            if(!(error instanceof TaskError)) throw error;
            const latest=await repo.task(actor,task.id);
            if(!latest) fail(404,'Task not found.');
            const latestTeam=await selectedTeam(actor,latest.team_id);
            return html(action ? await taskView(account,latest,latestTeam,error.message) : await taskForm(account,latest,latestTeam,error.message,fields??formDraft(form)),error.status);
          }
        }
      }
      if(path==='/teams'&&request.method==='GET') return html(teamsPage(account,await repo.teams(actor),await repo.invitations(actor,account.email.toLowerCase())));
      if(path==='/teams'&&request.method==='POST') { const team=changed(await repo.createTeam(actor,value(form,'name',100,true))); return redirect(`/teams/${team.id}`); }
      const accept=/^\/invitations\/([a-f0-9-]{36})\/accept$/.exec(path);
      if(accept&&request.method==='POST') {
        const member=await repo.accept(actor,accept[1],account.email.toLowerCase());
        if(!member) fail(403,'This invitation is unavailable for your verified account, expired, or no longer authorized.');
        return redirect(`/teams/${member.team_id}`);
      }
      const teamMatch=/^\/teams\/([a-f0-9-]{36})(?:\/(rename|invite|members\/([a-f0-9-]{36})\/(role|remove)|invitations\/([a-f0-9-]{36})\/revoke))?$/.exec(path);
      if(teamMatch) {
        const team=await selectedTeam(actor,teamMatch[1]);
        if(request.method==='GET'&&!teamMatch[2]) return html(teamPage({account,team,members:await repo.members(actor,team.id),invitations:await repo.teamInvitations(actor,team.id),audit:await repo.audit(actor,team.id),mailEnabled:mailConfigured(env)}));
        if(request.method==='POST') {
          if(teamMatch[2]==='rename') changed(await repo.renameTeam(actor,team.id,value(form,'name',100,true),revision(form)));
          else if(teamMatch[2]==='invite') {
            const i=inviteFields(form);
            const mail=invitationEmail(env,{team,inviter:account,recipient:i.email,role:i.role});
            const invitation=changed(await repo.invite(actor,team.id,i.email,i.role,mail));
            if(mail) {
              const delivery=deliverMail(env,{id:invitation.id,now,fetchImpl:mailFetch}).catch(() => {});
              if(context?.waitUntil) context.waitUntil(delivery); else await delivery;
            }
          }
          else if(teamMatch[3]) {
            if(teamMatch[4]==='role') changed(await repo.setMember(actor,team.id,teamMatch[3],choice(form,'role',['admin','member','viewer']),revision(form)));
            else changed(await repo.removeMember(actor,team.id,teamMatch[3],revision(form)));
          } else if(teamMatch[5]) changed(await repo.revokeInvitation(actor,team.id,teamMatch[5]));
          else fail(404,'Page not found.');
          return redirect(teamMatch[3]===actor&&teamMatch[4]==='remove'?'/teams':`/teams/${team.id}`);
        }
      }
      if(path==='/labels'&&request.method==='GET') {
        const team=await selectedTeam(actor,url.searchParams.get('team'));
        return html(labelsPage({account,team,teams:await repo.teams(actor),labels:await repo.labels(actor,team?.id)}));
      }
      const labelMatch=/^\/labels(?:\/([a-f0-9-]{36}))?$/.exec(path);
      if(labelMatch&&request.method==='POST') {
        const team=await selectedTeam(actor,optional(form,'team')), fields=labelFields(form);
        if(team&&!canManage(team.role)) fail(403,'Only a team owner or admin can manage labels.');
        if(labelMatch[1]) {
          if(!(await repo.labels(actor,team?.id)).some(l=>l.id===labelMatch[1])) fail(404,'Label not found.');
          changed(await repo.editLabel(actor,labelMatch[1],fields.name,fields.color,revision(form),team?.id??null));
        } else changed(await repo.createLabel(actor,team?.id??null,fields.name,fields.color));
        return redirect('/labels'+(team?'?team='+team.id:''));
      }
      fail(404,'Page not found.');
    } catch(error) {
      const status=error instanceof TaskError?error.status:503,message=error instanceof TaskError?error.message:'The task service could not complete this request. Please try again.';
      return api?Response.json({error:status===404?'not_found':status===401?'unauthorized':'request_failed',message},{status}):html(taskErrorPage(message,status),status);
    }
  };
}
function formDraft(form) {
  const get=k=>formValue(form,k)??'';
  return {title:get('title'),description:get('description'),project:get('project'),state:get('state'),priority:get('priority'),labels:form.getAll('label'),assignee:get('assignee'),requestID:get('request_id')};
}
