import './components/lattice-app';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('フロントエンドのルート要素 #app が見つかりません。');
}

app.innerHTML = '<lattice-app></lattice-app>';
