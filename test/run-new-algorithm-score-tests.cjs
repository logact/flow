const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-new-algorithm-'));
try {
  const compiled = spawnSync(path.join(root,'node_modules/.bin/tsc'), ['--ignoreConfig','--module','Node16','--moduleResolution','node16','--target','ES2022','--outDir',output,'--rootDir',root,'--noEmit','false','--strict','--skipLibCheck',path.join(root,'lib/new-algorithm-score.ts')], {cwd:root,encoding:'utf8'});
  if (compiled.stdout) process.stdout.write(compiled.stdout);
  if (compiled.stderr) process.stderr.write(compiled.stderr);
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);
  const run = spawnSync(process.execPath,['--test',path.join(__dirname,'new-algorithm-score.test.cjs')],{cwd:root,encoding:'utf8',env:{...process.env,FLOW_TEST_BUILD_DIR:output}});
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exitCode = run.status ?? 1;
} finally { fs.rmSync(output,{recursive:true,force:true}); }
