import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './interactions.css';
import './auth.css';
import './activity.css';

const root = document.getElementById('root');
root.addEventListener('pointerdown', event => {
  const button = event.target.closest('.button.primary:not(:disabled)');
  if (!button) return;
  const bounds = button.getBoundingClientRect();
  button.style.setProperty('--press-x', `${event.clientX - bounds.left}px`);
  button.style.setProperty('--press-y', `${event.clientY - bounds.top}px`);
});
createRoot(root).render(<App />);
