import React, { useEffect } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const root = document.getElementById('root');
function Website() {
  useEffect(() => { window.dispatchEvent(new Event('jolo:hydrated')); }, []);
  return <App />;
}
if (root.hasChildNodes()) hydrateRoot(root, <Website />);
else createRoot(root).render(<Website />);
