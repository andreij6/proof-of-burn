/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { icpBindgen } from '@icp-sdk/bindgen/plugins/vite'

export default defineConfig({
  plugins: [
    react(),
    icpBindgen({
      didFile: '../backend/backend.did',
      outDir: './src/bindings',
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
