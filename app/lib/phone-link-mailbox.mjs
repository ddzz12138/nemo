import { webcrypto } from 'node:crypto';
import { createDiscoveryMailbox, mailboxTopic, openMailbox, sealMailbox, iceRequestText, iceReplyText } from '../public/phone-link-mailbox.js';
import { keyId, signProof, verifyProof } from '../public/phone-link-protocol.js';

export async function createHostMailbox({ settings, links, active, hostSigningKey, grant, now = Date.now, nostr, socketFactory }) {
  nostr ||= await import('@trystero-p2p/nostr');
  const subjects=new Map(),seen=new Map(),rates=new Map(); let closed=false;
  const mailbox=createDiscoveryMailbox({relays:settings.relays,nostr,socketFactory,topics:()=>[...subjects.keys()],onMessage:async(topic,content)=>{
    const record=subjects.get(topic);if(!record||closed)return;
    try{
      const request=await openMailbox(webcrypto,record,topic,content);
      if(request.kind!=='ice-request'||request.id!==record.id||!/^[a-f0-9]{64}$/.test(request.nonce||'')||!Number.isSafeInteger(request.issuedAt)||Math.abs(now()-request.issuedAt)>120000)return;
      if(record.clientKey&&keyId(record.clientKey)!==keyId(request.clientKey)||!await active(record))return;
      if(!await verifyProof(webcrypto,request.clientKey,request.signature,iceRequestText(request)))return;
      for(const [id,value]of seen)if(value.at<now()-120000)seen.delete(id);
      const identity=record.id+':'+request.nonce,previous=seen.get(identity);
      if(previous){await mailbox.send(topic,await previous.reply);return;}
      const recent=(rates.get(record.id)||[]).filter(at=>now()-at<60000);if(recent.length>=6)return;
      rates.set(record.id,[...recent,now()]);
      const operation=(async()=>{
        const reply={kind:'ice-response',id:record.id,nonce:request.nonce,clientKey:request.clientKey,...grant(record.id)};
        reply.signature=await signProof(webcrypto,hostSigningKey,iceReplyText(reply));
        return sealMailbox(webcrypto,record,topic,reply);
      })();
      seen.set(identity,{at:now(),reply:operation});
      await mailbox.send(topic,await operation);
    }catch{}
  }});
  async function refresh(){subjects.clear();for(const record of links())if(await active(record))subjects.set(await mailboxTopic(webcrypto,record),record);if(!closed)mailbox.refresh();}
  await refresh();
  return { refresh, status:mailbox.status, close(){closed=true;mailbox.close();subjects.clear();seen.clear();rates.clear();} };
}
