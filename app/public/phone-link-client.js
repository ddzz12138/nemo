import { LINK_APP_ID, LINK_MAX_RESPONSE, linkDescriptor, keyId, channelBinding, transcript, publicKey, signProof, verifyProof, decode64, linkError } from './phone-link-protocol.js';
import { requestIceGrant } from './phone-link-mailbox.js';

export function createPhoneClient({ descriptor: value, keys, nostr, crypto = globalThis.crypto, PeerConnection = globalThis.RTCPeerConnection, onState = () => {}, socketFactory, grantProvider = requestIceGrant, now = Date.now }) {
  const descriptor = linkDescriptor(value), pending = new Map(), observed = new Set();
  let room, hostPeer, http, cancelAction, generation = 0, closed = false, connectPromise, serverOffset = 0, renewal, cancelConnect;
  const state = (name, detail) => onState({ state: name, ...detail });
  const failPending = () => { for (const item of pending.values()) item.abort(linkError('LINK_INTERRUPTED', 'Connection interrupted. Read the saved result before retrying an action.', 503)); pending.clear(); };
  function leave() { const cancel=cancelConnect;cancelConnect=null;generation++;connectPromise=null;clearTimeout(renewal);hostPeer=null;failPending();room?.leave();room=null;observed.clear();cancel?.(); }
  class ObservedPeer extends PeerConnection { constructor(config) { super(config); observed.add(this); } }
  async function route() {
    try { for (const pc of observed) for (const stat of (await pc.getStats()).values()) if (stat.type === 'transport' && stat.selectedCandidatePairId) { const stats=await pc.getStats(), pair=stats.get(stat.selectedCandidatePairId);return stats.get(pair.localCandidateId)?.candidateType==='relay'||stats.get(pair.remoteCandidateId)?.candidateType==='relay'?'relayed':'direct'; } } catch {}
    return 'connected';
  }
  async function connect() {
    if (closed) throw linkError('LINK_CLOSED', 'This phone connection is closed.', 401);
    if (hostPeer) return;
    if (connectPromise) return connectPromise;
    leave(); const version = generation; state('connecting');
    const grantController=new AbortController();let cancelInner=()=>{},stopAttempt;
    const cancelled=new Promise((_,reject)=>{stopAttempt=()=>{grantController.abort();cancelInner();reject(linkError('LINK_CLOSED','This connection changed. Reconnect before continuing.',401));};});
    cancelConnect=stopAttempt;
    const attempt = (async () => {
      let grant;
      try { grant = await grantProvider({ crypto, descriptor, keys, nostr, socketFactory, signal:grantController.signal }); }
      catch { if(!closed&&version===generation)state('connecting', { note: 'Trying a direct connection. Relay access could not be refreshed.' }); }
      if (closed || version !== generation) throw linkError('LINK_CLOSED', 'This connection changed.', 401);
      return new Promise((resolve,reject)=>{
        let finished=false;
        const deadline=setTimeout(()=>finish(linkError('LINK_NETWORK','Could not reach the host. Keep it awake; this network may need a relay.',503)),25000);
        const finish=error=>{if(finished)return;finished=true;clearTimeout(deadline);if(error){if(cancelConnect===stopAttempt)cancelConnect=null;if(version===generation){leave();state('unavailable');}reject(error);}else resolve();};
        cancelInner=()=>finish(linkError('LINK_CLOSED','This connection changed. Reconnect before continuing.',401));
        room=nostr.joinRoom({appId:LINK_APP_ID,password:descriptor.password,rtcPolyfill:ObservedPeer,
          ...(grant?.iceServers.length?{turnConfig:grant.iceServers}:{}),
          relayConfig:{urls:descriptor.relays,manualReconnection:true,warnOnRelayFailure:false}},descriptor.room,
          {onJoinError(){if(version===generation&&!hostPeer)state('connecting',{note:'Trying available network routes.'});}});
        const auth=room.makeAction('nemo-auth',{kind:'request'});
        http=room.makeAction('nemo-http',{kind:'request'});
        cancelAction=room.makeAction('nemo-cancel');
        room.makeAction('nemo-chunk',{kind:'request',onRequest:async(input,{peerId})=>{
          if(peerId!==hostPeer||version!==generation)return{ok:false};
          const item=pending.get(input?.id);if(!item||input.seq!==item.sequence)return{ok:false};
          item.sequence++;
          if(input.error){item.abort(linkError('LINK_INTERRUPTED',String(input.error).slice(0,160),503));return{ok:true};}
          if(input.end){item.end();return{ok:true};}
          let data;try{data=decode64(input.data,16384);}catch{return{ok:false};}
          item.total+=data.length;if(item.total>LINK_MAX_RESPONSE){item.abort(linkError('LINK_SIZE','This response is too large.',413));return{ok:false};}
          item.controller.enqueue(data);
          if(item.controller.desiredSize<=0)await new Promise(resolve=>{item.resume=resolve;});
          return{ok:!item.stopped};
        }});
        room.onPeerLeave=peerId=>{if(version===generation&&peerId===hostPeer){hostPeer=null;failPending();state('reconnecting');}};
        room.onPeerJoin=async peerId=>{
          if(hostPeer||version!==generation||closed)return;
          try{
            const nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
            const hello=await auth.request({kind:'hello',nonce,clientKey:publicKey(keys.publicKey)},{target:peerId,timeoutMs:10000});
            if(hello.error)throw linkError(hello.error.code,hello.error.message,hello.error.status);
            const text=transcript({id:descriptor.id,clientPeer:nostr.selfId,hostPeer:peerId,nonce,challenge:hello.challenge,clientKey:keys.publicKey,...channelBinding(room.getPeers()[peerId])});
            if(!await verifyProof(crypto,descriptor.hostKey,hello.signature,text))throw linkError('LINK_HOST','This host could not be verified. Ask for a fresh invitation.',401);
            const result=await auth.request({kind:'prove',signature:await signProof(crypto,keys.privateKey,text)},{target:peerId,timeoutMs:10000});
            if(result.error)throw linkError(result.error.code,result.error.message,result.error.status);
            if(result.authenticated!==true||!Number.isSafeInteger(result.serverTime)||version!==generation)return;
            hostPeer=peerId;serverOffset=result.serverTime-now();
            const selectedRoute=await route();if(version!==generation||closed)return;
            state(selectedRoute,{paired:result.paired});finish();
            if(grant?.iceServers.length)renewal=setTimeout(()=>{leave();state('reconnecting');void connect().catch(()=>{});},Math.max(30000,grant.expiresAt-now()-90000));
          }catch(error){if(error.status===401)finish(error);}
        };
      });
    })();
    const task=Promise.race([attempt,cancelled]);connectPromise=task;
    try{return await task;}finally{if(connectPromise===task)connectPromise=null;if(!hostPeer&&version===generation)cancelInner();if(cancelConnect===stopAttempt)cancelConnect=null;}
  }
  return {
    connect,
    async fetch(path,options={}){
      await connect();
      const id=crypto.randomUUID(),method=String(options.method||'GET').toUpperCase(),headers=new Headers(options.headers||{});
      const request={id,method,path,issuedAt:Math.floor(now()+serverOffset),...(options.body!==undefined?{body:options.body}:{}),...(headers.get('X-Nemo-Profile')?{expectedProfile:headers.get('X-Nemo-Profile')}:{})};
      let item;
      const stop=()=>{
        if(item?.stopped)return;
        item?.abort(new DOMException('Request stopped.','AbortError'));
        void cancelAction?.send({id},{target:hostPeer}).catch(()=>{});
      };
      if(options.signal?.aborted)throw new DOMException('Request stopped.','AbortError');
      const stream=new ReadableStream({start(controller){
        item={controller,total:0,sequence:0,stopped:false,resume:null,
          abort(error){if(this.stopped)return;this.stopped=true;this.resume?.();controller.error(error);pending.delete(id);options.signal?.removeEventListener('abort',stop);},
          end(){if(this.stopped)return;this.stopped=true;this.resume?.();controller.close();pending.delete(id);options.signal?.removeEventListener('abort',stop);}};
        pending.set(id,item);
      },pull(){item?.resume?.();if(item)item.resume=null;},cancel(){stop();}}, {highWaterMark:65536,size:chunk=>chunk.length});
      options.signal?.addEventListener('abort',stop,{once:true});
      try{
        const response=await http.request(request,{target:hostPeer,timeoutMs:15000});
        if(item.stopped)throw new DOMException('Request stopped.','AbortError');
        if(response.error){item.end();return new Response(JSON.stringify({error:response.error.message,code:response.error.code}),{status:response.error.status||503,headers:{'content-type':'application/json'}});}
        if(!Number.isInteger(response.status)||response.status<200||response.status>599)throw new Error('Invalid phone response.');
        if(!response.stream){item.end();return new Response(response.body||'',{status:response.status,headers:response.headers});}
        if(method==='HEAD'||[204,205,304].includes(response.status)){item.end();return new Response(null,{status:response.status,headers:response.headers});}
        return new Response(stream,{status:response.status,headers:response.headers});
      }catch(error){item.abort(error);void stream.cancel().catch(()=>{});throw error;}
    },
    suspend(){leave();state('paused');},
    close(){closed=true;leave();state('closed');},
  };
}
