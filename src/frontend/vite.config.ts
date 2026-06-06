import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { icpBindgen } from '@icp-sdk/bindgen/plugins/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    icpBindgen({
      didFile: '../backend/backend.did',
      outDir: './src/bindings',
    }),
    icpBindgen({
      didFile: '../backend/ledger.did',
      outDir: './src/bindings',
    }),
  ],
})
