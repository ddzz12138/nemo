/* Install before identity.js so all existing authenticated API clients use the
 * selected transport. Static files still load through the normal HTTPS origin. */
(() => {
  'use strict';
  const nativeFetch=window.fetch.bind(window),pointer='nemo.phone.active.v1';
  let raw,invitationCode='',record,client,db,closed=false,pendingInvitation;
  const fragment=new URLSearchParams(location.hash.slice(1));
  if(fragment.has('phone')){
    const value=fragment.get('phone');
    history.replaceState(null,'',location.pathname+location.search);
    try{if(value.length>6000)throw new Error();raw=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));invitationCode=raw.invite||'';}catch{raw={invalid:true};}
  }
  let activeId='';try{activeId=localStorage.getItem(pointer)||'';}catch{}
  if(!raw&&!activeId&&!window.NEMO_PHONE_APP)return;
  const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
  const standalone=()=>navigator.standalone===true||window.matchMedia('(display-mode: standalone)').matches;
  const state=value=>{window.dispatchEvent(new CustomEvent('nemo-phone-state',{detail:value}));api.state=value;};
  const database=()=>new Promise((resolve,reject)=>{const request=indexedDB.open('nemo-phone-keys-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('connections',{keyPath:'id'});request.onerror=()=>reject(new Error('Phone storage is unavailable. Open Nemo outside private browsing.'));request.onsuccess=()=>resolve(request.result);});
  const transaction=(mode,operation)=>new Promise((resolve,reject)=>{const tx=db.transaction('connections',mode),request=operation(tx.objectStore('connections'));let result;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(new Error('Nemo could not save this phone connection.'));tx.onabort=tx.onerror;});
  const modules=Promise.all([import('/phone-link-protocol.js'),import('/phone-link-client.js'),import('/vendor/phone-link/nostr/index.mjs')]);
  const ready=(async()=>{
    const[protocol]=await modules;db=await database();
    if(raw){
      const descriptor=protocol.linkDescriptor(raw);
      if(!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(invitationCode))throw new Error('This invitation is invalid. Ask for a fresh QR code.');
      const selected=activeId?await transaction('readonly',store=>store.get(activeId)):null;
      const previous=await transaction('readonly',store=>store.get(descriptor.id));
      if(previous&&protocol.keyId(previous.descriptor.hostKey)!==protocol.keyId(descriptor.hostKey))throw new Error('This host identity changed. Ask the owner to check the connection.');
      if(selected&&selected.id!==descriptor.id&&selected.paired){pendingInvitation=raw;record=selected;invitationCode='';}
      else if(previous)record={...previous,descriptor,invite:previous.paired?'':invitationCode};
      else{
        const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
        record={id:descriptor.id,descriptor,privateKey:pair.privateKey,publicKey:protocol.publicKey(await crypto.subtle.exportKey('jwk',pair.publicKey)),invite:invitationCode,paired:false};
      }
      await transaction('readwrite',store=>store.put(record));localStorage.setItem(pointer,record.id);
    }else if(activeId)record=await transaction('readonly',store=>store.get(activeId));
    invitationCode=record?.invite||'';
    if(!record){state({state:'not-paired'});return;}
    api.enabled=true;state({state:'ready'});
    const[,transport,nostr]=await modules;
    client=transport.createPhoneClient({descriptor:record.descriptor,keys:record,nostr,onState:state});
  })();
  const identityChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('nemo.identity.v2'):null;
  const api=window.NemoPhoneLink={enabled:!!raw||!!activeId,state:{state:'loading'},ready,windowId:crypto.randomUUID(),
    get invitationCode(){return invitationCode;},
    get needsSwitch(){return!!pendingInvitation;},
    get invitationText(){if(!record?.invite)return '';return location.origin+'/pair.html#phone='+btoa(JSON.stringify({...record.descriptor,invite:record.invite})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');},
    get needsHomeInstall(){return ios&&!standalone()&&sessionStorage.getItem('nemo.phone.browser-mode')!=='yes';},
    continueInBrowser(){sessionStorage.setItem('nemo.phone.browser-mode','yes');},
    async reconnect(){await ready;if(closed||!client)throw new Error('Open a fresh personal invitation.');client.suspend();return client.connect();},
    async switchToInvitation(){
      await ready;if(!pendingInvitation)throw new Error('Open a fresh personal invitation.');
      const next=pendingInvitation,controller=new AbortController();
      const deadline=setTimeout(()=>controller.abort(),1800);
      try{await Promise.race([client.fetch('/api/logout',{method:'POST',body:'{}',signal:controller.signal}).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);}finally{clearTimeout(deadline);await api.forget();}
      const value=btoa(JSON.stringify(next)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');location.replace('/pair.html#phone='+value);
    },
    async invitationUrl(){await ready;if(!record||!record.invite)throw new Error('Create a new invitation on the host.');const value=btoa(JSON.stringify({...record.descriptor,invite:record.invite})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');return location.origin+'/pair.html#phone='+value;},
    async forget(){closed=true;client?.close();if(db&&record)await transaction('readwrite',store=>store.delete(record.id));for(const name of ['localStorage','sessionStorage'])try{const storage=window[name];for(const key of Object.keys(storage))if(key.startsWith('nemo.'))storage.removeItem(key);}catch{}record=null;invitationCode='';identityChannel?.postMessage({changed:true,transportSource:api.windowId});state({state:'not-paired'});},
  };
  identityChannel?.addEventListener('message',event=>{if(event.data?.transportSource===api.windowId)return;closed=true;client?.close();record=null;document.body.replaceChildren();location.reload();});
  ready.catch(error=>state({state:'unavailable',message:error.message}));
  window.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return nativeFetch(input,options);
    await ready;
    if(!client||closed){if(window.NEMO_PHONE_APP&&!/^\/phone-start(?:\.html)?\/?$/.test(location.pathname))location.replace('/phone-start.html');throw new Error('Open your personal invitation to connect this phone.');}
    const response=await client.fetch(url.pathname+url.search,options);
    const method=String(options.method||'GET').toUpperCase();
    if(url.pathname==='/api/pair'&&method==='POST'&&response.ok){record.paired=true;record.invite='';invitationCode='';await transaction('readwrite',store=>store.put(record));}
    if(url.pathname==='/api/logout'&&response.ok)await api.forget();
    return response;
  };
  window.addEventListener('pagehide',()=>{client?.close();identityChannel?.close();},{once:true});
  // Safari can restore a page whose transport and identity channel were closed
  // on pagehide. Recreate both from current storage rather than reviving a stale
  // person's session or retaining a permanently closed connection.
  window.addEventListener('pageshow',event=>{if(event.persisted){document.body.replaceChildren();location.reload();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)client?.suspend();else if(client&&!closed)void client.connect().catch(()=>{});});
})();
