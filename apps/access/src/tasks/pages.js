import { appPage, escapeHTML as e } from '../pages.js';
import { TASK_STATES, TASK_PRIORITIES, LABEL_COLORS } from '../../../../packages/protocol/src/tasks.js';
import { canManage, canManageMember, canWriteTask, canCommentTask } from './permissions.js';

const input = (name, val = '', type = 'text', extra = '') => `<input type="${type}" name="${name}" value="${e(val ?? '')}" ${extra}>`;
const hidden = (name, val) => input(name, val, 'hidden');
const csrf = account => hidden('csrf', account.csrf);
const options = (values, current) => values.map(([id, name]) => `<option value="${e(id)}"${String(id) === String(current ?? '') ? ' selected' : ''}>${e(name)}</option>`).join('');
const select = (name, values, current, extra = '') => `<select name="${name}" ${extra}>${options(values, current)}</select>`;
const button = (text, secondary = false, extra = '') => `<button type="submit" class="button${secondary ? ' secondary' : ''}" ${extra}>${e(text)}</button>`;
const note = error => error ? `<p class="notice" role="alert">${e(error)}</p>` : '';
const post = (action, account, body, attributes = '') => `<form method="post" action="${e(action)}" ${attributes}>${csrf(account)}${body}</form>`;
const scopeOptions = teams => [['', 'Personal'], ...teams.map(t => [t.id, t.name])];
export const page = (title, body, kind = '') => appPage(title, body, { kind, active: kind.startsWith('team') ? 'teams' : kind.startsWith('label') ? 'labels' : kind.startsWith('task') ? 'tasks' : '' });
export const labelBadge = label => `<span class="task-label color-${e(label.color)}">${e(label.name)}</span>`;
export const taskErrorPage = (message, status = 400) => page('Unable to continue', `<h1>Unable to continue.</h1>${note(message)}<p><a href="/tasks">Return to tasks</a> · <a href="/teams">Teams</a></p><p class="fine">${status}</p>`);
const taskHint = task => `<p class="task-chat-hint">Reference in chat: <code>@codex #JOLO-${task.id} fix this problem</code><span class="fine">Revision ${task.revision} · Open the correct local project before sending.</span></p>`;

function commentTime(at) {
  const date = new Date(at), iso = date.toISOString();
  return `<time datetime="${iso}" title="${iso}">${e(date.toLocaleString('en-US', { month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:'UTC' }))} UTC</time>`;
}
function commentCard(comment, account, path, editable, draft) {
  const mine = comment.author_id === account.id, editing = draft?.id === comment.id;
  return `<article class="task-comment" id="comment-${comment.id}">
    <span class="comment-avatar" aria-hidden="true">${e([...comment.author_name.trim()][0]?.toUpperCase() || '?')}</span>
    <div class="comment-content"><div class="comment-heading"><strong>${e(comment.author_name)}</strong>${commentTime(comment.created_at)}${comment.revision>1?'<span class="comment-edited">edited</span>':''}</div>
    <p class="comment-body">${e(comment.body)}</p>
    ${mine && editable ? `<div class="comment-actions">
      <details class="comment-edit"${editing?' open':''}><summary>Edit</summary>${post(`${path}/comments/${comment.id}/edit`,account,hidden('revision',comment.revision)+`<label>Edit your comment<textarea name="body" rows="3" maxlength="8192" required>${e(editing?draft.body:comment.body)}</textarea></label>${button('Save comment')}`)}</details>
      <details class="comment-delete"><summary>Delete</summary>${post(`${path}/comments/${comment.id}/delete`,account,hidden('revision',comment.revision)+'<p>Delete this comment?</p>'+button('Delete comment',true))}</details>
    </div>`:''}</div></article>`;
}

export function taskViewPage({ account, task, labels, members = [], team = null, error = null, comments = [], older = null, commentsBefore = null, commentDraft = null }) {
  const writable = canWriteTask(task, account.id), path = `/tasks/JOLO-${task.id}`;
  const commentable = canCommentTask(task, account.id);
  const selected = JSON.parse(task.labels ?? '[]');
  const assignee = task.assignee_id ? (task.assignee_id === account.id ? account.name : members.find(m => m.id === task.assignee_id)?.name ?? 'Previously assigned member') : 'Unassigned';
  const property = (name, value) => `<div><dt>${e(name)}</dt><dd>${e(value)}</dd></div>`;
  const properties = `<dl>${property('State', TASK_STATES[task.state])}${property('Priority', task.priority)}${property('Project label', task.project || 'None')}${property('Assignee', assignee)}<div><dt>Labels</dt><dd>${labels.filter(l => selected.includes(l.id)).map(labelBadge).join(' ') || 'None'}</dd></div></dl>${taskHint(task)}`;
  const draft = commentDraft?.id ? null : commentDraft;
  return page(`JOLO-${task.id}`, `<div class="task-heading"><div><p class="eyebrow">${e(team?.name ?? 'PERSONAL')}</p><h1>JOLO-${task.id}</h1></div><div class="task-heading-actions"><a href="/tasks${team ? '?team=' + e(team.id) : ''}">Back to tasks</a>${writable && !task.archived_at ? `<a class="button" href="${path}/edit">Edit task</a>` : ''}</div></div>${note(error)}
    ${task.archived_at ? '<p class="notice">This task is archived.</p>' : ''}
    <details class="task-mobile-details"><summary>Details <span>${e(TASK_STATES[task.state])} · ${e(task.priority)}</span></summary><div class="task-scroll">${properties}</div></details>
    <div class="task-view-layout">
      <section class="task-discussion" aria-label="Task discussion">
        <div class="task-conversation task-scroll" tabindex="0" aria-label="Task description and comments">
          <article class="task-view-body" aria-labelledby="task-title"><h2 id="task-title">${e(task.title)}</h2>${task.description ? `<pre class="task-description">${e(task.description)}</pre>` : '<p class="fine">No description provided.</p>'}</article>
          <section class="task-comments" id="comments" aria-labelledby="comments-title"><div class="comments-heading"><h3 id="comments-title">Comments</h3>${commentsBefore?`<a href="${path}#comments">Latest comments</a>`:''}</div>
            ${older?`<a class="older-comments" href="${path}?comments_before=${older}#comments">Load older comments</a>`:''}
            ${comments.length?comments.map(comment=>commentCard(comment,account,path,commentable,commentDraft)).join(''):'<p class="comment-empty">No comments yet.</p>'}
          </section>
        </div>
        ${commentable?post(`${path}/comments`,account,hidden('request_id',draft?.requestID??crypto.randomUUID())+`<label for="comment-body">Leave a comment</label><textarea id="comment-body" name="body" rows="2" maxlength="8192" required placeholder="Share an update or ask a question…">${e(draft?.body??'')}</textarea><div class="comment-compose-actions"><span>${team?`Visible to ${e(team.name)}`:'Only visible to you'}</span>${button('Comment')}</div>`,'id="comment-composer" class="task-comment-compose"'):`<p class="task-comment-readonly">${task.archived_at?'Restore this task to add comments.':'Your role allows you to read comments.'}</p>`}
      </section>
      <aside class="task-summary task-scroll" tabindex="0" aria-label="Task details"><h2>Details</h2>${properties}</aside>
    </div>
    ${writable ? `<div class="task-actions">${post(`${path}/${task.archived_at ? 'restore' : 'archive'}`, account, hidden('revision', task.revision) + button(task.archived_at ? 'Restore task' : 'Archive task', true))}</div>` : ''}`, 'task-detail-page task-discussion-page');
}

export function taskListPage({ tasks, teams, labels, filters, next }) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v !== null && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)]));
  if (next) query.set('before', String(next));
  const activeFilters = [filters.state, filters.label, filters.project, filters.archived].filter(Boolean).length;
  return page('Tasks', `<div class="task-heading"><div><p class="eyebrow">YOUR WORK</p><h1>Tasks</h1></div><a class="button compact" href="/tasks/new${filters.team && filters.team !== 'personal' ? '?team=' + encodeURIComponent(filters.team) : ''}">New task</a></div>
    <form class="task-filters task-search" method="get" action="/tasks">
      <label>Search${input('q', filters.q, 'search', 'maxlength="100" placeholder="Title or JOLO-123"')}</label>
      <label>Workspace${select('team', [['', 'All workspaces'], ['personal', 'Personal'], ...teams.map(t => [t.id, t.name])], filters.team)}</label>
      <details class="task-more-filters"><summary>Filters${activeFilters ? ` (${activeFilters})` : ''}</summary><div class="task-filter-options">
        <label>State${select('state', [['', 'All states'], ...Object.entries(TASK_STATES)], filters.state)}</label>
        <label>Label${select('label', [['', 'All labels'], ...labels.map(l => [l.id, l.name])], filters.label)}</label>
        <label>Project${input('project', filters.project, 'text', 'maxlength="100" placeholder="Project label"')}</label>
        <label>Visibility${select('archived', [['', 'Active'], ['1', 'Archived']], filters.archived ? '1' : '')}</label>
        ${button('Apply filters')}
      </div></details>${button('Search', true)}
    </form>
    <div class="task-list task-scroll" tabindex="0" aria-label="Task list">${tasks.length ? tasks.map(task => `<a class="task-row" href="/tasks/${e(task.key)}"><span class="task-key">${e(task.key)}</span><span class="task-row-main"><strong>${e(task.title)}</strong><span class="task-row-meta">${e(task.team?.name ?? 'Personal')}${task.project ? ' · ' + e(task.project) : ''} · ${e(task.priority)}</span><span>${task.labels.map(labelBadge).join(' ')}</span></span><span class="task-state" data-state="${e(task.state)}">${e(TASK_STATES[task.state])}</span></a>`).join('') : '<p class="task-empty">No tasks match this view. Create a task to give it a permanent ID and reference it in chat.</p>'}</div>
    ${next ? `<p class="task-pagination"><a href="/tasks?${e(query)}">Next page →</a></p>` : ''}`, 'task-list-page');
}

export function taskFormPage({ account, task = null, teams, labels, members = [], team = null, error = null, submitted = null }) {
  const writable = !task ? !team || ['owner', 'admin', 'member'].includes(team.role) : canWriteTask(task, account.id);
  const editable = writable && !task?.archived_at;
  if (task && !editable) return taskViewPage({ account, task, labels, members, team, error });
  const values = submitted ?? task ?? { title: '', description: '', project: '', state: 'todo', priority: 'normal', labels: [], assignee_id: null };
  const selected = Array.isArray(values.labels) ? values.labels : JSON.parse(values.labels ?? '[]');
  const canAssign = !team || canManage(team.role);
  const assignees = [['', 'Unassigned'], ...(team ? members : [{ id: account.id, name: account.name }]).filter(m => canAssign || !task && m.id === account.id).map(m => [m.id, m.name])];
  if (task?.assignee_id && !assignees.some(([id]) => id === task.assignee_id)) assignees.push([task.assignee_id, members.find(m => m.id === task.assignee_id)?.name ?? 'Previously assigned member']);
  const title = task ? `Edit JOLO-${task.id}` : 'New task';
  const fields = `${hidden('team', team?.id ?? '')}${hidden('request_id', values.requestID ?? crypto.randomUUID())}${task ? hidden('revision', task.revision) : ''}
    <div class="task-main-fields">
      <label class="task-title-field">Title${input('title', values.title, 'text', 'required maxlength="200" placeholder="Give this task a clear title"')}</label>
      <label class="task-description-field">Description<textarea name="description" rows="6" maxlength="8192" placeholder="Describe the problem, expected behavior, and how to verify the fix.">${e(values.description)}</textarea></label>
    </div>
    <div class="task-properties">
      <h2 class="task-properties-heading">Details</h2><div class="task-fields">
        <label>State${select('state', Object.entries(TASK_STATES), values.state)}</label>
        <label>Priority${select('priority', TASK_PRIORITIES.map(s => [s, s]), values.priority)}</label>
        <label>Project label${input('project', values.project, 'text', 'maxlength="100"')}</label>
        <label>Assignee${!task || canAssign ? select('assignee', assignees, values.assignee_id ?? values.assignee) : `${hidden('assignee', task.assignee_id ?? '')}<span class="readonly-value">${e(assignees.find(([id]) => id === task.assignee_id)?.[1] ?? 'Unassigned')}</span>`}</label>
      </div>
      <fieldset><legend>Labels</legend>${labels.length ? labels.map(l => `<label class="task-checkbox"><input type="checkbox" name="label" value="${e(l.id)}"${selected.includes(l.id) ? ' checked' : ''}>${labelBadge(l)}</label>`).join('') : '<p class="fine">No labels in this workspace.</p>'}<a href="/labels${team ? '?team=' + e(team.id) : ''}">Manage labels</a></fieldset>
    </div>`;
  return page(title, `<div class="task-heading"><div><p class="eyebrow">${e(team?.name ?? 'PERSONAL')}</p><h1>${e(title)}</h1></div><a href="${task ? `/tasks/JOLO-${task.id}` : '/tasks' + (team ? '?team=' + e(team.id) : '')}">${task ? 'Back to task' : 'Back to tasks'}</a></div>${note(error)}
    ${!task ? `<form class="task-filters workspace-picker" method="get" action="/tasks/new"><label>Workspace${select('team', scopeOptions(teams), team?.id)}</label>${button('Choose workspace', true)}</form>` : taskHint(task)}
    ${editable ? post(task ? `/tasks/JOLO-${task.id}` : '/tasks', account, `<div class="task-editor">${fields}</div>`, 'id="task-edit" class="task-form"') : `<div class="task-read-view"><h2>${e(values.title)}</h2><p>${e(TASK_STATES[values.state])} · ${e(values.priority)}</p><pre class="task-description task-scroll" tabindex="0">${e(values.description)}</pre><p>${labels.filter(l => selected.includes(l.id)).map(labelBadge).join(' ')}</p><p class="fine">${task?.archived_at ? 'This task is archived.' : 'Your role allows viewing this task.'}</p></div>`}
    <div class="task-actions">${editable ? button(task ? 'Save task' : 'Create task', false, 'form="task-edit"') : ''}<a class="button secondary" href="${task ? `/tasks/JOLO-${task.id}` : '/tasks' + (team ? '?team=' + e(team.id) : '')}">Cancel</a></div>`, 'task-detail-page task-compose-page');
}

export function teamsPage(account, teams, invitations, error = null) {
  return page('Teams', `<div class="task-heading"><div><h1>Teams</h1><p class="fine">Team access starts with an invitation and the recipient’s acceptance.</p></div></div>${note(error)}
    <div class="teams-layout">
      <section class="task-panel"><h2>Your teams</h2><div class="task-scroll" tabindex="0" aria-label="Your teams">${teams.length ? teams.map(t => `<a class="task-row" href="/teams/${e(t.id)}"><strong>${e(t.name)}</strong><span>${e(t.role)}</span></a>`).join('') : '<p class="fine">No teams yet. Your personal tasks remain private.</p>'}</div></section>
      <section class="task-panel"><h2>Invitations</h2><div class="task-scroll" tabindex="0" aria-label="Team invitations">${invitations.length ? invitations.map(i => `<article class="task-editor"><h3>${e(i.team_name)}</h3><p>Role: ${e(i.role)} · for ${e(i.email)}</p>${post(`/invitations/${e(i.id)}/accept`, account, button('Accept invitation'))}</article>`).join('') : '<p class="fine">No pending invitations for your verified email.</p>'}</div></section>
      <section class="task-editor team-create"><h2>Create a team</h2>${post('/teams', account, `<label>Name${input('name', '', 'text', 'required maxlength="100"')}</label>${button('Create team')}<p class="fine">You will be its owner. Nobody else receives access automatically.</p>`)}</section>
    </div>`, 'teams-page');
}

export function teamPage({ account, team, members, invitations, audit, error = null, mailEnabled = false }) {
  const manage = canManage(team.role);
  const memberRows = members.map(m => `<article class="team-member"><div><strong>${e(m.name)}</strong><span class="task-row-meta">${manage || m.id === account.id ? e(m.email) + ' · ' : ''}${e(m.role)}</span></div>${m.role !== 'owner' && m.id !== account.id && canManageMember(team.role, m.role) ? post(`/teams/${team.id}/members/${e(m.id)}/role`, account, hidden('revision', m.revision) + select('role', (team.role === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer']).map(r => [r, r]), m.role, 'aria-label="Member role"') + button('Set role', true)) : ''}${m.role !== 'owner' && (m.id === account.id || canManageMember(team.role, m.role)) ? post(`/teams/${team.id}/members/${e(m.id)}/remove`, account, hidden('revision', m.revision) + button(m.id === account.id ? 'Leave team' : 'Remove', true)) : ''}</article>`).join('');
  return page(team.name, `<div class="task-heading"><div><p class="eyebrow">TEAM · ${e(team.role)}</p><h1>${e(team.name)}</h1></div><p class="team-links"><a href="/tasks?team=${e(team.id)}">Team tasks</a><a href="/labels?team=${e(team.id)}">Team labels</a></p></div>${note(error)}
    <div class="team-management${manage ? '' : ' members-only'}">
      <section class="task-panel"><h2>Members</h2>${team.role === 'owner' ? post(`/teams/${team.id}/rename`, account, `<div class="task-filters"><label>Team name${input('name', team.name, 'text', 'required maxlength="100"')}</label>${hidden('revision', team.revision)}${button('Rename', true)}</div>`) : ''}<div class="task-list task-scroll" tabindex="0" aria-label="Team members">${memberRows}</div></section>
      ${manage ? `<section class="task-panel team-invites"><h2>Invite a member</h2>${post(`/teams/${team.id}/invite`, account, `<div class="invite-fields"><label>Verified email${input('email', '', 'email', 'required maxlength="254"')}</label><label>Role${select('role', (team.role === 'owner' ? ['viewer', 'member', 'admin'] : ['viewer', 'member']).map(r => [r, r]), 'viewer')}</label></div>${button(mailEnabled ? 'Send invitation' : 'Create invitation')}<p class="fine">${mailEnabled ? 'An email will invite the recipient to sign in with this verified address and open Teams.' : 'The recipient signs in with this verified email and opens Teams. Email delivery is not configured.'} Expires in seven days.</p>`)}<h2>Pending invitations</h2><div class="task-scroll" tabindex="0" aria-label="Pending invitations">${invitations.map(i => `<article class="team-member"><div>${e(i.email)}<span class="task-row-meta">${e(i.role)}${i.mail_state ? " · " + ({sent:"Email sent",pending:"Email queued",sending:"Sending email",failed:"Email delivery failed",cancelled:"Email cancelled"}[i.mail_state] ?? "Email pending") : ""}</span></div>${canManageMember(team.role, i.role) ? post(`/teams/${team.id}/invitations/${e(i.id)}/revoke`, account, button('Revoke', true)) : ''}</article>`).join('') || '<p class="fine">None.</p>'}</div></section>
      <section class="task-panel"><h2>Recent audit activity</h2><ul class="task-audit task-scroll" tabindex="0" aria-label="Audit activity">${audit.map(a => `<li><time>${e(new Date(a.at).toISOString())}</time><span>${e(a.action)}</span><span>${e(members.find(m => m.id === a.actor_id)?.name ?? a.actor_id)} · ${e(a.subject)}</span></li>`).join('') || '<li>No activity yet.</li>'}</ul></section>` : ''}
    </div>`, 'team-detail-page');
}

export function labelsPage({ account, teams, team, labels, error = null }) {
  const writable = !team || canManage(team.role);
  return page('Labels', `<div class="task-heading"><div><h1>Labels</h1><p class="fine">Labels belong to ${e(team?.name ?? 'your personal workspace')}.</p></div></div>${note(error)}
    <form class="task-filters workspace-picker" method="get" action="/labels"><label>Workspace${select('team', scopeOptions(teams), team?.id)}</label>${button('Choose workspace', true)}</form>
    <div class="labels-layout${writable ? '' : ' labels-readonly'}">
      ${writable ? `<section class="task-editor label-create"><h2>New label</h2>${post('/labels', account, hidden('team', team?.id ?? '') + `<label>Name${input('name', '', 'text', 'required maxlength="40"')}</label><label>Color${select('color', LABEL_COLORS.map(c => [c, c]), 'gray')}</label>${button('Create label')}`)}</section>` : ''}
      <div class="label-grid task-scroll" tabindex="0" aria-label="Workspace labels">${labels.map(l => `<article class="task-editor">${writable ? post(`/labels/${e(l.id)}`, account, hidden('team', team?.id ?? '') + hidden('revision', l.revision) + `<label>Name${input('name', l.name, 'text', 'required maxlength="40"')}</label><label>Color${select('color', LABEL_COLORS.map(c => [c, c]), l.color)}</label>${button('Save label', true)}`) : labelBadge(l)}</article>`).join('') || '<p class="fine">No labels in this workspace yet.</p>'}</div>
    </div>`, 'labels-page');
}
