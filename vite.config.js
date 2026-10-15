import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
    // Scratch/automation output is not part of the app, and neither are the
    // editor's atomic-save temp dirs (`.<name>.<pid>.<uuid>.tmpdir/`). Chokidar
    // happily walks both, then dies on the locked temp file (EBUSY) — which
    // takes the whole dev server down, because Vite has no handler for
    // FSWatcher's 'error'. Ignore them and the server survives its own tooling.
    //
    // `intro-video/` is the separate Remotion project: it is its own npm
    // package with its own node_modules, and watching it made the dev server
    // crash on `intro-video/public/intro/*.png` (EBUSY) the moment those stills
    // were written. Nothing under it is imported by this app.
    watch: {
      ignored: [
        '**/tools/**',
        '**/output/**',
        '**/docs/**',
        '**/intro-video/**',
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        '**/*.tmp'
      ]
    }
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000
  },
  // Large binary assets (FBX / HDR) live in /public and are served untouched.
  assetsInclude: ['**/*.fbx', '**/*.hdr']
});
