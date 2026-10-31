(() => {
  'use strict';
  const drafts=new Map(),node=(tag,text,className)=>{const value=document.createElement(tag);value.textContent=text;if(className)value.className=className;return value;};
  function renderPlan(card,plan){if(!plan?.todos?.length)return;const panel=node('details','','native-plan'),done=plan.todos.filter(item=>item.status==='completed').length;panel.append(node('summary',`Plan · ${done} of ${plan.todos.length} complete`));const list=node('ol','');for(const item of plan.todos){const row=node('li','');row.dataset.state=item.status;row.append(node('span',item.status==='completed'?'✓':item.status==='in_progress'?'●':item.status==='cancelled'?'−':'○','plan-marker'),node('span',item.content));list.append(row);}panel.append(list);card.append(panel);}
  function renderQuestion(card,task,onAnswer){
    const question=task.question;if(!question)return;
    if(question.state!=='pending'){
      const panel=node('details','','native-question saved-question');panel.append(node('summary',question.state==='answered'?'Your answers':question.state==='expired'?'Question expired':'Question closed'));
      for(const row of question.questions){panel.append(node('p',row.question));if(question.state==='answered')panel.append(node('p',question.answers?.[row.qid]||'Skipped','question-answer'));}card.append(panel);drafts.delete(question.id);return;
    }
    const form=node('form','','native-question'),title=node('h3','A quick question.'),notice=node('p','You have five minutes to answer. Waiting does not use the task’s active time.','integration-detail');form.append(title,notice);
    const saved=drafts.get(question.id)||{};drafts.set(question.id,saved);const fields=[];
    for(const row of question.questions){
      const field=node('fieldset',''),legend=node('legend',row.question),prefix='answer-'+question.id+'-'+row.qid,current=saved[row.qid]||{chosen:[],text:'',skip:false};saved[row.qid]=current;field.append(legend);
      const choices=[];for(let index=0;index<row.choices.length;index++){const label=node('label','','native-choice'),choice=node('input','');choice.type=row.multiSelect?'checkbox':'radio';choice.name=prefix;choice.value=String(index);choice.checked=current.chosen.includes(index);choice.addEventListener('change',()=>{current.chosen=row.multiSelect?choices.filter(input=>input.checked).map(input=>Number(input.value)):[index];});choices.push(choice);label.append(choice,node('span',row.choices[index]));field.append(label);}
      const textLabel=node('label',row.choices.length?'Or write your answer':'Your answer'),text=node('textarea','');text.id=prefix+'-text';text.rows=2;text.maxLength=8000;text.value=current.text;textLabel.htmlFor=text.id;text.addEventListener('input',()=>{current.text=text.value;});field.append(textLabel,text);
      const skipLabel=node('label','','native-choice'),skip=node('input','');skip.type='checkbox';skip.checked=current.skip;skip.addEventListener('change',()=>{current.skip=skip.checked;});skipLabel.append(skip,node('span','Skip this question'));field.append(skipLabel);fields.push({row,current});form.append(field);
    }
    const result=node('p','','profile-status');result.setAttribute('role','status');const submit=node('button','Send answers');submit.type='submit';form.append(result,submit);
    form.addEventListener('submit',async event=>{event.preventDefault();const answers={};for(const{row,current}of fields){if(current.skip){answers[row.qid]=null;continue;}const selected=current.chosen.map(index=>row.choices[index]),text=current.text.trim();if(!selected.length&&!text){result.textContent='Answer or skip each question before continuing.';return;}answers[row.qid]=row.multiSelect?JSON.stringify([...selected,...(text?[text]:[])]):text||selected[0];}submit.disabled=true;try{await onAnswer(task.id,{questionId:question.id,answers});drafts.delete(question.id);result.textContent='Answer received. Hermes can continue.';}catch(error){result.textContent=error.message;submit.disabled=false;}});card.append(form);
  }
  window.NemoNativeInteractions={render(card,task,{onAnswer}={}){renderPlan(card,task.plan);for(const question of task.questionHistory||[])renderQuestion(card,{...task,question},onAnswer);if(task.question)renderQuestion(card,task,onAnswer||(async()=>{throw new Error('Open this task in chat to answer.');}));},clear(){drafts.clear();}};
})();
