const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const route = require('../app/api/new-algorithm/goals/route');
const runtimeDb = require('../lib/new-algorithm-runtime-db');
let filename;
let priorFilename;
let db;

describe('new algorithm goals API', () => {
  beforeEach(() => {
    filename=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'flow-goals-api-')),'isolated.db');
    priorFilename=process.env.FLOW_NEW_ALGORITHM_DB;
    process.env.FLOW_NEW_ALGORITHM_DB=filename;
    delete global.__newAlgorithmDb;
    db=runtimeDb.getNewAlgorithmDb();
  });
  afterEach(() => {
    db.close();
    delete global.__newAlgorithmDb;
    if(priorFilename===undefined) delete process.env.FLOW_NEW_ALGORITHM_DB; else process.env.FLOW_NEW_ALGORITHM_DB=priorFilename;
    fs.rmSync(path.dirname(filename),{recursive:true,force:true});
  });
  test('requires explicit timezone instead of silently using UTC', async () => {
    const response=await route.GET(new Request('http://localhost/api/new-algorithm/goals'));
    expect(response.status).toBe(400);
  });
  test('configures capacity/window without trusting client completed count', async () => {
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'configure',timezone:'Asia/Shanghai',capacity:9,completed:8,windowStart:'08:00',windowEnd:'23:00'})}));
    expect(response.status).toBe(200);
    expect(db.prepare('select capacity,completed from daily_capacity').get()).toEqual({capacity:9,completed:0});
  });
  test('rejects malformed configure and import requests without inserting words', async () => {
    const badConfig=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'configure',timezone:'bad-zone',capacity:9,windowStart:'08:00',windowEnd:'23:00'})}));
    expect(badConfig.status).toBe(400);
    const missingTimezone=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'import',words:[{term:'word',rank:1,vocabularySize:10}]})}));
    expect(missingTimezone.status).toBe(400);
    expect(db.prepare('select count(*) n from words').get().n).toBe(0);
  });
  test('API import fails closed when no capacity has been configured', async () => {
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'import',timezone:'Asia/Shanghai',words:[{term:'word',rank:1,vocabularySize:10}]})}));
    expect(response.status).toBe(409);
    expect(db.prepare('select count(*) n from words').get().n).toBe(0);
    expect(db.prepare('select count(*) n from capacity_reservations').get().n).toBe(0);
  });
});
