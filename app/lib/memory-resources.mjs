/** Coordinate local inference across profile memories. The pool admits work;
 * it never retries a cancelled inference or sends anything to a cloud service. */
export function scheduleMemoryProcessing({gbrain,reviewer,resources}){
  if(!resources)return reviewer;
  async function run(operation,{foreground=true,signal}={}){const release=await resources.acquire({kind:'gpu',foreground,signal});try{if(signal?.aborted)throw new Error('Memory processing was cancelled.');return await operation();}finally{release();}}
  for(const method of ['search','save','mirrorCopies','indexPending']){
    if(typeof gbrain[method]!=='function')continue;
    const original=gbrain[method].bind(gbrain);
    gbrain[method]=(...args)=>run(()=>original(...args),{foreground:!['mirrorCopies','indexPending'].includes(method)});
  }
  return{model:reviewer.model,review:input=>run(()=>reviewer.review(input),{foreground:false,signal:input?.signal})};
}
