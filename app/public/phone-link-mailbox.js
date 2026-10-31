import { encode64, decode64, keyId, publicKey, signProof, verifyProof, linkError } from './phone-link-protocol.js';
const bytes = value => new TextEncoder().encode(value);
export async function mailboxTopic(crypto, link) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(`nemo-ice-topic-v1:${link.room}:${link.password}`)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function boxKey(crypto, password) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', bytes(`nemo-ice-key-v1:${password}`)), { name: 'AES-GCM' }, false, ['encrypt','decrypt']); }
export async function sealMailbox(crypto, link, topic, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(topic) }, await boxKey(crypto, link.password), bytes(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: encode64(iv), data: encode64(new Uint8Array(data)) });
}
export async function openMailbox(crypto, link, topic, value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid discovery envelope.');
  const envelope = JSON.parse(value);
  if (envelope?.v !== 1) throw new Error('Invalid discovery envelope.');
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(envelope.iv,12), additionalData: bytes(topic) }, await boxKey(crypto, link.password), decode64(envelope.data,12000));
  return JSON.parse(new TextDecoder().decode(data));
}
export const iceRequestText = request => JSON.stringify(['nemo-ice-request-v1', request.id, request.nonce, request.issuedAt, keyId(request.clientKey)]);
export const iceReplyText = reply => JSON.stringify(['nemo-ice-reply-v1', reply.id, reply.nonce, reply.expiresAt, reply.iceServers, keyId(reply.clientKey)]);

/** Encrypted, signed control messages only. No chat, account data or shared
 * TURN secrets are published here. Nostr event signing uses Trystero's library. */
export function createDiscoveryMailbox({ relays, nostr, onMessage, topics = () => [], socketFactory = url => new WebSocket(url) }) {
  const sockets = new Map(); let closed = false;
  const timers = new Set();
  function subscribe(socket) {
    if (socket.readyState !== 1) return;
    const list = topics();
    socket.send(JSON.stringify(['CLOSE','nemo-ice']));
    if (list.length) socket.send(JSON.stringify(['REQ','nemo-ice', ...list.map(topic => JSON.parse(nostr.subscribe('nemo-ice',topic))[2])]));
  }
  function open(url, attempt = 0) {
    if (closed) return;
    const socket = socketFactory(url); sockets.set(url,socket);
    let retired = false;
    socket.addEventListener('open',()=>subscribe(socket));
    socket.addEventListener('message',event=>{
      try {
        if (typeof event.data !== 'string' || event.data.length > 24576) return;
        const message = JSON.parse(event.data);
        if (message[0] === 'EVENT' && message[1] === 'nemo-ice') {
          const topic = message[2]?.tags?.find(tag => tag[0] === 'x')?.[1];
          if (topics().includes(topic)) void Promise.resolve(onMessage(topic,message[2].content)).catch(()=>{});
        }
        // Respect a relay rejection. Never cycle keys or route around its limits.
        if ((message[0] === 'CLOSED' || message[0] === 'OK' && message[2] === false) && /^(blocked|restricted|auth-required|pow|rate-limited):/.test(String(message.at(-1)))) { retired = true; socket.close(); }
      } catch {}
    });
    socket.addEventListener('error',()=>{});
    socket.addEventListener('close',()=>{
      if (sockets.get(url) === socket) sockets.delete(url);
      if (!closed && !retired) { const timer = setTimeout(()=>{timers.delete(timer);open(url,attempt+1);},Math.min(60000,5000*2**Math.min(attempt,4))); timers.add(timer); timer.unref?.(); }
    });
  }
  for (const url of relays) open(url);
  return {
    refresh() { for (const socket of sockets.values()) subscribe(socket); },
    async send(topic, content) {
      if (closed) return false;
      const event = await nostr.createEvent(topic,content); let sent = false;
      for (const socket of sockets.values()) if (socket.readyState === 1) { socket.send(event); sent = true; }
      return sent;
    },
    status() { return { connected: [...sockets.values()].some(socket=>socket.readyState===1) }; },
    close() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); for (const socket of sockets.values()) socket.close(); sockets.clear(); },
  };
}

export async function requestIceGrant({ crypto, descriptor, keys, nostr, socketFactory, timeoutMs = 9000, signal }) {
  if(signal?.aborted)throw new DOMException('Connection stopped.','AbortError');
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const topic = await mailboxTopic(crypto,descriptor);
  const request = { kind:'ice-request', id:descriptor.id, nonce, issuedAt:Date.now(), clientKey:publicKey(keys.publicKey) };
  request.signature = await signProof(crypto,keys.privateKey,iceRequestText(request));
  const sealed = await sealMailbox(crypto,descriptor,topic,request);
  return new Promise((resolve,reject)=>{
    let done=false,mailbox;
    const abort=()=>finish(new DOMException('Connection stopped.','AbortError'));
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(deadline);clearInterval(retry);signal?.removeEventListener('abort',abort);mailbox?.close();error?reject(error):resolve(result);};
    const deadline=setTimeout(()=>finish(linkError('LINK_DISCOVERY','Could not refresh relay access. Check that the host is awake and online.',503)),timeoutMs);
    const retry=setInterval(()=>{void mailbox?.send(topic,sealed).catch(()=>{});},2000);
    mailbox=createDiscoveryMailbox({relays:descriptor.relays,nostr,socketFactory,topics:()=>[topic],onMessage:async(_topic,content)=>{
      try{
        const reply=await openMailbox(crypto,descriptor,topic,content);
        if(reply.kind!=='ice-response'||reply.id!==descriptor.id||reply.nonce!==nonce||keyId(reply.clientKey)!==keyId(request.clientKey)||!Number.isSafeInteger(reply.expiresAt)||reply.expiresAt<Date.now()||reply.expiresAt>Date.now()+900000||!Array.isArray(reply.iceServers)||reply.iceServers.length>3)return;
        if(!await verifyProof(crypto,descriptor.hostKey,reply.signature,iceReplyText(reply)))return;
        for(const server of reply.iceServers){if(!Array.isArray(server.urls)||server.urls.length>3||!server.urls.every(url=>/^turns?:[a-z0-9.-]+:\d{2,5}\?transport=(udp|tcp)$/i.test(url))||typeof server.username!=='string'||typeof server.credential!=='string'||server.username.length>200||server.credential.length>200)return;}
        finish(null,{iceServers:reply.iceServers,expiresAt:reply.expiresAt});
      }catch{}
    }});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
