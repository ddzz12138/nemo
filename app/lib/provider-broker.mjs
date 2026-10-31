import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
const revision=profile=>`${profile?.policyRevision||0}:${profile?.childModeRevision||0}:${profile?.childMode===true}`;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

/** Internal credential boundary. A host adapter supplies forward(); no provider
 * credential, URL override or acting profile is accepted from a worker request.
 * Not started by the legacy bridge and not exposed through Tailscale. */
export function createProviderBroker({getProfile,forward,executeTool,authorizeTask,maximumConcurrent=2,now=Date.now}) {
  if(typeof getProfile!=='function'||typeof forward!=='function'||typeof authorizeTask!=='function'||!Number.isInteger(maximumConcurrent)||maximumConcurrent<1||maximumConcurrent>2)throw new Error('Trusted profile/task resolvers and a provider adapter with at most two requests are required.');
  const grants=new Map();let active=0;let closed=false;
  const server=http.createServer(async(req,res)=>{
    const reply=(status,message)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:message}));}else res.destroy();};
    let grant;let controller;let admitted=false;let expiryTimer;
    try{
      if(closed)fail(503,'Provider broker is stopping.');
      if(req.headers.origin)fail(403,'Provider access is server-to-server only.');
      const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
      grant=token?grants.get(digest(token)):null;
      if(!grant||grant.revoked||grant.expiresAt<=now())fail(401,'Worker authorization expired.');
      const profile=await getProfile(grant.profileId);
      if(!profile||profile.id!==grant.profileId||profile.disabled||revision(profile)!==grant.revision)fail(401,'Profile permissions changed.');
      const path=req.url;
      const toolCall=req.method==='POST'&&path==='/v1/nemo/tools/call'&&typeof executeTool==='function';
      if(!(toolCall||(req.method==='POST'&&['/v1/chat/completions','/v1/responses'].includes(path))||(req.method==='GET'&&path==='/v1/models')))fail(404,'Provider operation is not exposed.');
      const taskId=grant.taskId;
      if(req.method==='POST'&&(!taskId||await authorizeTask({profileId:grant.profileId,taskId})!==true))fail(403,'No active task authorizes this provider request.');
      if(active>=maximumConcurrent)fail(429,'Provider capacity reached. Retry only before prompt admission.');
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>2_000_000)fail(413,'Provider request is too large.');chunks.push(chunk);}
      let body=null;
      if(req.method==='POST'){
        try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid provider request.');}
        if(!body||Array.isArray(body)||typeof body!=='object'||['profileId','owner','base_url','api_key','authorization'].some(key=>Object.hasOwn(body,key)))fail(400,'Identity and provider settings are controlled by the host.');
        if(toolCall&&(Object.keys(body).some(key=>!['callId','name','arguments'].includes(key))||!UUID.test(body.callId||'')||!['calendar_list','gmail_search','memory_search','clarify','todo_list'].includes(body.name)||!body.arguments||typeof body.arguments!=='object'||Array.isArray(body.arguments)||Buffer.byteLength(JSON.stringify(body.arguments))>4000))fail(400,'Use an exact approved tool call.');
      }
      const current=await getProfile(grant.profileId);
      if(grant.revoked||grant.expiresAt<=now()||!current||current.id!==grant.profileId||current.disabled||revision(current)!==grant.revision)fail(401,'Profile permissions changed.');
      if(req.method==='POST'&&(grant.taskId!==taskId||await authorizeTask({profileId:grant.profileId,taskId})!==true))fail(403,'This task is paused or changed.');
      if(active>=maximumConcurrent)fail(429,'Provider capacity reached. Retry only before prompt admission.');
      controller=new AbortController();grant.inflight.add(controller);active++;admitted=true;
      res.once('close',()=>controller.abort());
      expiryTimer=setTimeout(()=>{controller.abort();reply(401,'Worker authorization expired.');},Math.max(1,grant.expiresAt-now()));expiryTimer.unref();
      const upstream=toolCall?Response.json(await executeTool({profileId:grant.profileId,taskId,...body,signal:controller.signal})):await forward({profileId:grant.profileId,taskId,path,method:req.method,body,signal:controller.signal});
      const stillAuthorized=async()=>{const latest=await getProfile(grant.profileId);return !grant.revoked&&!controller.signal.aborted&&grant.expiresAt>now()&&latest?.id===grant.profileId&&!latest.disabled&&revision(latest)===grant.revision&&(req.method!=='POST'||grant.taskId===taskId&&await authorizeTask({profileId:grant.profileId,taskId})===true);};
      if(!await stillAuthorized())fail(401,'Worker authorization expired.');
      if(!(upstream instanceof Response))fail(502,'The configured provider adapter is unavailable.');
      res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store'});
      if(upstream.body)for await(const chunk of upstream.body){if(!await stillAuthorized())fail(401,'Worker authorization expired.');if(!res.write(chunk))await new Promise(resolve=>{const finish=()=>{res.off('drain',finish);res.off('close',finish);resolve();};res.once('drain',finish);res.once('close',finish);});}
      res.end();
    }catch(error){reply(error.status||502,error.status?error.message:'The provider could not complete this request.');}
    finally{clearTimeout(expiryTimer);if(admitted)active--;if(controller){controller.abort();grant.inflight.delete(controller);}}
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.maxHeadersCount=20;
  return{
    server,
    async issue(profileId,{taskId=null,ttlMs=3_600_000}={}){
      if(closed||!UUID.test(profileId||''))throw new Error('A trusted active profile is required.');
      const profile=await getProfile(profileId);if(!profile||profile.id!==profileId||profile.disabled)throw new Error('This profile is not active.');
      if(!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>3_600_000||taskId!==null&&(!UUID.test(taskId)||await authorizeTask({profileId,taskId})!==true))throw new Error('A valid task and bounded worker grant are required.');
      const token=randomBytes(32).toString('hex');grants.set(digest(token),{profileId,taskId,expiresAt:now()+ttlMs,revision:revision(profile),revoked:false,inflight:new Set()});return token;
    },
    async bind(token,taskId){const grant=grants.get(digest(token));if(!grant||grant.revoked||grant.expiresAt<=now()||grant.inflight.size||!UUID.test(taskId||'')||await authorizeTask({profileId:grant.profileId,taskId})!==true)throw new Error('This worker cannot bind to that task.');const profile=await getProfile(grant.profileId);if(!profile||profile.id!==grant.profileId||profile.disabled||revision(profile)!==grant.revision)throw new Error('Profile permissions changed.');grant.taskId=taskId;},
    pause(token){const grant=grants.get(digest(token));if(grant){grant.taskId=null;for(const controller of grant.inflight)controller.abort();}},
    revoke(profileId){for(const [key,grant]of grants)if(grant.profileId===profileId){grant.revoked=true;for(const controller of grant.inflight)controller.abort();grants.delete(key);}},
    async close(){closed=true;for(const grant of grants.values()){grant.revoked=true;for(const controller of grant.inflight)controller.abort();}grants.clear();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
