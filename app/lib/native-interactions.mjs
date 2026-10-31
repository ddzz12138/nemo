import {createHash} from 'node:crypto';
export const INTERACTION_TOOLS=Object.freeze(['clarify','todo_list']);
const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'NATIVE_INTERACTION'});};
export function nativeQuestions(value){
  if(!Array.isArray(value)||!value.length||value.length>5)fail('Hermes returned an invalid question set.');
  const ids=new Set();let size=0;
  const rows=value.map(row=>{
    if(!row||typeof row!=='object'||!/^q[0-4]$/.test(row.qid)||ids.has(row.qid)||typeof row.question!=='string'||!row.question.trim()||row.question.length>4000||row.multi_select!==undefined&&typeof row.multi_select!=='boolean'||row.choices!==null&&row.choices!==undefined&&(!Array.isArray(row.choices)||row.choices.length>4||row.choices.some(choice=>typeof choice!=='string'||!choice.trim()||choice.length>4000)))fail('Hermes returned an invalid question card.');
    ids.add(row.qid);size+=row.question.length+(row.choices||[]).join('').length;return{qid:row.qid,question:row.question,choices:row.choices||[],multiSelect:row.multi_select===true};
  });if(size>16000)fail('This question card is too large.');return rows;
}
export function nativeAnswers(questions,answers){
  if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).some(key=>!questions.some(question=>question.qid===key))||questions.some(question=>!Object.hasOwn(answers,question.qid)))fail('Answer or skip each displayed question.');
  for(const value of Object.values(answers))if(value!==null&&(typeof value!=='string'||value.length>8000))fail('Use text answers up to 8000 characters.');if(Buffer.byteLength(JSON.stringify(answers))>24000)fail('Keep the combined answers under 24 KB.');return Object.fromEntries(questions.map(question=>[question.qid,answers[question.qid]]));
}
export const answerFingerprint=answers=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(answers).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
export function nativePlan(value){
  if(!value||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.todos)||value.todos.length>256)fail('Hermes returned an invalid task checklist.');
  let size=0;const ids=new Set(),todos=value.todos.map(row=>{if(!row||typeof row.id!=='string'||!row.id||row.id.length>100||ids.has(row.id)||typeof row.content!=='string'||!row.content.trim()||row.content.length>4000||!['pending','in_progress','completed','cancelled'].includes(row.status)||row.parent!==undefined&&(typeof row.parent!=='string'||row.parent.length>100))fail('Hermes returned an invalid checklist item.');ids.add(row.id);size+=row.content.length;return{id:row.id,content:row.content,status:row.status,...(row.parent?{parent:row.parent}:{})};});
  if(size>100000||todos.some(row=>row.parent&&(!ids.has(row.parent)||row.parent===row.id)))fail('Hermes returned an invalid checklist hierarchy.');return{revision:value.revision,todos};
}
