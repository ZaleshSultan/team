import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const tunnelHost = process.env.DEV_TUNNEL_HOST || env.DEV_TUNNEL_HOST;
  return {
    plugins: [react()],
    envDir: '../..',
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts: tunnelHost ? [tunnelHost] : [],
      proxy: {
        '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
        '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      },
    },
  };
});
