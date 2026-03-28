import './components/lattice-app';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Frontend root #app was not found.');
}

app.innerHTML = '<lattice-app></lattice-app>';
