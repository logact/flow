const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-task-dag-build-'));
const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc');

try {
  const compile = spawnSync(tsc, [
    '--ignoreConfig',
    '--module', 'Node16',
    '--moduleResolution', 'node16',
    '--target', 'ES2022',
    '--outDir', buildDir,
    '--rootDir', repoRoot,
    '--noEmit', 'false',
    '--incremental', 'false',
    '--esModuleInterop', 'true',
    '--strict',
    '--skipLibCheck',
    path.join(repoRoot, 'lib', 'db.ts'),
    path.join(repoRoot, 'lib', 'scheduler.ts'),
    path.join(repoRoot, 'lib', 'targets.ts'),
    path.join(repoRoot, 'lib', 'config.ts'),
  ], { cwd: repoRoot, encoding: 'utf8' });

  if (compile.stdout) process.stdout.write(compile.stdout);
  if (compile.stderr) process.stderr.write(compile.stderr);
  if (compile.status !== 0) process.exit(compile.status ?? 1);

  const run = spawnSync(process.execPath, ['--test', path.join(__dirname, 'task-implementation-dag.test.cjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FLOW_TEST_BUILD_DIR: buildDir,
      NODE_PATH: [process.env.NODE_PATH, path.join(repoRoot, 'node_modules')].filter(Boolean).join(path.delimiter),
    },
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exitCode = run.status ?? 1;
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
