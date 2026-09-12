// Shared primitives available to HTML fragments inside the isolated preview document.
// Keep these defaults before author styles so a self-contained page can override them.
export const VISUALIZATION_STYLES = `
:root {
  color-scheme: light dark;
  font-size: 14px;
  --font-size-base: 14px;
  --background: light-dark(#fcfcfb, #191a1c);
  --foreground: light-dark(#242629, #ededee);
  --muted: light-dark(#f0f1ef, #292b2f);
  --muted-foreground: light-dark(#73767d, #9ea0a8);
  --border: light-dark(#e9e9e7, #303236);
  --card: light-dark(#fff, #202124);
  --card-foreground: var(--foreground);
  --primary: light-dark(#4264d6, #9caeff);
  --primary-foreground: light-dark(#fff, #191a1c);
  --red: light-dark(#ba4052, #ef8894);
  --green: light-dark(#287e61, #6fc6a2);
  --orange: light-dark(#a66a20, #e2b16d);
  --viz-series-1: light-dark(#4264d6, #9caeff);
  --viz-series-2: var(--green);
  --viz-series-3: var(--orange);
  --viz-series-4: light-dark(#a666c4, #cba0e2);
  --viz-series-5: var(--red);
  --viz-series-6: light-dark(#448fa8, #80bfd3);
}
* { box-sizing: border-box; }
body { display: flow-root; margin: 0; padding: 20px; color: var(--foreground); background: transparent; font: 14px/1.5 system-ui, sans-serif; overflow-wrap: break-word; }
h1,h2,h3,h4 { line-height: 1.25; font-weight: 600; }
h1 { font-size: 24px; } h2 { font-size: 20px; } h3 { font-size: 16px; }
body > :first-child, body > div > :first-child { margin-top: 0; }
button,input,select,textarea { font: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }
img,svg,canvas { max-width: 100%; }
.text-muted,.text-small { color: var(--muted-foreground); }
.text-small { font-size: 12px; }
.text-end { text-align: end; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,180px),1fr)); gap: 12px; }
.card { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--card-foreground); min-width: 0; }
.viz-stat { display: flex; flex-direction: column; gap: 6px; }
.viz-stat-value { font-size: 28px; line-height: 1.2; font-weight: 600; letter-spacing: -0.025em; }
.table-responsive { overflow: auto; }
.table { width: 100%; border-collapse: collapse; }
.table th,.table td { padding: 8px; text-align: left; border-bottom: 1px solid var(--border); }
.btn { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--foreground); }
.btn-primary { background: var(--primary); color: var(--primary-foreground); }
@media (max-width: 420px) { body { padding: 14px; } }
`;
