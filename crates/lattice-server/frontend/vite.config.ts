import { fileURLToPath } from 'node:url';

import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.LATTICE_API_TARGET || 'http://127.0.0.1:8080';
  const devPort = Number(env.LATTICE_DEV_PORT || 5173);
  const previewPort = Number(env.LATTICE_PREVIEW_PORT || 4173);

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/three/examples/')) {
              return 'three-examples';
            }
            if (id.includes('/node_modules/three/src/renderers/')) {
              return 'three-renderers';
            }
            if (
              id.includes('/node_modules/three/src/core/') ||
              id.includes('/node_modules/three/src/math/') ||
              id.includes('/node_modules/three/src/scenes/') ||
              id.includes('/node_modules/three/src/cameras/') ||
              id.includes('/node_modules/three/src/constants.js') ||
              id.includes('/node_modules/three/src/utils.js')
            ) {
              return 'three-foundation';
            }
            if (
              id.includes('/node_modules/three/src/geometries/') ||
              id.includes('/node_modules/three/src/objects/') ||
              id.includes('/node_modules/three/src/lights/') ||
              id.includes('/node_modules/three/src/materials/')
            ) {
              return 'three-primitives';
            }
            if (id.includes('/node_modules/three/src/')) {
              return 'three-support';
            }
            if (id.includes('/node_modules/lit/')) {
              return 'lit';
            }
            return undefined;
          },
        },
      },
      sourcemap: true,
    },
    preview: {
      host: '127.0.0.1',
      port: previewPort,
      strictPort: true,
    },
    resolve: {
      alias: [
        {
          find: /^three$/,
          replacement: fileURLToPath(
            new URL('./node_modules/three/src/Three.js', import.meta.url)
          ),
        },
      ],
    },
    server: {
      host: '127.0.0.1',
      port: devPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    test: {
      environment: 'node',
      include: ['tests/unit/**/*.spec.ts'],
    },
  };
});
