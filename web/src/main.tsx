import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, readTheme } from './theme';

// 首次 React 渲染前恢复偏好，避免先显示默认主题再跳色。
applyTheme(readTheme());

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('缺少 #root 容器');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
