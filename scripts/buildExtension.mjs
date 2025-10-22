import { build, loadConfigFromFile } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {
    mode: 'production',
    sourcemapOverride: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value after --mode flag.');
      }
      options.mode = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === '--sourcemap') {
      options.sourcemapOverride = true;
      continue;
    }
    if (arg === '--no-sourcemap') {
      options.sourcemapOverride = false;
      continue;
    }
    throw new Error(`Unsupported flag: ${arg}`);
  }

  return options;
}

async function copyStaticAssets(outDir) {
  const filesToCopy = [
    ['manifest.json', 'manifest.json'],
    ['logging_config.yaml', 'logging_config.yaml'],
    ['popup/index.html', 'popup/index.html'],
    ['popup/styles.css', 'popup/styles.css'],
  ];

  const copied = [];

  for (const [sourceRelative, destinationRelative] of filesToCopy) {
    const sourcePath = path.resolve(projectRoot, sourceRelative);
    const destinationPath = path.resolve(outDir, destinationRelative);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    const stats = await fs.stat(destinationPath);
    copied.push({
      file: destinationRelative,
      size: stats.size,
    });
  }

  // Copy utility modules that must remain accessible at runtime.
  const utilsSource = path.resolve(projectRoot, 'utils');
  const utilsDestination = path.resolve(outDir, 'utils');
  await fs.rm(utilsDestination, { recursive: true, force: true });
  await fs.cp(utilsSource, utilsDestination, { recursive: true });
  const utilsStats = await enumerateDirectory(utilsDestination);
  copied.push({
    directory: 'utils',
    files: utilsStats.files,
    size: utilsStats.size,
  });

  return copied;
}

async function enumerateDirectory(directory, base = directory) {
  let size = 0;
  const files = [];

  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await enumerateDirectory(entryPath, base);
      size += nested.size;
      files.push(...nested.files);
    } else if (entry.isFile()) {
      const stats = await fs.stat(entryPath);
      size += stats.size;
      files.push(path.relative(base, entryPath).replace(/\\/g, '/'));
    }
  }

  return { size, files };
}

function isSourcemapEnabled(value) {
  if (value === true) {
    return true;
  }
  if (!value || value === false) {
    return false;
  }
  if (typeof value === 'string') {
    return value !== 'false';
  }
  if (typeof value === 'object') {
    return Object.values(value).some(Boolean);
  }
  return Boolean(value);
}

async function ensureNoSourcemapReferences(outDir, emittedFiles) {
  const violations = [];

  for (const file of emittedFiles) {
    if (file.type !== 'chunk' && file.type !== 'asset') {
      continue;
    }
    if (!/\.(css|js)$/u.test(file.file)) {
      continue;
    }
    const filePath = path.resolve(outDir, file.file);
    let contents;
    try {
      contents = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      // Skip files that are missing from disk; Rollup might have skipped emitting them.
      continue;
    }
    if (/sourceMappingURL\s*=/u.test(contents)) {
      violations.push(file.file);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Sourcemap references detected in ${violations.join(', ')} despite sourcemaps being disabled.` +
        ' Re-run with --sourcemap to include sourcemaps.',
    );
  }
}

function createBuildSummary(result) {
  const outputs = Array.isArray(result) ? result : [result];
  const files = [];

  for (const output of outputs) {
    if (!output?.output) {
      continue;
    }
    for (const artifact of output.output) {
      const record = {
        file: artifact.fileName,
        type: artifact.type,
      };
      if (artifact.type === 'chunk') {
        record.size = Buffer.byteLength(artifact.code ?? '', 'utf8');
        record.isEntry = artifact.isEntry === true;
      } else if (artifact.type === 'asset') {
        if (typeof artifact.source === 'string') {
          record.size = Buffer.byteLength(artifact.source, 'utf8');
        } else if (artifact.source) {
          record.size = artifact.source.length;
        } else {
          record.size = 0;
        }
      }
      files.push(record);
    }
  }

  return files;
}

async function main() {
  const { mode, sourcemapOverride } = parseArgs(process.argv.slice(2));

  if (mode === 'development') {
    process.env.NODE_ENV = 'development';
  } else {
    process.env.NODE_ENV = 'production';
  }

  if (typeof sourcemapOverride === 'boolean') {
    process.env.BUILD_SOURCEMAP = sourcemapOverride ? 'true' : 'false';
  }

  const configFile = path.resolve(projectRoot, 'vite.config.js');
  const buildResult = await build({
    mode,
    configFile,
    logLevel: 'silent',
  });

  const { config } = await loadConfigFromFile({ command: 'build', mode }, configFile);
  const resolvedConfig = config ?? {};
  const outDirRelative = resolvedConfig.build?.outDir ?? 'dist';
  const outDir = path.resolve(projectRoot, outDirRelative);
  const sourcemapSetting = resolvedConfig.build?.sourcemap ?? false;
  const sourcemapEnabled = isSourcemapEnabled(sourcemapSetting);

  const emittedFiles = createBuildSummary(buildResult);
  const copiedArtifacts = await copyStaticAssets(outDir);

  if (!sourcemapEnabled) {
    const unexpectedMaps = emittedFiles.filter(file => file.file.endsWith('.map'));
    if (unexpectedMaps.length > 0) {
      throw new Error(
        `Sourcemaps were emitted (${unexpectedMaps.map(file => file.file).join(', ')}),` +
          ' but the configuration disabled them. Set BUILD_SOURCEMAP=true to keep sourcemaps.',
      );
    }
    await ensureNoSourcemapReferences(outDir, emittedFiles);
  }

  const summary = {
    mode,
    outDir: path.relative(projectRoot, outDir) || '.',
    sourcemap: sourcemapEnabled,
    generated: emittedFiles,
    copied: copiedArtifacts,
  };

  const logFilePath = path.resolve(outDir, 'build.log.json');
  const logFileRelative = path.relative(projectRoot, logFilePath) || 'build.log.json';
  const summaryWithLogPath = { ...summary, logFile: logFileRelative };

  await fs.writeFile(logFilePath, `${JSON.stringify(summaryWithLogPath, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(summaryWithLogPath, null, 2)}\n`);
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
