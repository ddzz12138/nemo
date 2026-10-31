(() => {
  'use strict';
  const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',cursorPattern=new RegExp('^'+uuid+':[0-9]{1,16}$'),idPattern=new RegExp('^'+uuid+'$');
  window.NemoNativeStream={start({onChange=()=>{},onState=()=>{}}={}){
    let closed=false,connected=false,active=null,retryTimer=null,noticeTimer=null,cursor=null,retries=0,epoch=null;
    const state=value=>{connected=value==='connected';onState(value);};
    const notify=()=>{if(noticeTimer||closed||document.hidden)return;noticeTimer=setTimeout(()=>{noticeTimer=null;if(!closed&&!document.hidden)onChange();},80);};
    function change(frame){
      const lines=frame.split('\n');if(!lines.includes('event: change'))return;
      const value=JSON.parse(lines.filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n'));
      if(!value||!cursorPattern.test(value.cursor||'')||Object.keys(value).some(key=>!['cursor','reset','taskId'].includes(key))||!(value.reset===true&&!value.taskId||value.reset===undefined&&idPattern.test(value.taskId||'')))throw new Error('Invalid live update.');
      if(epoch!==window.NemoIdentity?.epoch){close();state('unauthorized');return;}
      if(cursor!==value.cursor||value.reset){cursor=value.cursor;notify();}
    }
    async function connect(){
      if(closed||document.hidden||active)return;const controller=new AbortController();active=controller;
      try{
        const identity=await window.NemoIdentity.load();if(!identity.authenticated)throw Object.assign(new Error('Sign in again.'),{status:401});if(epoch!==null&&epoch!==window.NemoIdentity.epoch)throw Object.assign(new Error('The signed-in profile changed.'),{status:409});epoch=window.NemoIdentity.epoch;
        const response=await window.nemoFetch('/api/native/events'+(cursor?'?'+new URLSearchParams({after:cursor}):''),{headers:{Accept:'text/event-stream'},signal:controller.signal});
        if(!response.ok)throw Object.assign(new Error('Live updates are unavailable.'),{status:response.status});
        if(!response.headers.get('content-type')?.startsWith('text/event-stream')||!response.body)throw new Error('Live updates are unavailable.');
        if(closed||controller.signal.aborted)return;retries=0;state('connected');notify();
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        try{while(!closed&&!controller.signal.aborted){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){change(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);}if(buffer.length>4096)throw new Error('Live update frame was too large.');}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      }catch(error){if(!closed&&!controller.signal.aborted){if([401,409].includes(error.status)){close();cursor=null;state('unauthorized');}else state('reconnecting');}}
      finally{if(active===controller)active=null;connected=false;if(!closed&&!document.hidden){state('reconnecting');retryTimer=setTimeout(connect,Math.min(15000,1000*2**Math.min(retries++,4)));}}
    }
    function visibility(){clearTimeout(retryTimer);if(document.hidden){active?.abort();state('paused');}else{notify();void connect();}}
    function close(){if(closed)return;closed=true;connected=false;active?.abort();clearTimeout(retryTimer);clearTimeout(noticeTimer);cursor=null;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',close);}
    document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',close,{once:true});void connect();return{close,get connected(){return connected;}};
  }};
})();
