import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n.js';
import './styles.css';
import { App } from './App.js';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Mini App root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
