import { NextResponse } from 'next/server';
import { getNewAlgorithmDb } from '../../../../lib/new-algorithm-runtime-db';
import { endNewAlgorithmTask, getNewAlgorithmTaskInstance, getOrIssueNewAlgorithmTask, interruptNewAlgorithmPWriting, NewAlgorithmTaskError, startNewAlgorithmPWriting, submitNewAlgorithmFluencyAnswer, submitNewAlgorithmRetrievalAnswer, submitNewAlgorithmTaskResponse } from '../../../../lib/new-algorithm-task-service';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request=new Request('http://localhost/api/new-algorithm/task')) {
  try {
    const db=getNewAlgorithmDb();
    const instanceId=new URL(request.url).searchParams.get('instanceId');
    if(instanceId){const task=getNewAlgorithmTaskInstance(db,instanceId);return task?NextResponse.json(task):NextResponse.json({error:'Unknown task instance'},{status:404});}
    return NextResponse.json(getOrIssueNewAlgorithmTask(db,Date.now()));
  } catch(error) {
    if(error instanceof NewAlgorithmTaskError)return NextResponse.json({error:error.message},{status:error.status});
    throw error;
  }
}

export async function POST(request:Request) {
  try {
    const body=await request.json() as {instanceId?:unknown;response?:unknown;action?:unknown};
    if(typeof body.instanceId!=='string')return NextResponse.json({error:'instanceId is required'},{status:400});
    if(body.action==='start_writing')return NextResponse.json(startNewAlgorithmPWriting(getNewAlgorithmDb(),{instanceId:body.instanceId,now:Date.now()}));
    if(body.action==='interrupt_writing')return NextResponse.json(interruptNewAlgorithmPWriting(getNewAlgorithmDb(),{instanceId:body.instanceId,now:Date.now()}));
    if(body.action==='skip'||body.action==='exit')return NextResponse.json(endNewAlgorithmTask(getNewAlgorithmDb(),{instanceId:body.instanceId,action:body.action,now:Date.now()}));
    const db=getNewAlgorithmDb();
    const row=db.prepare('SELECT type,stage FROM task_instances WHERE instance_id=?').get(body.instanceId) as {type:string;stage:string}|undefined;
    const result=row?.type==='RETRIEVE'&&['cued','free'].includes(row.stage)
      ?await submitNewAlgorithmRetrievalAnswer(db,{instanceId:body.instanceId,response:body.response,now:Date.now()})
      :row?.type==='FLUENCY'
        ?await submitNewAlgorithmFluencyAnswer(db,{instanceId:body.instanceId,response:body.response,now:Date.now()})
      :submitNewAlgorithmTaskResponse(db,{instanceId:body.instanceId,response:body.response,now:Date.now()});
    return NextResponse.json(result);
  } catch(error) {
    if(error instanceof NewAlgorithmTaskError)return NextResponse.json({error:error.message},{status:error.status});
    if(error instanceof SyntaxError)return NextResponse.json({error:'invalid JSON body'},{status:400});
    throw error;
  }
}
