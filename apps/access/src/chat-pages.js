import { appPage, escapeHTML as e } from './pages.js';

const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H4l1.5-4A8 8 0 1 1 20 11.5Z"/><path d="M8 9h8M8 13h5"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  sync: '<path d="M20 7h-5l2-3M4 17h5l-2 3M4.5 9a8 8 0 0 1 13-4L20 7M4 17l2.5 2a8 8 0 0 0 13-4"/>',
}[name]}</svg>`;

const dateLabel = timestamp => new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const timeLabel = timestamp => new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const stamp = (timestamp, label, prefix = 'Last synced') => `<time datetime="${e(new Date(timestamp).toISOString())}" title="${prefix} ${e(new Date(timestamp).toUTCString())}">${e(label)}</time>`;

function chatRow(chat, { now, place = false, dated = false }) {
  const title = chat.title || 'Untitled chat';
  const today = new Date(now).toISOString().slice(0, 10) === new Date(chat.updated_at).toISOString().slice(0, 10);
  const where = place && chat.project_name ? `<span aria-hidden="true">·</span>${e(chat.project_name)}${chat.folder_name && chat.folder_name !== chat.project_name ? ` / ${e(chat.folder_name)}` : ''}` : place ? '<span aria-hidden="true">·</span>Synced conversation' : '';
  return `<li><a class="chat-row" href="/chats/${e(chat.id)}"><span class="chat-row-icon">${icon('chat')}</span><span class="chat-row-main"><span class="chat-row-title">${e(title)}</span><span class="chat-row-meta">${plural(chat.message_count, 'message')}${where}</span></span>${stamp(chat.updated_at, dated && !today ? dateLabel(chat.updated_at) : timeLabel(chat.updated_at))}<span class="chat-row-arrow">${icon('arrow')}</span></a></li>`;
}

function byDay(chats, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  const groups = new Map();
  for (const chat of chats) {
    const day = new Date(chat.updated_at).toISOString().slice(0, 10);
    const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : dateLabel(chat.updated_at);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(chat);
  }
  return [...groups].map(([label, items]) => `<section class="chat-date-group" aria-label="${e(label)}"><h2>${e(label)}</h2><ul class="chat-rows">${items.map(chat => chatRow(chat, { now, place: true })).join('')}</ul></section>`).join('');
}

// Folders keep the order of their most recent chat; a worktree shows the branch it was on.
function byFolder(chats, now) {
  const groups = new Map();
  for (const chat of chats) {
    if (!groups.has(chat.folder_id)) groups.set(chat.folder_id, []);
    groups.get(chat.folder_id).push(chat);
  }
  return [...groups.values()].map(items => {
    const { folder_name: name, folder_branch: branch } = items[0];
    return `<section class="chat-date-group chat-folder-group" aria-label="Folder ${e(name)}"><h2>${icon('folder')}<span>${e(name)}</span>${branch ? `<code class="chat-folder-branch">${e(branch)}</code>` : ''}</h2><ul class="chat-rows">${items.map(chat => chatRow(chat, { now, dated: true })).join('')}</ul></section>`;
  }).join('');
}

function projectRows(projects, unfiled, now) {
  const rows = projects.map(project => {
    const folders = project.folder_names ? project.folder_names.split('\n') : [];
    const shown = folders.slice(0, 3).join(', ') + (folders.length > 3 ? ` +${folders.length - 3}` : '');
    return `<li><a class="chat-row project-row" href="/chats?project=${e(project.id)}"><span class="chat-row-icon">${icon('folder')}</span><span class="chat-row-main"><span class="chat-row-title">${e(project.name)}</span><span class="chat-row-meta">${plural(project.chat_count, 'chat')}<span aria-hidden="true">·</span>${plural(folders.length, 'folder')}${folders.length > 1 || (folders[0] && folders[0] !== project.name) ? `: ${e(shown)}` : ''}</span></span>${stamp(project.updated_at, dateLabel(project.updated_at), 'Last activity')}<span class="chat-row-arrow">${icon('arrow')}</span></a></li>`;
  });
  if (unfiled?.chat_count) rows.push(`<li><a class="chat-row project-row" href="/chats?project=none"><span class="chat-row-icon">${icon('chat')}</span><span class="chat-row-main"><span class="chat-row-title">Chats without a project</span><span class="chat-row-meta">${plural(unfiled.chat_count, 'chat')}<span aria-hidden="true">·</span>Started outside a project folder</span></span>${stamp(unfiled.updated_at, dateLabel(unfiled.updated_at), 'Last activity')}<span class="chat-row-arrow">${icon('arrow')}</span></a></li>`);
  return rows.length ? `<section class="chat-date-group" aria-label="Projects"><ul class="chat-rows">${rows.join('')}</ul></section>` : '';
}

/**
 * Three views share this page. Without a project or query it lists projects. `project` is
 * `{ id, name }` for one project's chats grouped by folder, or `{ id: 'none' }` for chats
 * started outside a project. A query searches chat titles, inside `project` when one is set.
 */
export function chatsPage({ chats = [], total, query = '', next = null, before = '', project = null, projects = null, unfiled = null, start = '', now = Date.now() }) {
  const overview = Boolean(projects);
  const scope = project ? { project: project.id } : {};
  const href = cursor => `/chats?${e(new URLSearchParams({ ...scope, ...(query ? { q: query } : {}), ...(cursor ? { before: cursor } : {}) }).toString())}`;
  const collection = overview ? projectRows(projects, unfiled, now)
    : project && project.id !== 'none' && !query ? byFolder(chats, now)
    : byDay(chats, now);
  const where = project ? (project.id === 'none' ? 'chats without a project' : project.name) : '';
  const empty = `<div class="chats-empty"><span class="chats-empty-icon">${icon(query ? 'search' : 'chat')}</span><h2>${query ? 'No matching chats' : before ? 'You’re all caught up' : project ? 'No chats here' : 'Your conversations, in one place'}</h2><p>${query ? `No chat titles match “${e(query)}”${project ? ` in ${e(where)}` : ''}. Try a different search.` : before ? 'There are no more conversations to show.' : project ? 'This project has no synced chats. They may have been removed on another device.' : 'Turn on Chat sync in Jolo to find your conversations here, grouped by project folder.'}</p>${query || before || project ? `<a class="button secondary" href="/chats">View all projects</a>` : '<p class="chats-setup-path">Jolo Settings <span aria-hidden="true">→</span> Account <span aria-hidden="true">→</span> Chat sync</p>'}</div>`;
  const crumbs = project ? `<nav class="chats-crumbs" aria-label="Breadcrumb"><a href="/chats">Projects</a><span aria-hidden="true">/</span><span aria-current="page">${e(project.id === 'none' ? 'Chats without a project' : project.name)}</span></nav>` : '';
  const listHeading = overview ? ['Projects', 'Last activity · UTC'] : query ? ['Search results', 'Last synced · UTC'] : project && project.id !== 'none' ? ['Folders', 'Last synced · UTC'] : ['All conversations', 'Last synced · UTC'];
  return appPage(project ? (project.id === 'none' ? 'Chats without a project' : project.name) : 'Chats', `<div class="chats-heading"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>Chats <span class="chats-count" aria-label="${total} ${query ? 'matching' : 'synced'} chats">${total}</span></h1><p>Revisit your conversations, grouped by the folders you worked in.</p></div><a class="chats-devices" href="/devices">Manage devices ${icon('arrow')}</a></div>
    ${crumbs}<form class="chats-search" role="search" action="/chats" method="get"><label for="chat-search" class="chats-search-label">Search chat titles</label>${project ? `<input type="hidden" name="project" value="${e(project.id)}">` : ''}<div class="chats-search-field">${icon('search')}<input id="chat-search" type="search" name="q" value="${e(query)}" placeholder="${project ? `Search ${e(where)}…` : 'Search your chats…'}" maxlength="200" autocomplete="off"></div><button class="button secondary" type="submit">Search</button>${query ? `<a class="chats-clear" href="${project ? `/chats?project=${e(project.id)}` : '/chats'}">Clear</a>` : ''}</form>${start}
    <div class="chats-list-heading"><span>${listHeading[0]}</span><span>${listHeading[1]}</span></div>
    <div class="chats-collection task-scroll" tabindex="0" aria-label="${overview ? 'Projects' : query ? 'Matching chats' : 'Synced chats'}">${collection || empty}${next || before ? `<nav class="chats-pagination" aria-label="Chat pages">${before ? `<a href="${href('')}">Back to latest</a>` : '<span></span>'}${next ? `<a class="button secondary" href="${href(next)}">Older chats ${icon('arrow')}</a>` : ''}</nav>` : ''}</div>
    <details class="chats-sync-help"><summary>${icon('sync')}<span>Keep your conversations connected</span><span class="chats-help-label">Sync setup</span></summary><p>In Jolo, open <strong>Settings → Account</strong> and enable chat sync on each device. Conversation text and project folder names sync to your account; files, local paths, and running agents stay on the original device.</p></details>`, { active: 'chats', kind: 'chats-list-page' });
}
