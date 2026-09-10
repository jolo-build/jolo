import { createRoot } from "react-dom/client";
import { applyFonts } from "./fonts.js";
import { failStartup, showStartup } from "./startup.js";

window.addEventListener('beforeunload', showStartup);

async function start() {
  applyFonts(); // per-viewer overrides first, so the bundled defaults never flash
  const { App } = await import('./app.jsx');
  createRoot(document.getElementById('root')).render(<App />);
}
void start().catch(failStartup);
