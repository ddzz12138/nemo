import {setTimeout as delay} from 'node:timers/promises';
import {parseNativeCursor} from './native-events.mjs';

/** An authenticated notification stream. Frames never carry source contents or
 * commands; clients fetch the latest task view after a notification or gap. */
export async function serveNativeStream({req,res,readChanges,authorize,signal,after,pollMs=250,maxMs=25000}){
  parseNativeCursor(after);if(!await authorize())throw Object.assign(new Error('This device was signed out.'),{status:401,code:'AUTH_REQUIRED'});
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});res.once('close',abort);req.once('aborted',abort);
  if(signal?.aborted)abort();
  let cursor=after,lastAuthorization=Date.now(),lastHeartbeat=Date.now();const deadline=Date.now()+maxMs;
  try{
    const initial=await readChanges(cursor);if(controller.signal.aborted||signal?.aborted)return;
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    function write(value){if(!res.write('id: '+value.cursor+'\nevent: change\ndata: '+JSON.stringify(value)+'\n\n'))controller.abort();}
    function send(changes){if(changes.reset)write({cursor:changes.cursor,reset:true});else for(const event of changes.events){if(controller.signal.aborted)break;write({cursor:event.cursor,taskId:event.taskId});}cursor=changes.cursor;}
    send(initial);
    while(!controller.signal.aborted&&Date.now()<deadline){
      await delay(pollMs,undefined,{signal:controller.signal});
      if(Date.now()-lastAuthorization>=1000){if(!await authorize())break;lastAuthorization=Date.now();}
      send(await readChanges(cursor));
      if(Date.now()-lastHeartbeat>=12000){if(!res.write(': still connected\n\n'))break;lastHeartbeat=Date.now();}
    }
  }catch(error){if(!controller.signal.aborted&&!res.headersSent)throw error;}
  finally{signal?.removeEventListener('abort',abort);res.off('close',abort);req.off('aborted',abort);if(res.headersSent||controller.signal.aborted)res.end();}
}
