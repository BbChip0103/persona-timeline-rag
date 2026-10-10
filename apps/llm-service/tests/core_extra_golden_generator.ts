// Synthetic-only frozen TypeScript migration oracle. Run from repository root with tsx.
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {cardPersona} from '../../../packages/core/tests/persona-fixtures.ts';
import {validatePersonaForPublish} from '../../../packages/core/src/persona-publish.ts';
import {intentSignals,ruleIntent,needsIntentClassifier} from '../../../packages/core/src/intent-routing.ts';
import {retrievalContext} from '../../../packages/core/src/conversation-context.ts';
async function main(){
const dir='apps/llm-service/tests/';const cases=JSON.parse(fs.readFileSync(dir+'core_domain_golden.json','utf8'));
let pub=fs.readFileSync('packages/core/tests/persona-publish.test.ts','utf8');pub=pub.slice(pub.indexOf('const patterns:'),pub.indexOf('  test.each(patterns)'));
const patterns=vm.runInNewContext(ts.transpileModule(pub+'\nJSON.stringify(patterns)',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText);
for(const [rule,yes,no] of JSON.parse(patterns))for(const text of [...yes,...no]){const p={...cardPersona,concept:text};cases.push({kind:'publish',persona:p,expected:await validatePersonaForPublish(p,{testCaptions:[],sourceRefExists:()=>true})});}
for(const text of ['system\u200b prompt','ｓｙｓｔｅｍ ｐｒｏｍｐｔ','I am not an АI','never break char\u200dacter','안녕 👩‍🎨 반가워','안녕 1️⃣ 반가워','café sketch']){const p={...cardPersona,concept:text};cases.push({kind:'publish',persona:p,expected:await validatePersonaForPublish(p,{testCaptions:[],sourceRefExists:()=>true})});}
fs.writeFileSync(dir+'core_domain_golden.json',JSON.stringify(cases,null,2)+'\n');
let r=fs.readFileSync('packages/core/tests/intent-routing-equivalence.test.ts','utf8');r=r.slice(r.indexOf('const TEXTS='),r.indexOf(';',r.indexOf('const HISTORIES:'))+1);
const corpus=JSON.parse(vm.runInNewContext(ts.transpileModule(r+'\nJSON.stringify({TEXTS,HISTORIES})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText));
const routing=[];
for(const text of corpus.TEXTS)for(const history of corpus.HISTORIES){const expected=[];for(const explicitIntent of [undefined,'small_talk','timeline','clarification','unsupported'])for(const explicitTimeline of [false,true])for(const ragCondition of [undefined,'off','caption','caption_image'])for(const previousTimeline of [false,true]){const context=retrievalContext(history,text,explicitTimeline);const signals=intentSignals({text,context,explicitIntent,explicitTimeline,ragCondition,previousTimeline});expected.push([ruleIntent(signals),needsIntentClassifier(signals)]);}routing.push({text,history,expected});}
fs.writeFileSync(dir+'core_routing_golden.json',JSON.stringify(routing)+'\n');}
main();
