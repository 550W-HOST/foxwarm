import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { bootHtmlPlugin } from './build/bootHtml'

export default defineConfig({
  plugins: [react(), bootHtmlPlugin()],
  base: './', // Use relative paths for assets
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/monaco-editor')) return 'monaco-editor'
        }
      }
    }
  },
  resolve: {
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
