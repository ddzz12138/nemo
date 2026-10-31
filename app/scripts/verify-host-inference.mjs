// Explicit single synthetic inference diagnostic; no native workers or sources.
import { randomUUID } from 'node:crypto';
import { createHermesForwarder } from '../lib/hermes-forwarder.mjs';
const forward=createHermesForwarder({pythonPath:process.env.NEMO_TEST_HERMES_PYTHON,sourceRoot:process.env.NEMO_TEST_HERMES_SOURCE,hermesHome:process.env.NEMO_TEST_HOST_HOME});
const profileId=randomUUID(),signal=AbortSignal.timeout(45_000);
const metadata=await forward({profileId,path:'/v1/models',method:'GET',body:null,signal});
if(metadata.status!==200)throw new Error('Host model metadata is unavailable.');
const model=(await metadata.json()).data[0].id;
const response=await forward({profileId,path:'/v1/responses',method:'POST',signal,body:{model,instructions:'This is a synthetic Nemo connection check. Return the requested marker only.',input:[{role:'user',content:'Reply with SYNTHETIC_NEMO_CONNECTION_OK.'}],stream:true,store:false}});
if(response.status!==200){const value=await response.json();console.log(JSON.stringify({ok:false,status:response.status,reason:value.reason}));process.exitCode=1;}
else{const text=await response.text();const ok=text.includes('SYNTHETIC_NEMO_CONNECTION_OK');console.log(JSON.stringify({ok,status:response.status,streamed:true,realModelCalls:1,connectedSourceReads:0}));if(!ok)process.exitCode=1;}
