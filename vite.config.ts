import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    exclude: ['@imagemagick/magick-wasm'],
  },
  assetsInclude: ['**/*.wasm'],
})
