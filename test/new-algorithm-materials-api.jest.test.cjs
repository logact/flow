jest.mock('../lib/llm',()=>({requestLlmJson:jest.fn()}));
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {requestLlmJson}=require('../lib/llm');
const {getNewAlgorithmDb}=require('../lib/new-algorithm-runtime-db');
const {POST}=require('../app/api/new-algorithm/materials/route');

let directory,previous,db;
function setupWord(){
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'flow-new-material-api-'));
  previous=process.env.FLOW_NEW_ALGORITHM_DB;process.env.FLOW_NEW_ALGORITHM_DB=path.join(directory,'new.db');delete global.__newAlgorithmDb;
  db=getNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,meaning_version,level,target_r,target_p,local_timezone,created_at) VALUES(1,'carry','transport something from one place to another',1,'B1',80,80,'UTC',1)").run();
  requestLlmJson.mockReset();
}
function request(axis){return new Request('http://localhost/api/new-algorithm/materials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wordId:1,axis})});}
function rDraft(){return {publicPayload:{passage:Array(100).fill('carry').join(' '),questions:[{prompt:'What happens?'},{prompt:'Why does it happen?'}]},answerKey:{questions:[{answer:'A',evidence:'Carry transports it.'},{answer:'B',evidence:'The passage states this.'}]},gradingRequirements:{targetMeaning:'transport something from one place to another',targetForms:['carry'],targetOccurrences:5,level:'B1'},timingProtocol:{},validation:{}};}
function pDraft(){return {publicPayload:{scene_zh:'你帮朋友把几箱书搬到新住处，途中又接到临时电话。请说明你如何安排。',instructions_zh:'用英语写一段连贯叙述，交代事情经过和处理方式。'},answerKey:{sample:'I carried the boxes upstairs before calling back.',notes:'The target expresses transporting the boxes.'},gradingRequirements:{target_form:'carry',forbidden_target_forms:['carried','carries','carrying']},timingProtocol:{},validation:{}};}

beforeEach(()=>setupWord());
afterEach(()=>{if(db){db.close();db=null;}delete global.__newAlgorithmDb;if(previous===undefined)delete process.env.FLOW_NEW_ALGORITHM_DB;else process.env.FLOW_NEW_ALGORITHM_DB=previous;if(directory)fs.rmSync(directory,{recursive:true,force:true});});

describe('new algorithm fluency material API',()=>{
  test.each([['r',rDraft],['p',pDraft]])('%s material uses provider and persists only validated current-version material',async(axis,draftFactory)=>{
    requestLlmJson.mockResolvedValue(draftFactory());
    const response=await POST(request(axis));const body=await response.json();
    expect(response.status).toBe(200);expect(body).toMatchObject({status:'ready',attempts:1,id:`1:${axis}:fluency:1`});
    const saved=db.prepare('SELECT axis,stage,meaning_version,status,public_payload,answer_key FROM materials WHERE id=?').get(body.id);
    expect(saved).toMatchObject({axis,stage:'fluency',meaning_version:1,status:'ready'});
    if(axis==='p'){expect(saved.public_payload).not.toMatch(/carry|carried/i);expect(saved.answer_key).toContain('carried');}
    expect(requestLlmJson).toHaveBeenCalledTimes(1);
  });

  test('invalid drafts retry twice and remain unavailable to task lookup',async()=>{
    requestLlmJson.mockResolvedValue({...pDraft(),publicPayload:{scene_zh:'请用 carry 描述',instructions_zh:'写作'}});
    const response=await POST(request('p'));const body=await response.json();
    expect(response.status).toBe(422);expect(body).toMatchObject({status:'failed',attempts:2});
    expect(requestLlmJson).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT status,generation_attempts FROM materials WHERE id=?').get(body.id)).toEqual({status:'failed',generation_attempts:2});
  });

  test('a meaning edit during generation rejects the stale result without another provider call',async()=>{
    requestLlmJson.mockImplementation(async()=>{db.prepare('UPDATE words SET meaning=?,meaning_version=meaning_version+1 WHERE id=1').run('move something to another place');return rDraft();});
    const response=await POST(request('r'));const body=await response.json();
    expect(response.status).toBe(422);expect(body).toMatchObject({status:'failed',attempts:1,reason:'MEANING_VERSION_CHANGED'});
    expect(requestLlmJson).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status,generation_attempts FROM materials WHERE id=?').get(body.id)).toEqual({status:'failed',generation_attempts:1});
  });

  test.each([{wordId:0,axis:'r'},{wordId:1,axis:'both'}])('rejects invalid generation request %j',async input=>{
    const response=await POST(new Request('http://localhost/api/new-algorithm/materials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
    expect(response.status).toBe(400);expect(requestLlmJson).not.toHaveBeenCalled();
  });
});
