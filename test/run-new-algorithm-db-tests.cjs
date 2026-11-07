const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-new-db-build-'));
try {
  const compiled = spawnSync(path.join(root,'node_modules/.bin/tsc'), ['--ignoreConfig','--module','Node16','--moduleResolution','node16','--target','ES2022','--outDir',output,'--rootDir',root,'--noEmit','false','--strict','--skipLibCheck',path.join(root,'lib/new-algorithm-db.ts'),path.join(root,'lib/new-algorithm-settlement.ts'),path.join(root,'lib/new-algorithm-import.ts')], {cwd:root,encoding:'utf8'});
  process.stdout.write(compiled.stdout); process.stderr.write(compiled.stderr);
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);
  const run = spawnSync(process.execPath,['--test',path.join(__dirname,'new-algorithm-db.test.cjs')],{cwd:root,encoding:'utf8',env:{...process.env,FLOW_TEST_BUILD_DIR:output,NODE_PATH:path.join(root,'node_modules')}});
  process.stdout.write(run.stdout); process.stderr.write(run.stderr);
  process.exitCode = run.status ?? 1;
} finally { fs.rmSync(output,{recursive:true,force:true}); }
