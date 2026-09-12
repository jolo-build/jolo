import { appPage, escapeHTML as e } from './pages.js';

const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H4l1.5-4A8 8 0 1 1 20 11.5Z"/><path d="M8 9h8M8 13h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  sync: '<path d="M20 7h-5l2-3M4 17h5l-2 3M4.5 9a8 8 0 0 1 13-4L20 7M4 17l2.5 2a8 8 0 0 0 13-4"/>',
}[name]}</svg>`;

const dateLabel = timestamp => new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function chatsPage({ chats, total, query = '', next = null, before = '', now = Date.now() }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  const groups = new Map();
  for (const chat of chats) {
    const day = new Date(chat.updated_at).toISOString().slice(0, 10);
    const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : dateLabel(chat.updated_at);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(chat);
  }
  const href = cursor => `/chats?${e(new URLSearchParams({ ...(query ? { q: query } : {}), ...(cursor ? { before: cursor } : {}) }).toString())}`;
  const collection = [...groups].map(([label, items]) => `<section class="chat-date-group" aria-label="${e(label)}"><h2>${e(label)}</h2><ul class="chat-rows">${items.map(chat => {
    const title = chat.title || 'Untitled chat';
    return `<li><a class="chat-row" href="/chats/${e(chat.id)}"><span class="chat-row-icon">${icon('chat')}</span><span class="chat-row-main"><span class="chat-row-title">${e(title)}</span><span class="chat-row-meta">${chat.message_count} ${chat.message_count === 1 ? 'message' : 'messages'}<span aria-hidden="true">·</span>Synced conversation</span></span><time datetime="${e(new Date(chat.updated_at).toISOString())}" title="Last synced ${e(new Date(chat.updated_at).toUTCString())}">${e(new Date(chat.updated_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }))}</time><span class="chat-row-arrow">${icon('arrow')}</span></a></li>`;
  }).join('')}</ul></section>`).join('');
  const empty = `<div class="chats-empty"><span class="chats-empty-icon">${icon(query ? 'search' : 'chat')}</span><h2>${query ? 'No matching chats' : before ? 'You’re all caught up' : 'Your conversations, in one place'}</h2><p>${query ? `No chat titles match “${e(query)}”. Try a different search.` : before ? 'There are no more conversations to show.' : 'Enable chat sync in Jolo to find your conversations here, across your devices.'}</p>${query || before ? `<a class="button secondary" href="/chats">View all chats</a>` : '<p class="chats-setup-path">Jolo Settings <span aria-hidden="true">→</span> Account <span aria-hidden="true">→</span> Enable chat sync</p>'}</div>`;
  return appPage('Chats', `<div class="chats-heading"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>Chats <span class="chats-count" aria-label="${total} ${query ? 'matching' : 'synced'} chats">${total}</span></h1><p>Revisit your conversations. Pick up the context.</p></div><a class="chats-devices" href="/devices">Manage devices ${icon('arrow')}</a></div>
    <form class="chats-search" role="search" action="/chats" method="get"><label for="chat-search" class="chats-search-label">Search chat titles</label><div class="chats-search-field">${icon('search')}<input id="chat-search" type="search" name="q" value="${e(query)}" placeholder="Search your chats…" maxlength="200" autocomplete="off"></div><button class="button secondary" type="submit">Search</button>${query ? '<a class="chats-clear" href="/chats">Clear</a>' : ''}</form>
    <div class="chats-list-heading"><span>${query ? 'Search results' : 'All conversations'}</span><span>Last synced · UTC</span></div>
    <div class="chats-collection task-scroll" tabindex="0" aria-label="${query ? 'Matching chats' : 'Synced chats'}">${collection || empty}${next || before ? `<nav class="chats-pagination" aria-label="Chat pages">${before ? `<a href="${href('')}">Back to latest</a>` : '<span></span>'}${next ? `<a class="button secondary" href="${href(next)}">Older chats ${icon('arrow')}</a>` : ''}</nav>` : ''}</div>
    <details class="chats-sync-help"><summary>${icon('sync')}<span>Keep your conversations connected</span><span class="chats-help-label">Sync setup</span></summary><p>In Jolo, open <strong>Settings → Account</strong> and enable chat sync on each device. Conversation text syncs to your account; files and running agents stay on the original device.</p></details>`, { active: 'chats', kind: 'chats-list-page' });
}
