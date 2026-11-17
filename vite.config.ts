import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the same build works on GitHub Pages (/<repo>/) and locally.
  base: './',
  plugins: [react()],
  server: {
    // Lets the browser reach a local Ollama server without CORS setup: /ollama/api/chat → http://localhost:11434/api/chat
    proxy: {
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ollama/, ''),
      },
    },
  },
});
