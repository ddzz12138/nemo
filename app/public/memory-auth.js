let binding;
// Page-local identity pin. Never fall back to a shared/legacy memory session.
export function getProfileMemoryFetch(fetchImpl=window.nemoFetch||window.fetch.bind(window)) {
  if(!binding)binding=(async()=>{
    // Navigation and Memory must share the initial identity read. Competing
    // public session requests can otherwise invalidate each other's epoch.
    const shared=fetchImpl===window.nemoFetch&&typeof window.NemoIdentity?.load==='function';
    const response=shared?null:await fetchImpl('/api/session',{cache:'no-store',credentials:'same-origin'});
    const session=shared?await window.NemoIdentity.load():await response.json();
    const profile=session.profile;
    if((response&&!response.ok)||!session.authenticated||typeof profile?.id!=='string'||!/^[a-f0-9-]{36}$/.test(profile.id))throw new Error('Sign in to your personal Nemo profile on the chat page first.');
    const bound=async(path,options={})=>{
      if(window.NemoIdentity&&window.NemoIdentity.profile?.id!==profile.id)throw new Error('The signed-in profile changed. Reload Memory before continuing.');
      const result=await fetchImpl(path,{...options,headers:{...(options.headers||{}),'X-Nemo-Profile':profile.id}});
      if(window.NemoIdentity&&window.NemoIdentity.profile?.id!==profile.id)throw new Error('The signed-in profile changed. Reload Memory before continuing.');
      if(result.status===409){let data;try{data=await result.clone().json();}catch{}if(data?.code==='PROFILE_CHANGED')throw new Error('The signed-in profile changed. Reload Memory before continuing.');}
      return result;
    };
    bound.profile={id:profile.id,name:profile.name};return bound;
  })();
  return binding;
}
