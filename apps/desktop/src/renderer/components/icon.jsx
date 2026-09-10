// Small, static icon set. No icon runtime or font is loaded by the renderer.
const paths = {
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  sidebar: 'M3 4h18v16H3ZM9 4v16',
  splitRight: 'M3 4h18v16H3ZM12 4v16', splitBelow: 'M3 4h18v16H3ZM3 12h18',
  maximize: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5', restore: 'M8 3v5H3M16 3v5h5M21 16h-5v5M3 16h5v5',
  more: 'M5 11.5h.01v.01H5ZM12 11.5h.01v.01H12ZM19 11.5h.01v.01H19Z',
  plus: 'M12 5v14M5 12h14', arrow: 'm7 10 5-5 5 5M12 5v14', right: 'M5 12h14m-6-6 6 6-6 6',
  chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L19 6',
  circleCheck: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3', terminal: 'm4 5 6 6-6 6m9 1h7',
  command: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm0 5 4 4-4 4m6 0h4',
  think: 'M19.1 4.9c2.3 2.3 1 7.3-2.9 11.3S7.2 21.4 4.9 19.1s-1-7.3 2.9-11.3 9-5.2 11.3-2.9Zm0 14.2c-2.3 2.3-7.3 1-11.3-2.9S2.6 7.2 4.9 4.9s7.3-1 11.3 2.9 5.2 9 2.9 11.3Z',
  spinner: 'M12 3a9 9 0 1 1-9 9',
  tools: 'M14.7 6.3a5 5 0 0 0-6.4 6.4l-5 5a2.1 2.1 0 0 0 3 3l5-5a5 5 0 0 0 6.4-6.4l-3 3-3-3 3-3Z',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.6-1.9L21 21',
  edit: 'm16 3 5 5M4 15 16 3a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L9 20l-6 1 1-6Z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-2 14 5-5 4 4 3-3 6 6M8 7h.01',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5',
  changes: 'M7 20V5m0 0-3 3m3-3 3 3M17 4v15m0 0 3-3m-3 3-3-3',
  browser: 'M3 5h18v14H3ZM3 10h18', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6', refresh: 'M20 7V3m0 4h-4M20 7a9 9 0 1 0 1 9',
  back: 'm14 6-6 6 6 6', forward: 'm10 6 6 6-6 6', stop: 'M6 6h12v12H6Z',
  board: 'M5 5h5v14H5ZM14 5h5v14h-5Z', plan: 'm4 8 2 2 3-3M4 17l2 2 3-3M13 9h7M13 18h7', agents: 'M4 8h16v10H4ZM9 5v3M15 5v3M9 13h.01M15 13h.01', branch: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9', alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 7v5l3 2',
};
export function Icon({ name, size = 16, className = '' }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.file} /></svg>;
}
