const { spawnSync }=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=path.resolve(__dirname,'..');const build=fs.mkdtempSync(path.join(os.tmpdir(),'flow-scenarios-'));
try {
  const compile=spawnSync(path.join(root,'node_modules/.bin/tsc'),['--ignoreConfig','--module','Node16','--moduleResolution','node16','--target','ES2022','--outDir',build,'--rootDir',root,'--noEmit','false','--strict','--skipLibCheck',path.join(root,'lib/new-algorithm-score.ts')],{cwd:root,encoding:'utf8'});
  process.stdout.write(compile.stdout);process.stderr.write(compile.stderr);
  if(compile.status!==0)process.exit(compile.status??1);
  const report=path.join(root,'test-report/new-algorithm/scenarios.md');
  const run=spawnSync(process.execPath,['--test',path.join(__dirname,'new-algorithm-scenarios.test.cjs')],{cwd:root,encoding:'utf8',env:{...process.env,FLOW_TEST_BUILD_DIR:build,FLOW_SCENARIO_REPORT:report}});
  process.stdout.write(run.stdout);process.stderr.write(run.stderr);process.exitCode=run.status??1;
} finally {fs.rmSync(build,{recursive:true,force:true});}
