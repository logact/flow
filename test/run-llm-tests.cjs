const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-llm-build-'));
const configPath = path.join(buildDir, 'tsconfig.json');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const config = {
  compilerOptions: {
    target: 'ES2022', module: 'Node16', moduleResolution: 'Node16',
    types: ['node'],
    typeRoots: [path.join(root, 'node_modules/@types')],
    rootDir: root, outDir: buildDir, esModuleInterop: true,
    strict: true, skipLibCheck: true, incremental: false,
  },
  files: [path.join(root, 'lib/llm.ts'), path.join(root, 'types/server-only.d.ts')],
};

try {
  fs.writeFileSync(configPath, JSON.stringify(config));
  const compile = spawnSync(tsc, ['--project', configPath], { cwd: root, encoding: 'utf8' });
  if (compile.stdout) process.stdout.write(compile.stdout);
  if (compile.stderr) process.stderr.write(compile.stderr);
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    const run = spawnSync(process.execPath, ['--test', path.join(__dirname, 'llm.test.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FLOW_LLM_BUILD_DIR: buildDir },
    });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    process.exitCode = run.status ?? 1;
  }
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
