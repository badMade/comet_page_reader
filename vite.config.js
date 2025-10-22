import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function resolveFromRoot(relativePath) {
  return path.resolve(projectRoot, relativePath);
}

function normaliseRelative(id) {
  if (!id) {
    return '';
  }
  if (id.includes('\0')) {
    return '';
  }
  const relative = path.relative(projectRoot, id).replace(/\\/g, '/');
  if (relative.startsWith('..')) {
    return '';
  }
  if (relative.includes(':')) {
    return '';
  }
  return relative;
}

function sanitizeFileName(name) {
  if (!name) {
    return 'chunk';
  }
  return name.replace(/[^a-zA-Z0-9/_-]/g, '_');
}

export default defineConfig(({ mode, command }) => {
  const isDevCommand = command === 'serve' || mode === 'development';
  const sourcemapEnv = (process.env.BUILD_SOURCEMAP ?? '').toLowerCase();
  const sourcemapRequested = sourcemapEnv === 'true' || sourcemapEnv === '1';
  const sourcemapEnabled = isDevCommand || sourcemapRequested;

  return {
    publicDir: false,
    cssDevSourcemap: sourcemapEnabled,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: sourcemapEnabled,
      target: 'es2022',
      minify: isDevCommand ? false : 'esbuild',
      rollupOptions: {
        external: id => id === 'yaml',
        input: {
          background: resolveFromRoot('background/service_worker.js'),
          content: resolveFromRoot('content/content.js'),
          popup: resolveFromRoot('popup/script.js'),
        },
        preserveEntrySignatures: 'strict',
        output: {
          preserveModules: true,
          preserveModulesRoot: projectRoot,
          entryFileNames: chunk => {
            const relativePath = normaliseRelative(chunk.facadeModuleId);
            if (relativePath === 'background/service_worker.js') {
              return 'background/service_worker.js';
            }
            if (relativePath === 'content/content.js') {
              return 'content/content.js';
            }
            if (relativePath === 'popup/script.js') {
              return 'popup/script.js';
            }
            if (relativePath && !relativePath.startsWith('node_modules/')) {
              return relativePath.endsWith('.js') ? relativePath : `${relativePath}.js`;
            }
            const safeName = sanitizeFileName(chunk.name);
            return `chunks/${safeName}-[hash].js`;
          },
          chunkFileNames: chunk => {
            const relativePath = normaliseRelative(chunk.facadeModuleId);
            if (relativePath && !relativePath.startsWith('node_modules/')) {
              return relativePath.endsWith('.js') ? relativePath : `${relativePath}.js`;
            }
            const safeName = sanitizeFileName(chunk.name);
            return `chunks/${safeName}-[hash].js`;
          },
          assetFileNames: assetInfo => {
            const assetName = (assetInfo.name ?? '').replace(/\\/g, '/');
            if (assetName.endsWith('.css') && assetName.includes('popup')) {
              return 'popup/styles.css';
            }
            return 'assets/[name][extname]';
          },
        },
      },
    },
    define: {
      __BUILD_MODE__: JSON.stringify(mode),
    },
  };
});
