import { createRoot } from 'react-dom/client';
import { applyFonts } from './fonts.js';
import { App } from './app.jsx';

export function render() {
  applyFonts(); // Apply per-viewer overrides before the interface becomes visible.
  createRoot(document.getElementById('root')).render(<App />);
}
