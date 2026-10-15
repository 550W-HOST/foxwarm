import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { bootHtmlPlugin } from './build/bootHtml'

export default defineConfig({
  plugins: [react(), bootHtmlPlugin()],
  base: './', // Use relative paths for assets
  build: {
    // Keep the pre-upgrade syntax target instead of adopting Vite's newer default.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14']
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
