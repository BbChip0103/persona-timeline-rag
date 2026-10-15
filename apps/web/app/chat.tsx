'use client';
import { useEffect, useRef, useState } from 'react';
import { turnNotice } from '../lib/turn-notice';
import { subscribeTurnStream } from '../lib/turn-stream';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearOwnerQueries } from '../lib/query-client';
import { requestApi } from '../lib/api';
import { draftAttemptFor, type DraftAttempt } from '../lib/draft-attempt';
import { splitReplyBubbles } from '../lib/reply-bubbles';
import { friendlyError } from '../lib/friendly-error';
import { voiceText } from '../../../packages/core/src/reply-texts';
import { browserTimezone } from '../lib/browser-timezone';

type Mode='off'|'lexical'|'semantic';
type RagCondition='off'|'caption'|'caption_image';
type Persona={id:string;personId:string;label:string;tagline?:string;starters?:string[];language:string;revision:string;reviewStatus?:string;aiDisclosure:string};
type Session={id:string;personId:string;personaRevision:string;language?:string;userMemoryConsent?:boolean;retrievalMode:Mode;ragCondition?:RagCondition;createdAt:string};
type Message={id:string;turnId:string|null;role:'user'|'assistant';content:string};
type Turn={id:string;sessionId:string;userText:string;state:string;errorCode?:string};
type Attempt={clientRequestId:string;text:string;timeline?:{query?:string;start?:string;end?:string;dateBasis:'posted'|'event';limit:number}};
const terminal=(state:string)=>['completed','failed','cancelled'].includes(state);
const conditionLabel:Record<RagCondition,string>={off:'RAG 없음',caption:'본문만',caption_image:'본문 + 이미지 설명'};
const sessionLabel=(session:Session)=>session.ragCondition?`${conditionLabel[session.ragCondition]}${session.ragCondition==='off'?'':` · ${session.retrievalMode}`}`:`기존 세션 · ${modeLabel[session.retrievalMode]}`;
const modeLabel:Record<Mode,string>={off:'RAG off · 검색 없음',lexical:'Lexical · 캡션 검색',semantic:'Semantic · 임베딩 검색'};
const canResend=(turn:Turn)=>turn.state==='failed'&&!['PROVIDER_REQUEST_UNRESOLVED','CONTEXT_LIMIT'].includes(turn.errorCode??'');
const canRefill=(turn:Turn)=>turn.state==='failed'&&turn.errorCode!=='PROVIDER_REQUEST_UNRESOLVED';
const english=(language?:string)=>Boolean(language&&/^en(?:$|[-_])/i.test(language));
const nameParticle=(name:string)=>{const last=[...name.trim()].at(-1)??'';const code=last.codePointAt(0)??0;return last&&/[0-9]/u.test(last)?(/[013678]/u.test(last)?'이':'가'):code>=0xac00&&code<=0xd7a3&&(code-0xac00)%28!==0?'이':'가';};
const oldGreetingPrefix=/^AI 연구용 시뮬레이션입니다\. |^AI research simulation\. /u;
export default function Chat({ownerScope}:{ownerScope:string}) {
  const client=useQueryClient();
  const ownerEpoch=useRef(0);const viewEpoch=useRef(0);const [ownerActive,setOwnerActive]=useState(true);
  const mounted=useRef(true);const sessionRef=useRef<string|undefined>(undefined);const streamController=useRef<AbortController|undefined>(undefined);
  const onUnauthorized=()=>{invalidateOwner();void clearOwnerQueries(client);window.location.assign('/login');};
  const api=<T,>(path:string,body?:unknown,signal?:AbortSignal)=>requestApi<T>(path,body,signal,onUnauthorized);
  const people=useQuery({queryKey:['personas'],enabled:ownerActive,queryFn:({signal})=>api<{personas:Persona[];operatorMode:boolean;operatorNotice?:string}>('personas',undefined,signal)});
  const stored=useQuery({queryKey:['sessions'],enabled:ownerActive,queryFn:({signal})=>api<{sessions:Session[]}>('sessions',undefined,signal)});
  const personas=ownerActive?(people.data?.personas??[]):[];const sessions=ownerActive?(stored.data?.sessions??[]):[];const operatorMode=ownerActive&&people.data?.operatorMode===true;
  const [personId,setPersonId]=useState('');const [mode,setMode]=useState<Mode>('lexical');const [condition,setCondition]=useState<RagCondition>('caption');
  const [sessionId,setSessionId]=useState<string>();const [activeId,setActiveId]=useState<string>();
  const sessionQuery=useQuery({queryKey:['session',sessionId],enabled:ownerActive&&Boolean(sessionId),queryFn:({signal})=>api<{session:Session;history:Message[]}>(`sessions/${sessionId}`,undefined,signal)});
  const session=ownerActive?sessionQuery.data?.session:undefined;const history=ownerActive?(sessionQuery.data?.history??[]):[];
  const memoryQuery=useQuery({queryKey:['memories',sessionId],enabled:ownerActive&&Boolean(sessionId),queryFn:({signal})=>api<{memories:{id:string;kind:string;text:string}[]}>(`sessions/${sessionId}/memories`,undefined,signal)});
  const [memoryBusy,setMemoryBusy]=useState(false);
  const activeQuery=useQuery({queryKey:['turn',activeId],enabled:false,queryFn:({signal})=>api<{turn:Turn}>(`turns/${activeId}`,undefined,signal)});
  const active=ownerActive?activeQuery.data?.turn:undefined;
  const setActive=(turn:Turn|undefined)=>{if(turn){client.setQueryData(['turn',turn.id],{turn});setActiveId(turn.id);}else setActiveId(undefined);};
  const [text,setText]=useState('');const [intent,setIntent]=useState<'small_talk'|'timeline'>('small_talk');const [query,setQuery]=useState('');const [basis,setBasis]=useState<'posted'|'event'>('posted');const [start,setStart]=useState('');const [end,setEnd]=useState('');
  const [selectBusy,setSelectBusy]=useState(false);const [attempt,setAttempt]=useState<Attempt>();const [failedAttempt,setFailedAttempt]=useState<Attempt>();const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [brief,setBrief]=useState('');
  const [disclosureFor,setDisclosureFor]=useState<string>();const [returning,setReturning]=useState(false);const [reentryPreview,setReentryPreview]=useState<string>();
  const draftAttempt=useRef<DraftAttempt|undefined>(undefined);
  const languageRef=useRef<string|undefined>(undefined);const bottom=useRef<HTMLDivElement>(null);const restored=useRef(false);
  const submitMutation=useMutation({mutationFn:({id,value}:{id:string;value:Attempt})=>api<{turn:Turn}>(`sessions/${id}/turns`,value)});
  const sessionMutation=useMutation({mutationFn:(body:unknown)=>api<{session:Session}>('sessions',body)});
  const cancelMutation=useMutation({mutationFn:(id:string)=>api(`turns/${id}/cancel`,{})});
  const draftMutation=useMutation({mutationFn:(value:DraftAttempt)=>api<{artifact?:{content:string};notice?:{content:string};image:{code:string}}>(`sessions/${value.sessionId}/drafts`,{brief:value.brief,clientRequestId:value.clientRequestId})});
  const busy=memoryBusy||!ownerActive||selectBusy||sessionQuery.isFetching||submitMutation.isPending||sessionMutation.isPending;
  const draftBusy=draftMutation.isPending;const draft=ownerActive?(draftMutation.data?.artifact?.content??draftMutation.data?.notice?.content??''):'';
  function invalidateOwner() {
    ownerEpoch.current++;viewEpoch.current++;sessionRef.current=undefined;streamController.current?.abort();setOwnerActive(false);setSessionId(undefined);setActiveId(undefined);setAttempt(undefined);setFailedAttempt(undefined);setError('');setNotice('');setText('');setBrief('');setQuery('');setStart('');setEnd('');setPersonId('');setReturning(false);setReentryPreview(undefined);setDisclosureFor(undefined);
    submitMutation.reset();sessionMutation.reset();cancelMutation.reset();draftMutation.reset();draftAttempt.current=undefined;
  }
  const currentView=(owner:number,view:number,id?:string)=>mounted.current&&ownerActive&&ownerEpoch.current===owner&&viewEpoch.current===view&&(id===undefined||sessionRef.current===id);

  async function updateMemory(action:'consent'|'one'|'all'|'session',enabled?:boolean,memoryId?:string) {
    if(!session||memoryBusy)return;
    const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;
    if(action==='session'&&!window.confirm(english(session.language??selected?.language)?'Delete this chat and its memories?':'대화와 이 대화에서 저장한 기억을 삭제할까요?'))return;
    setMemoryBusy(true);setError('');
    try {
      if(action==='consent') {
        await api(`sessions/${id}/memory-consent`,{enabled});
        if(currentView(owner,view,id))client.setQueryData<{session:Session;history:Message[]}>(['session',id],previous=>previous?{...previous,session:{...previous.session,userMemoryConsent:enabled}}:previous);
      } else {
        const path=action==='session'?`sessions/${id}`:`sessions/${id}/memories${action==='one'?`/${memoryId}`:''}`;
        await requestApi(path,undefined,undefined,onUnauthorized,'DELETE');
      }
      if(!currentView(owner,view,id))return;
      if(action==='session') {
        streamController.current?.abort();viewEpoch.current++;sessionRef.current=undefined;setSessionId(undefined);setActive(undefined);setAttempt(undefined);setFailedAttempt(undefined);setText('');setNotice('');setReturning(false);setReentryPreview(undefined);setBrief('');draftMutation.reset();draftAttempt.current=undefined;
        localStorage.removeItem('ptr-session-id');localStorage.removeItem(`ptr-active-turn-${id}`);
        client.removeQueries({queryKey:['session',id],exact:true});client.removeQueries({queryKey:['memories',id],exact:true});
        client.setQueryData<{sessions:Session[]}>(['sessions'],previous=>({sessions:(previous?.sessions??[]).filter(item=>item.id!==id)}));
      } else await client.invalidateQueries({queryKey:['memories',id],exact:true});
    }catch(e){if(currentView(owner,view,id))setError((e as Error).message);}
    finally{if(mounted.current&&ownerEpoch.current===owner)setMemoryBusy(false);}
  }
  async function refreshHistory(id:string) {
    const owner=ownerEpoch.current;const view=viewEpoch.current;if(!currentView(owner,view,id))return;
    await client.invalidateQueries({queryKey:['session',id],exact:true,refetchType:'none'});
    if(!currentView(owner,view,id))return;
    const value=await client.fetchQuery({queryKey:['session',id],queryFn:({signal})=>api<{session:Session;history:Message[]}>(`sessions/${id}`,undefined,signal)});
    if(currentView(owner,view,id)){languageRef.current=value.session.language;void client.invalidateQueries({queryKey:['memories',id],exact:true});}
    return value;
  }
  async function selectSession(id:string,reentry=true) {
    const owner=ownerEpoch.current;const view=++viewEpoch.current;sessionRef.current=id;setSessionId(id);setActive(undefined);setAttempt(undefined);setFailedAttempt(undefined);setError('');setNotice('');draftMutation.reset();draftAttempt.current=undefined;setSelectBusy(true);
    try {const loaded=await refreshHistory(id);if(!currentView(owner,view,id))return;const last=loaded?.history.at(-1);setReentryPreview(reentry&&last?(last.turnId===null?last.content.replace(oldGreetingPrefix,''):last.content):undefined);setReturning(reentry);localStorage.setItem('ptr-session-id',id);
      const recovered=localStorage.getItem(`ptr-active-turn-${id}`);
      if(recovered){const value=await client.fetchQuery({queryKey:['turn',recovered],queryFn:({signal})=>api<{turn:Turn}>(`turns/${recovered}`,undefined,signal)}).catch(()=>undefined);
        if(!currentView(owner,view,id))return;if(value&&!terminal(value.turn.state))setActive(value.turn);else {if(value){setNotice(turnNotice(value.turn,languageRef.current));if(value.turn.state==='failed'){if(canRefill(value.turn))setText(value.turn.userText);if(canResend(value.turn))setFailedAttempt({clientRequestId:'',text:value.turn.userText});}}localStorage.removeItem(`ptr-active-turn-${id}`);}}
    }catch(e){if(currentView(owner,view,id)){setError((e as Error).message);sessionRef.current=undefined;setSessionId(undefined);}}
    finally{if(mounted.current&&ownerEpoch.current===owner&&viewEpoch.current===view)setSelectBusy(false);}
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;streamController.current?.abort();};},[]);
  useEffect(()=>{
    if(!ownerActive||restored.current||!people.data||!stored.data)return;restored.current=true;setPersonId(people.data.personas[0]?.personId??'');
    const saved=localStorage.getItem('ptr-session-id');const chosen=stored.data.sessions.find(value=>value.id===saved);
    if(chosen){setPersonId(chosen.personId);setMode(chosen.retrievalMode==='off'?'lexical':chosen.retrievalMode);setCondition(chosen.ragCondition??'caption');void selectSession(chosen.id);}
  },[ownerActive,people.data,stored.data]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'auto',block:'nearest'});},[history.length,active?.state]);
  useEffect(()=>{
    if(!active||terminal(active.state))return;
    const owner=ownerEpoch.current;const view=viewEpoch.current;const controller=new AbortController();streamController.current=controller;let settling=false;
    const current=()=>!controller.signal.aborted&&currentView(owner,view,active.sessionId);
    const settle=async(turn:Turn)=>{
      if(settling||!current())return;settling=true;client.setQueryData(['turn',turn.id],{turn});setNotice(turnNotice(turn,languageRef.current));
      if(turn.state==='failed'){if(canRefill(turn))setText(turn.userText);if(canResend(turn))setFailedAttempt(attempt?.text===turn.userText?attempt:{clientRequestId:'',text:turn.userText});}
      try{await refreshHistory(turn.sessionId);}
      catch(e){if(current())setError((e as Error).message);}
      finally{if(current()){localStorage.removeItem(`ptr-active-turn-${turn.sessionId}`);setActive(undefined);setAttempt(undefined);}}
    };
    void subscribeTurnStream({turnId:active.id,signal:controller.signal,onUnauthorized,
      readStatus:async signal=>{const value=await requestApi<{turn:Turn}>(`turns/${active.id}`,undefined,signal);return terminal(value.turn.state)?{event:'turn',data:value.turn}:undefined;},
      onDelay:()=>{if(current())setNotice(/^ko(?:$|[-_])/i.test(languageRef.current??'ko')?'연결이 잠깐 느려졌어. 답장을 확인하고 있어!':'The connection is slow. I’m checking for your reply!');},
      onFrame:frame=>{
        if(!current())return true;
        if(frame.event==='turn'){const turn=frame.data as Turn;if(terminal(turn.state)){void settle(turn);return true;}setActive(turn);}
        else if(frame.event==='state'){const state=(frame.data as {state?:string}).state;if(state)client.setQueryData<{turn:Turn}>(['turn',active.id],previous=>previous?{turn:{...previous.turn,state}}:previous);}
        return false;
      },
    }).catch(e=>{if(current())setError((e as Error).message);});
    return()=>{controller.abort();if(streamController.current===controller)streamController.current=undefined;};
  },[active?.id]);
  async function submit(value:Attempt) {
    if(!session)return;const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;setReturning(false);setReentryPreview(undefined);setError('');setNotice('');setFailedAttempt(undefined);setAttempt(value);
    try {const result=await submitMutation.mutateAsync({id,value});if(!currentView(owner,view,id))return;
      if(terminal(result.turn.state)){
        // A known terminal response is settled even if its subsequent history GET fails. Never offer POST recovery.
        client.setQueryData(['turn',result.turn.id],{turn:result.turn});setAttempt(undefined);setText(canRefill(result.turn)?result.turn.userText:'');setNotice(turnNotice(result.turn,languageRef.current));
        if(canResend(result.turn))setFailedAttempt(value);
        await refreshHistory(id);if(!currentView(owner,view,id))return;
      }
      else {localStorage.setItem(`ptr-active-turn-${result.turn.sessionId}`,result.turn.id);setActive(result.turn);}
      if(result.turn.state!=='failed')setText('');
    }catch(e){if(currentView(owner,view,id))setError((e as Error).message);}
  }
  // Disabled observers may retain their last result after cache.clear(); never render another owner epoch's data.
  const visibleError=ownerActive?(error||(people.error as Error|undefined)?.message||(stored.error as Error|undefined)?.message||(sessionQuery.error as Error|undefined)?.message||''):'';
  const selected=personas.find(persona=>persona.personId===(session?.personId??personId));
  const disclosureKey=selected&&(!sessionId||session?.personId===personId)
    ?`ptr-ai-disclosed:${ownerScope}:${selected.id}`:undefined;
  const showFirstDisclosure=Boolean(disclosureKey&&disclosureFor===disclosureKey);
  useEffect(()=>{setDisclosureFor(disclosureKey&&localStorage.getItem(disclosureKey)!=='1'?disclosureKey:undefined);},[disclosureKey]);
  useEffect(()=>{if(showFirstDisclosure&&disclosureKey)localStorage.setItem(disclosureKey,'1');},[showFirstDisclosure,disclosureKey]);
  const lastAssistant=[...history].reverse().find(message=>message.role==='assistant')?.content??'';
  const reentryLevel=/(?:요|니다|세요|까요)[.!?~…\s]*$/u.test(lastAssistant)?'polite':'casual';
  const pendingUser=active&&!history.some(message=>message.turnId===active.id&&message.role==='user');
  return <div className="workspace"><header className="topbar"><div><h1>{selected?.label??'대화 공간'}</h1></div><span className="ai-tag" data-testid="ai-marker">{selected?.aiDisclosure??'AI 캐릭터'}</span><button className="quiet" onClick={async()=>{invalidateOwner();await clearOwnerQueries(client);await fetch('/api/auth',{method:'DELETE'});window.location.assign('/login');}}>로그아웃</button></header>
    <div className="workspace-body"><aside className="sidebar"><h2>대화 공간</h2>
      <label htmlFor="persona">캐릭터</label><select id="persona" value={personId} onChange={event=>setPersonId(event.target.value)} disabled={busy||draftBusy||Boolean(active)}>{personas.map(persona=><option key={persona.id} value={persona.personId}>{persona.label}</option>)}</select>
      {operatorMode&&<section className="operator-controls" aria-label="운영자 설정">{people.data?.operatorNotice&&<p role="status" data-testid="operator-notice">{people.data.operatorNotice}</p>}<label htmlFor="rag-condition">새 세션의 RAG 조건</label><select id="rag-condition" value={condition} onChange={event=>setCondition(event.target.value as RagCondition)} disabled={busy||draftBusy||Boolean(active)}>{Object.entries(conditionLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      {condition!=='off'&&<><label htmlFor="mode">검색 알고리즘</label><select id="mode" value={mode} onChange={event=>setMode(event.target.value as Mode)} disabled={busy||draftBusy||Boolean(active)}><option value="lexical">Lexical</option><option value="semantic">Semantic</option></select></>}</section>}
      <button disabled={!personId||busy||draftBusy||Boolean(active)} onClick={async()=>{const owner=ownerEpoch.current;const view=viewEpoch.current;setError('');try{const value=await sessionMutation.mutateAsync({personId,ragCondition:operatorMode?condition:'caption',retrievalMode:operatorMode?(condition==='off'?'off':mode):'lexical',timezone:browserTimezone()});if(!currentView(owner,view))return;client.setQueryData<{sessions:Session[]}>(['sessions'],previous=>({sessions:[value.session,...(previous?.sessions??[])]}));await selectSession(value.session.id,false);}catch(e){if(currentView(owner,view))setError((e as Error).message);}}}>새 대화 시작</button>
      <h3>저장된 대화</h3><nav aria-label="저장된 대화">{sessions.length===0&&<p className="muted">아직 저장된 대화가 없어요.</p>}{sessions.map(value=><button className={`session-button ${session?.id===value.id?'selected':''}`} key={value.id} disabled={busy||draftBusy||Boolean(active)} onClick={()=>{setPersonId(value.personId);setMode(value.retrievalMode==='off'?'lexical':value.retrievalMode);setCondition(value.ragCondition??'caption');void selectSession(value.id);}}><strong>{personas.find(persona=>persona.personId===value.personId)?.label??'캐릭터'}</strong><small>{operatorMode&&`${sessionLabel(value)} · `}{new Date(value.createdAt).toLocaleDateString('ko-KR')}</small></button>)}</nav>{session&&<section className="memory-panel" aria-label={english(selected?.language)?'Your memories':'내 기억'}><h3>{english(selected?.language)?'Your memories':'내 기억'}</h3><p>{english(selected?.language)?`May ${selected?.label??'this character'} remember what you share?`:`${selected?.label??'캐릭터'}${nameParticle(selected?.label??'캐릭터')} 대화 내용을 기억해도 될까요?`}</p><label><input type="checkbox" aria-label={english(selected?.language)?'Allow chat memories':'대화 기억 허용'} checked={session.userMemoryConsent===true} disabled={busy||Boolean(active)} onChange={event=>void updateMemory('consent',event.target.checked)}/>{english(selected?.language)?'Allow chat memories':'대화 기억 허용'}</label>{memoryQuery.isError&&<p role="alert">{friendlyError((memoryQuery.error as Error).message,session.language??selected?.language)}</p>}<ul>{(memoryQuery.data?.memories??[]).map(memory=><li key={memory.id}><p>{memory.text}</p><button className="quiet" disabled={busy||Boolean(active)} aria-label={english(selected?.language)?'Forget this memory':'이 기억 지우기'} onClick={()=>void updateMemory('one',undefined,memory.id)}>{english(selected?.language)?'Forget':'지우기'}</button></li>)}</ul><button className="quiet" disabled={busy||Boolean(active)||!memoryQuery.data?.memories.length} onClick={()=>void updateMemory('all')}>{english(selected?.language)?'Forget all memories':'기억 전부 지우기'}</button><p className="muted">{english(selected?.language)?'The original messages remain. Delete the chat to remove them.':'대화 원문은 남아요. 완전히 지우려면 대화를 삭제하세요.'}</p><button className="quiet" disabled={busy||draftBusy||Boolean(active)} onClick={()=>void updateMemory('session')}>{english(selected?.language)?'Delete chat':'대화 삭제'}</button></section>}</aside>
    <main className="main-panel"><section className="chat-heading"><div><h2>{selected?.label??'캐릭터를 골라 줘'}</h2>{operatorMode&&<p className="muted">{selected?.reviewStatus??''} · {session?`고정 revision ${session.personaRevision}`:'새 대화를 시작하면 인사말이 표시됩니다.'}</p>}</div>{operatorMode&&session&&<span className="mode-tag" data-testid="session-mode">{sessionLabel(session)}</span>}</section>
      {showFirstDisclosure&&selected&&<p className="persistent-disclosure" data-testid="first-disclosure">{english(selected.language)?`${selected.label} is an AI character, not the real ${selected.label}.`:`${selected.label} 스타일로 만든 AI 캐릭터예요. 실제 ${selected.label}${nameParticle(selected.label)} 아니에요.`}</p>}
      {returning&&session&&reentryPreview&&<div className="reentry"><p data-testid="last-preview">{english(selected?.language)?'Last chat: ':'지난 대화: '}{reentryPreview.slice(0,100)}</p><p data-testid="reentry-cue">{voiceText('reentry',session.language??selected?.language??'ko',reentryLevel,lastAssistant,session.id)}</p></div>}
      <section className="messages" aria-label="대화 내역" aria-live="polite">{history.length===0&&selected&&<div className="persona-card" data-testid="persona-card"><h3>{selected.label}</h3><p>{selected.tagline??(english(selected.language)?'What would you like to talk about?':'편하게 이야기를 나눠 볼까?')}</p><div className="starter-chips">{(selected.starters&&selected.starters.length>=2?selected.starters:english(selected.language)?['Hey, how was your day?','What have you been enjoying lately?']:['안녕, 오늘 어때?','좋아하는 이야기를 들려줘']).map(starter=><button key={starter} type="button" className="starter-chip" onClick={()=>setText(starter)}>{starter}</button>)}</div></div>}{history.flatMap(message=>message.role==='assistant'?splitReplyBubbles(message.turnId===null?message.content.replace(oldGreetingPrefix,''):message.content).map((bubble,index)=><article key={`${message.id}-${index}`} className="message assistant"><div className="message-label">{selected?.label??'캐릭터'}</div><p>{bubble}</p></article>):[<article key={message.id} className="message user"><div className="message-label">나</div><p>{message.content}</p></article>])}{pendingUser&&<article className="message user"><div className="message-label">나</div><p>{active.userText}</p></article>}{active&&<article className="message assistant pending"><div className="message-label">{selected?.label??'캐릭터'}</div><p role="status">{english(selected?.language)?`${selected?.label??'Character'} is writing a reply…`:`${selected?.label??'캐릭터'}${nameParticle(selected?.label??'캐릭터')} 답장 쓰는 중…`}</p><small>{['pending','retrieving'].includes(active.state)?(english(selected?.language)?'Waiting':'기다리는 중'):(english(selected?.language)?'Writing a reply':'답장 만드는 중')}</small><button className="quiet" onClick={async()=>{const owner=ownerEpoch.current;const view=viewEpoch.current;const id=active.sessionId;try{await cancelMutation.mutateAsync(active.id);if(currentView(owner,view,id))setNotice('답장을 멈추고 있어.');}catch(e){if(currentView(owner,view,id))setError((e as Error).message);}}}>답장 멈추기</button></article>}<div ref={bottom}/></section>
      {session&&!active&&sessionQuery.isError&&<button className="quiet" disabled={busy} onClick={async()=>{const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;setError('');try{await refreshHistory(id);}catch(e){if(currentView(owner,view,id))setError((e as Error).message);}}}>대화 내역 다시 확인</button>}
      {notice&&<p className="notice" role="status">{notice}</p>}{failedAttempt&&!active&&<button className="quiet" disabled={busy} onClick={()=>void submit({...failedAttempt,clientRequestId:crypto.randomUUID()})}>다시 보내기</button>}{visibleError&&<div className="error" role="alert"><span>{friendlyError(visibleError,languageRef.current)}</span>{attempt&&!active&&<button className="quiet" disabled={busy} onClick={()=>void submit(attempt)}>답장 확인하기</button>}</div>}
      <form className="composer" onSubmit={event=>{event.preventDefault();if(!text.trim()||!session||busy||active)return;if(operatorMode&&intent==='timeline'&&((start&&!end)||(!start&&end)||(start&&end&&start>=end))){setError('INVALID_DATE_RANGE');return;}void submit({clientRequestId:crypto.randomUUID(),text:text.trim(),...(operatorMode&&intent==='timeline'?{timeline:{...(query.trim()?{query:query.trim()}:{}),...(start&&end?{start,end}:{}),dateBasis:basis,limit:5}}:{})});}}>
        {operatorMode&&<div className="operator-controls"><div className="composer-options"><label htmlFor="intent">대화 종류</label><select id="intent" value={intent} onChange={event=>setIntent(event.target.value as 'small_talk'|'timeline')} disabled={busy||draftBusy||Boolean(active)}><option value="small_talk">일상 대화</option><option value="timeline">타임라인 근거 질문</option></select></div>
        {intent==='timeline'&&<fieldset className="timeline-filter"><legend>명시적 타임라인 필터 · UTC</legend><label>검색어<input aria-label="타임라인 검색어" value={query} maxLength={500} onChange={event=>setQuery(event.target.value)} placeholder="선택 사항"/></label><label>날짜 기준<select aria-label="날짜 기준" value={basis} onChange={event=>setBasis(event.target.value as 'posted'|'event')}><option value="posted">게시일</option><option value="event">활동일 (기록된 경우만)</option></select></label><label>시작일 포함<input aria-label="시작일 포함" type="date" value={start} onChange={event=>setStart(event.target.value)}/></label><label>종료일 제외<input aria-label="종료일 제외" type="date" value={end} onChange={event=>setEnd(event.target.value)}/></label></fieldset>}</div>}
        <label className="sr-only" htmlFor="message">메시지</label><div className="compose-row"><textarea id="message" rows={3} maxLength={8000} value={text} onChange={event=>{setText(event.target.value);if(event.target.value!==failedAttempt?.text)setFailedAttempt(undefined);}} disabled={!session||busy||Boolean(active)} placeholder={session?'이야기를 입력해 주세요…':'먼저 새 대화를 시작해 주세요.'}/><button disabled={!session||!text.trim()||busy||Boolean(active)}>{busy?'전송 중…':'보내기'}</button></div>
      </form>
      {operatorMode&&<details className="draft-panel"><summary>가상 포스트 초안 · 실제 활동 근거 아님</summary><p className="muted">AI 생성 창작물은 타임라인 검색에 재유입되지 않습니다. 이미지 생성은 무료 자격을 검증하는 별도 private runner에서 실행합니다.</p><label htmlFor="brief">창작 브리프</label><textarea id="brief" maxLength={2000} value={brief} onChange={event=>setBrief(event.target.value)} placeholder="가상의 주제 / 분위기"/><button disabled={!session||!brief.trim()||draftBusy||Boolean(active)||busy} onClick={async()=>{if(!session)return;const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;draftAttempt.current=draftAttemptFor(draftAttempt.current,id,brief,()=>crypto.randomUUID());setError('');try{await draftMutation.mutateAsync(draftAttempt.current);if(currentView(owner,view,id))draftAttempt.current=undefined;}catch(e){if(currentView(owner,view,id))setError((e as Error).message);}}}>{draftBusy?'초안 준비 중…':'가상 초안 만들기'}</button>{draft&&<p className="draft-output">{draft}</p>}<p className="unavailable">External image 이미지: 별도 무료 runner · 이 버튼은 캡션만 생성 · 실제 완료 여부는 private 결과 참조</p></details>}
    </main></div></div>;
}
