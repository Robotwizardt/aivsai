import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端默认端口见 server/src/index.ts（PORT 环境变量，缺省 3000）。
// 这里用环境变量覆盖，便于本地把服务跑在非默认端口上（如 PORT=3111）。
const backendTarget =
  process.env.VITE_BACKEND_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    // 同时监听 127.0.0.1：默认只绑 ::1 时，浏览器访问 127.0.0.1 会连不上。
    host: '127.0.0.1',
    proxy: {
      '/api': backendTarget,
    },
  },
});
