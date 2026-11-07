import { NextResponse } from 'next/server';
import { getNewAlgorithmDb } from '../../../../lib/new-algorithm-runtime-db';
import { getOrIssueNewAlgorithmTask, NewAlgorithmTaskError, submitNewAlgorithmTaskResponse } from '../../../../lib/new-algorithm-task-service';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getOrIssueNewAlgorithmTask(getNewAlgorithmDb(),Date.now()));
  } catch(error) {
    if(error instanceof NewAlgorithmTaskError)return NextResponse.json({error:error.message},{status:error.status});
    throw error;
  }
}

export async function POST(request:Request) {
  try {
    const body=await request.json() as {instanceId?:unknown;response?:unknown};
    if(typeof body.instanceId!=='string')return NextResponse.json({error:'instanceId is required'},{status:400});
    const result=submitNewAlgorithmTaskResponse(getNewAlgorithmDb(),{instanceId:body.instanceId,response:body.response,now:Date.now()});
    return NextResponse.json(result);
  } catch(error) {
    if(error instanceof NewAlgorithmTaskError)return NextResponse.json({error:error.message},{status:error.status});
    if(error instanceof SyntaxError)return NextResponse.json({error:'invalid JSON body'},{status:400});
    throw error;
  }
}
