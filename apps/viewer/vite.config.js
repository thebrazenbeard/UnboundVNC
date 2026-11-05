import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:6081', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:6081', ws: true, changeOrigin: false },
    },
  },
});
