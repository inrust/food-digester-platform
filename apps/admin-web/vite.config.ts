import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  preview: {
    host: '127.0.0.1',
  },
});
