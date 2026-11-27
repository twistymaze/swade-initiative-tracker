import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    cors: true
  },
  build: {
    // No source maps in dist: everything in dist is served, and no error tracker uses them.
    sourcemap: false,
    rolldownOptions: {
      // Two pages (paths relative to the project root): the action popover / modals and the
      // background page (manifest `background_url`), which registers the context menus.
      input: {
        main: 'index.html',
        background: 'background.html'
      },
      output: {
        // Vendor code in its own chunks: each stays below the 500 kB warning, and an app-only
        // change keeps the vendor files (and their browser cache) unchanged. The background page
        // loads only `vendor` (state, SDK, the small react package), not react-dom or MUI.
        // Priorities: a group also captures the dependencies of its modules, so `vendor` claims
        // react, redux and the SDK first.
        codeSplitting: {
          groups: [
            {
              name: 'vendor',
              priority: 3,
              test: /node_modules[\\/](react|react-redux|use-sync-external-store|@reduxjs|redux|immer|reselect|@owlbear-rodeo)[\\/]/
            },
            { name: 'react-dom', priority: 2, test: /node_modules[\\/](react-dom|scheduler)[\\/]/ },
            // MUI, Emotion and the rest of node_modules.
            { name: 'mui', priority: 1, test: /node_modules[\\/]/ }
          ]
        }
      }
    }
  }
})
