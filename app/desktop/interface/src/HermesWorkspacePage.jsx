import React, {useEffect, useRef, useState} from 'react';
import './hermes-workspace.css';

const choiceLabels={once:'Allow once',session:'Allow for this session',always:'Always allow',deny:'Deny'};
const stateLabels={stopped:'Stopped',preparing:'Preparing browser and computer tools…',starting:'Opening Hermes…',ready:'Ready',running:'Hermes is working…',waiting:'Waiting for your answer',error:'Needs attention'};
const preparationLabels={prepare:'Preparing',download:'Downloading',unpack:'Unpacking',verify:'Checking',ready:'Ready'};
const packageLabels={'agent-browser':'browser tools',chromium:'browser','cua-driver':'computer tools'};

function HermesRequest({request,busy,onRespond}) {
  const [value,setValue]=useState(''),[answers,setAnswers]=useState({});
  const {method,params}=request;
  function answerQuestion(qid,value){setAnswers(current=>({...current,[qid]:value}));}
  async function submit(event){event.preventDefault();const result=method==='clarify'?{answers:Object.fromEntries((params.questions||[]).map(question=>[question.qid,Array.isArray(answers[question.qid])?answers[question.qid].join(', '):answers[question.qid]||null]))}:{value};setValue('');await onRespond(request.id,result);}
  return <section className="hermes-request" aria-label={method==='approval'?'Hermes approval':method==='clarify'?'Hermes question':method==='sudo'?'Hermes password request':'Hermes secret request'}>
    <h3>{method==='approval'?'Hermes needs your approval':method==='clarify'?'Hermes has a question':method==='sudo'?'Hermes needs a password':'Hermes needs a secret'}</h3>
    {params.description&&<p>{params.description}</p>}
    {params.command&&<pre>{params.command}</pre>}
    {method==='approval'?<><p className="quiet">Choose the permission Hermes should use for this action.</p><div className="hermes-actions">{params.choices.map(choice=><button key={choice} type="button" className={choice==='deny'?'text-button':'app-button'} disabled={busy} onClick={()=>void onRespond(request.id,{choice})}>{choiceLabels[choice]}</button>)}</div></>:
      <form onSubmit={event=>void submit(event)}>
        {method==='clarify'?(params.questions||[]).map(question=><fieldset key={question.qid}><legend>{question.question}</legend>{question.choices?.length?question.multi_select?<div className="hermes-question-choices">{question.choices.map(choice=><label key={choice}><input type="checkbox" checked={(answers[question.qid]||[]).includes(choice)} onChange={event=>{const prior=answers[question.qid]||[];answerQuestion(question.qid,event.target.checked?[...prior,choice]:prior.filter(item=>item!==choice));}}/>{choice}</label>)}</div>:<select aria-label={question.question} value={answers[question.qid]||''} onChange={event=>answerQuestion(question.qid,event.target.value)}><option value="">Choose an answer</option>{question.choices.map(choice=><option key={choice} value={choice}>{choice}</option>)}</select>:<textarea aria-label={question.question} value={answers[question.qid]||''} maxLength={8000} onChange={event=>answerQuestion(question.qid,event.target.value)}/>}</fieldset>):<label className="hermes-secret-field">{params.prompt|| (method==='sudo'?'Password for the command above':params.env_var||'Secret requested by Hermes')}<input type="password" autoComplete="off" spellCheck={false} value={value} maxLength={16000} onChange={event=>setValue(event.target.value)}/><small>Sent directly to this Hermes request. The value is not kept in Nemo’s conversation display.</small></label>}
        <div className="hermes-actions"><button type="submit" className="app-button" disabled={busy}>Send answer</button><button type="button" className="text-button" disabled={busy} onClick={()=>{setValue('');void onRespond(request.id,method==='clarify'?{answers:{}}:{value:''});}}>Skip</button></div>
      </form>}
  </section>;
}

export function HermesWorkspacePage({api,session,onError=()=>{}}) {
  const [snapshot,setSnapshot]=useState(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const active=useRef(false),person=useRef(session.profile.id),revision=useRef(0),lock=useRef(false);
  person.current=session.profile.id;
  const allowed=session.profile.role==='owner'&&session.profile.childMode!==true&&!['child','unclassified'].includes(session.profile.classification);
  async function load(){const ticket=++revision.current,id=person.current;const value=await api.hermesWorkspaceStatus();if(active.current&&id===person.current&&ticket===revision.current)setSnapshot(value);}
  useEffect(()=>{
    active.current=true;setSnapshot(null);setNotice('');setMessage('');setBusy(false);lock.current=false;
    const id=person.current;const reload=()=>{if(!allowed||!active.current||lock.current||document.hidden)return;void load().catch(problem=>{if(active.current&&id===person.current){setNotice(problem.message||'Hermes workspace could not be loaded.');if([401,403,409].includes(problem.status))onError(problem);}});};
    reload();const timer=setInterval(reload,1000);window.addEventListener('focus',reload);document.addEventListener('visibilitychange',reload);
    return()=>{active.current=false;revision.current++;clearInterval(timer);window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload);};
  },[session.profile.id,allowed]);
  async function act(operation,interrupt=false){
    if(lock.current&&!interrupt)return;lock.current=true;const ticket=++revision.current,id=person.current;setBusy(true);setNotice('');
    try{const value=await operation();if(active.current&&id===person.current&&ticket===revision.current){setSnapshot(value);return true;}}
    catch(problem){if(active.current&&id===person.current&&ticket===revision.current){setNotice(problem.message||'Hermes could not finish this step.');if([401,403].includes(problem.status))onError(problem);}}
    finally{if(active.current&&id===person.current&&ticket===revision.current){lock.current=false;setBusy(false);}}
    return false;
  }
  async function send(event){event.preventDefault();const draft=message;if(!draft.trim())return;const sent=await act(()=>api.hermesWorkspacePrompt({message:draft}));if(sent)setMessage('');}
  if(!allowed)return <section className="settings-page hermes-workspace"><h2>Hermes workspace</h2><p>This workspace is available to the owner on the home PC.</p></section>;
  const phase=snapshot?.phase||'stopped',ready=phase==='ready',open=snapshot?.busy===true,info=snapshot?.readiness;
  return <section className="settings-page hermes-workspace">
    <div className="settings-intro"><h2>Hermes workspace</h2><p>Hermes’s own skills and tools, inside Nemo.</p></div>
    <div className="hermes-workspace-intro"><p>This workspace runs with your owner account’s access to this PC. Hermes handles its own tools and asks for approval when needed.</p><p className="quiet">Source preview · For the owner on this PC. Family and child chats keep their existing permissions. Relevant context is sent to ChatGPT.</p></div>
    <div className="hermes-workspace-toolbar"><p role="status">{stateLabels[phase]||'Checking Hermes…'}</p><div className="hermes-actions">{!open&&<><button className="app-button" disabled={busy||!snapshot} onClick={()=>void act(()=>api.hermesWorkspaceStart())}>{phase==='error'?'Try opening Hermes again':'Open Hermes workspace'}</button><button className="app-button" disabled={busy||!snapshot||!snapshot.runtimeConfigured} onClick={()=>void act(()=>api.hermesWorkspacePrepare())}>Prepare browser and computer tools</button></>}{(open||phase==='starting')&&<button className="app-button" onClick={()=>void act(()=>api.hermesWorkspaceStop(),true)}>Stop Hermes</button>}<button className="text-button" disabled={busy} onClick={()=>void load().catch(problem=>setNotice(problem.message))}>Refresh</button></div></div>
    {(notice||snapshot?.message)&&<p role="alert" className="inline-error">{notice||snapshot.message}</p>}
    {open&&<p className="hermes-workspace-memory-note">Stop Hermes to return to regular chat or edit Memory. Both use your same private Hermes memory.</p>}
    {snapshot?.preparation&&<div className="hermes-preparation" role="status">{snapshot.preparation.phase==='preparing'?<><strong>Hermes is preparing its browser and computer tools.</strong><p>{snapshot.preparation.progress?`${preparationLabels[snapshot.preparation.progress.stage]||'Preparing'} ${packageLabels[snapshot.preparation.progress.package]||'tools'}`:'Checking the software this PC needs…'}</p><p className="quiet">The first setup downloads the software Hermes needs. You can stop it at any time.</p></>:snapshot.preparation.phase==='complete'?<><strong>Browser and computer software is prepared.</strong><p>Open Hermes workspace to check its available tools. No chat or task has started.</p></>:snapshot.preparation.phase==='cancelled'?<p>Tool setup stopped. It will continue only when you choose Prepare again.</p>:snapshot.preparation.tools?<><strong>Some tools still need attention.</strong>{Object.entries(snapshot.preparation.tools).map(([name,tool])=><p key={name}>{name==='browser'?'Browser':'Computer'}: {tool.available?'Ready':tool.message||'Not available on this PC.'}</p>)}</>:<p>Tool setup did not finish. Check your connection and try Prepare again.</p>}</div>}
    <details className="hermes-readiness"><summary>Skills and tools reported by Hermes</summary>{info?.checked?<><h3>Available tools</h3>{info.toolsets?.map(group=><div key={group.name}><strong>{group.name}</strong><p>{group.items.join(', ')}</p></div>)}<h3>Available skills</h3>{info.skills?.length?info.skills.map(group=><div key={group.name}><strong>{group.name}</strong><p>{group.items.join(', ')}</p></div>):<p>Hermes has not reported any available skills.</p>}</>:<p>Hermes reports availability after its session loads. Tools that need extra software, an account or a supported operating system may be unavailable.</p>}</details>
    <div className="hermes-workspace-messages" aria-label="Hermes workspace conversation">{!snapshot?.messages?.length?<p className="quiet">Open Hermes and ask it to show its available skills, research a topic or work on a file.</p>:snapshot.messages.map(row=><article key={row.id} className={'hermes-workspace-message '+row.role}><strong>{row.role==='user'?'You':'Hermes'}</strong><p>{row.content}</p></article>)}</div>
    {(snapshot?.requests||[]).map(request=><HermesRequest key={request.id} request={request} busy={busy} onRespond={(id,result)=>act(()=>api.hermesWorkspaceRespond({id,result}))}/>)}
    <form className="hermes-workspace-composer" onSubmit={event=>void send(event)}><label htmlFor="hermes-workspace-message">Message Hermes</label><textarea id="hermes-workspace-message" placeholder={ready?'What would you like Hermes to do?':'Open Hermes workspace to begin'} value={message} maxLength={32000} disabled={!ready||busy} onChange={event=>setMessage(event.target.value)}/><button type="submit" className="app-button" disabled={!ready||busy||!message.trim()}>Send to Hermes</button></form>
    {!!snapshot?.events?.length&&<details className="hermes-workspace-activity"><summary>Tool and agent activity</summary><ol>{snapshot.events.map(event=><li key={event.id}><span>{event.name||event.type}</span>{event.name&&<small>{event.type}</small>}{event.state&&<small>{event.state}</small>}</li>)}</ol></details>}
    <p className="quiet">Hermes keeps this workspace’s conversation on this PC. Stopping does not repeat an action; opening it again restores the saved conversation.</p>
  </section>;
}
