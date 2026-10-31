import { createHash } from 'node:crypto';

export function candidateIdentity({ version, commit, runId, attempt }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '') || !/^\d+$/.test(String(runId || '')) || !/^\d+$/.test(String(attempt || ''))) throw new Error('Invalid immutable candidate identity.');
  return `candidate-v${version}-${commit.slice(0,12)}-${runId}-${attempt}`;
}

/** All mutation is draft-only. Existing assets must match, never be overwritten. */
export async function storeDraftCandidate({ request, repository, identity, commit, assets }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit) || !identity.startsWith('candidate-v') || !Array.isArray(assets) || !assets.length || assets.at(-1).name !== 'candidate.json') throw new Error('Invalid draft candidate.');
  for (const asset of assets) if (!/^[\w.+-]+$/.test(asset.name) || !(asset.bytes instanceof Uint8Array)) throw new Error('Invalid candidate asset.');
  const root=`https://api.github.com/repos/${repository}`;
  const list=()=>request('GET',root+'/releases?per_page=100');
  let release=(await list()).find(item=>item.tag_name===identity);
  const check=value=>{
    if(!value?.draft || value.tag_name!==identity || value.target_commitish!==commit || !Number.isSafeInteger(value.id))throw new Error('Candidate release is published or belongs to another source revision.');
    return value;
  };
  if(!release){
    try{release=await request('POST',root+'/releases',{tag_name:identity,target_commitish:commit,draft:true,prerelease:false,name:identity,body:'Technical candidate only. Upload is complete only when candidate.json is present and all asset hashes match. Clean-PC installation/update and adult acceptance remain pending. Do not publish or hand off yet.'});}
    catch(error){release=(await list()).find(item=>item.tag_name===identity);if(!release)throw error;}
  }
  check(release);
  for(const asset of assets){
    check(await request('GET',root+'/releases/'+release.id));
    const digest='sha256:'+createHash('sha256').update(asset.bytes).digest('hex');
    const existing=(await request('GET',root+'/releases/'+release.id+'/assets?per_page=100')).find(item=>item.name===asset.name);
    if(existing){if(existing.digest!==digest||existing.size!==asset.bytes.byteLength)throw new Error('Existing candidate asset differs; create a new immutable candidate.');continue;}
    const uploaded=await request('POST',`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,asset.bytes);
    if(uploaded.digest!==digest||uploaded.size!==asset.bytes.byteLength)throw new Error('Uploaded candidate checksum or size mismatch.');
  }
  check(await request('GET',root+'/releases/'+release.id));
  return {draft:true,id:release.id,url:release.html_url};
}
