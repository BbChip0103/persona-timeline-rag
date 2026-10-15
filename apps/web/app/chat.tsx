'use client';
import { useEffect, useRef, useState } from 'react';
import { turnNotice } from '../lib/turn-notice';
import { subscribeTurnStream } from '../lib/turn-stream';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearOwnerQueries } from '../lib/query-client';
import { requestApi } from '../lib/api';
import { draftAttemptFor, type DraftAttempt } from '../lib/draft-attempt';

type Mode='off'|'lexical'|'semantic';
type RagCondition='off'|'caption'|'caption_image';
type Persona={id:string;personId:string;label:string;language:string;revision:string;reviewStatus:string;aiDisclosure:string};
type Session={id:string;personId:string;personaRevision:string;language?:string;retrievalMode:Mode;ragCondition?:RagCondition;createdAt:string};
type Message={id:string;turnId:string|null;role:'user'|'assistant';content:string};
type Turn={id:string;sessionId:string;userText:string;state:string;errorCode?:string};
type Attempt={clientRequestId:string;text:string;intent:'small_talk'|'timeline';timeline?:{query?:string;start?:string;end?:string;dateBasis:'posted'|'event';limit:number}};
const terminal=(state:string)=>['completed','failed','cancelled'].includes(state);
const conditionLabel:Record<RagCondition,string>={off:'RAG 없음',caption:'본문만',caption_image:'본문 + 이미지 설명'};
const sessionLabel=(session:Session)=>session.ragCondition?`${conditionLabel[session.ragCondition]}${session.ragCondition==='off'?'':` · ${session.retrievalMode}`}`:`기존 세션 · ${modeLabel[session.retrievalMode]}`;
const modeLabel:Record<Mode,string>={off:'RAG off · 검색 없음',lexical:'Lexical · 캡션 검색',semantic:'Semantic · 임베딩 검색'};
const canResend=(turn:Turn)=>turn.state==='failed'&&!['PROVIDER_REQUEST_UNRESOLVED','CONTEXT_LIMIT'].includes(turn.errorCode??'');
const canRefill=(turn:Turn)=>turn.state==='failed'&&turn.errorCode!=='PROVIDER_REQUEST_UNRESOLVED';
export default function Chat() {
  const client=useQueryClient();
  const ownerEpoch=useRef(0);const viewEpoch=useRef(0);const [ownerActive,setOwnerActive]=useState(true);
  const mounted=useRef(true);const sessionRef=useRef<string|undefined>(undefined);const streamController=useRef<AbortController|undefined>(undefined);
  const onUnauthorized=()=>{invalidateOwner();void clearOwnerQueries(client);window.location.assign('/login');};
  const api=<T,>(path:string,body?:unknown,signal?:AbortSignal)=>requestApi<T>(path,body,signal,onUnauthorized);
  const people=useQuery({queryKey:['personas'],enabled:ownerActive,queryFn:({signal})=>api<{personas:Persona[]}>('personas',undefined,signal)});
  const stored=useQuery({queryKey:['sessions'],enabled:ownerActive,queryFn:({signal})=>api<{sessions:Session[]}>('sessions',undefined,signal)});
  const personas=ownerActive?(people.data?.personas??[]):[];const sessions=ownerActive?(stored.data?.sessions??[]):[];
  const [personId,setPersonId]=useState('');const [mode,setMode]=useState<Mode>('semantic');const [condition,setCondition]=useState<RagCondition>('off');
  const [sessionId,setSessionId]=useState<string>();const [activeId,setActiveId]=useState<string>();
  const sessionQuery=useQuery({queryKey:['session',sessionId],enabled:ownerActive&&Boolean(sessionId),queryFn:({signal})=>api<{session:Session;history:Message[]}>(`sessions/${sessionId}`,undefined,signal)});
  const session=ownerActive?sessionQuery.data?.session:undefined;const history=ownerActive?(sessionQuery.data?.history??[]):[];
  const activeQuery=useQuery({queryKey:['turn',activeId],enabled:false,queryFn:({signal})=>api<{turn:Turn}>(`turns/${activeId}`,undefined,signal)});
  const active=ownerActive?activeQuery.data?.turn:undefined;
  const setActive=(turn:Turn|undefined)=>{if(turn){client.setQueryData(['turn',turn.id],{turn});setActiveId(turn.id);}else setActiveId(undefined);};
  const [text,setText]=useState('');const [intent,setIntent]=useState<'small_talk'|'timeline'>('small_talk');const [query,setQuery]=useState('');const [basis,setBasis]=useState<'posted'|'event'>('posted');const [start,setStart]=useState('');const [end,setEnd]=useState('');
  const [selectBusy,setSelectBusy]=useState(false);const [attempt,setAttempt]=useState<Attempt>();const [failedAttempt,setFailedAttempt]=useState<Attempt>();const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [brief,setBrief]=useState('');
  const draftAttempt=useRef<DraftAttempt|undefined>(undefined);
  const languageRef=useRef<string|undefined>(undefined);const bottom=useRef<HTMLDivElement>(null);const restored=useRef(false);
  const submitMutation=useMutation({mutationFn:({id,value}:{id:string;value:Attempt})=>api<{turn:Turn}>(`sessions/${id}/turns`,value)});
  const sessionMutation=useMutation({mutationFn:(body:unknown)=>api<{session:Session}>('sessions',body)});
  const cancelMutation=useMutation({mutationFn:(id:string)=>api(`turns/${id}/cancel`,{})});
  const draftMutation=useMutation({mutationFn:(value:DraftAttempt)=>api<{artifact?:{content:string};notice?:{content:string};image:{code:string}}>(`sessions/${value.sessionId}/drafts`,{brief:value.brief,clientRequestId:value.clientRequestId})});
  const busy=!ownerActive||selectBusy||sessionQuery.isFetching||submitMutation.isPending||sessionMutation.isPending;
  const draftBusy=draftMutation.isPending;const draft=ownerActive?(draftMutation.data?.artifact?.content??draftMutation.data?.notice?.content??''):'';
  function invalidateOwner() {
    ownerEpoch.current++;viewEpoch.current++;sessionRef.current=undefined;streamController.current?.abort();setOwnerActive(false);setSessionId(undefined);setActiveId(undefined);setAttempt(undefined);setFailedAttempt(undefined);setError('');setNotice('');setText('');setBrief('');setQuery('');setStart('');setEnd('');setPersonId('');
    submitMutation.reset();sessionMutation.reset();cancelMutation.reset();draftMutation.reset();draftAttempt.current=undefined;
  }
  const currentView=(owner:number,view:number,id?:string)=>mounted.current&&ownerActive&&ownerEpoch.current===owner&&viewEpoch.current===view&&(id===undefined||sessionRef.current===id);

  async function refreshHistory(id:string) {
    const owner=ownerEpoch.current;const view=viewEpoch.current;if(!currentView(owner,view,id))return;
    await client.invalidateQueries({queryKey:['session',id],exact:true,refetchType:'none'});
    if(!currentView(owner,view,id))return;
    const value=await client.fetchQuery({queryKey:['session',id],queryFn:({signal})=>api<{session:Session;history:Message[]}>(`sessions/${id}`,undefined,signal)});
    if(currentView(owner,view,id))languageRef.current=value.session.language;
    return value;
  }
  async function selectSession(id:string) {
    const owner=ownerEpoch.current;const view=++viewEpoch.current;sessionRef.current=id;setSessionId(id);setActive(undefined);setAttempt(undefined);setFailedAttempt(undefined);setError('');setNotice('');draftMutation.reset();draftAttempt.current=undefined;setSelectBusy(true);
    try {await refreshHistory(id);if(!currentView(owner,view,id))return;localStorage.setItem('ptr-session-id',id);
      const recovered=localStorage.getItem(`ptr-active-turn-${id}`);
      if(recovered){const value=await client.fetchQuery({queryKey:['turn',recovered],queryFn:({signal})=>api<{turn:Turn}>(`turns/${recovered}`,undefined,signal)}).catch(()=>undefined);
        if(!currentView(owner,view,id))return;if(value&&!terminal(value.turn.state))setActive(value.turn);else {if(value){setNotice(turnNotice(value.turn,languageRef.current));if(value.turn.state==='failed'){if(canRefill(value.turn))setText(value.turn.userText);if(canResend(value.turn))setFailedAttempt({clientRequestId:'',text:value.turn.userText,intent});}}localStorage.removeItem(`ptr-active-turn-${id}`);}}
    }catch(e){if(currentView(owner,view,id)){setError((e as Error).message);sessionRef.current=undefined;setSessionId(undefined);}}
    finally{if(mounted.current&&ownerEpoch.current===owner&&viewEpoch.current===view)setSelectBusy(false);}
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;streamController.current?.abort();};},[]);
  useEffect(()=>{
    if(!ownerActive||restored.current||!people.data||!stored.data)return;restored.current=true;setPersonId(people.data.personas[0]?.personId??'');
    const saved=localStorage.getItem('ptr-session-id');const chosen=stored.data.sessions.find(value=>value.id===saved);
    if(chosen){setPersonId(chosen.personId);setMode(chosen.retrievalMode==='off'?'semantic':chosen.retrievalMode);setCondition(chosen.ragCondition??'off');void selectSession(chosen.id);}
  },[ownerActive,people.data,stored.data]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'auto',block:'nearest'});},[history.length,active?.state]);
  useEffect(()=>{
    if(!active||terminal(active.state))return;
    const owner=ownerEpoch.current;const view=viewEpoch.current;const controller=new AbortController();streamController.current=controller;let settling=false;
    const current=()=>!controller.signal.aborted&&currentView(owner,view,active.sessionId);
    const settle=async(turn:Turn)=>{
      if(settling||!current())return;settling=true;client.setQueryData(['turn',turn.id],{turn});setNotice(turnNotice(turn,languageRef.current));
      if(turn.state==='failed'){if(canRefill(turn))setText(turn.userText);if(canResend(turn))setFailedAttempt(attempt?.text===turn.userText?attempt:{clientRequestId:'',text:turn.userText,intent});}
      try{await refreshHistory(turn.sessionId);}
      catch(e){if(current())setError((e as Error).message);}
      finally{if(current()){localStorage.removeItem(`ptr-active-turn-${turn.sessionId}`);setActive(undefined);setAttempt(undefined);}}
    };
    void subscribeTurnStream({turnId:active.id,signal:controller.signal,onUnauthorized,
      readStatus:async signal=>{const value=await requestApi<{turn:Turn}>(`turns/${active.id}`,undefined,signal);return terminal(value.turn.state)?{event:'turn',data:value.turn}:undefined;},
      onDelay:()=>{if(current())setNotice('상태 확인 연결이 지연되고 있어요. 생성 요청은 재전송하지 않습니다.');},
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
    if(!session)return;const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;setError('');setNotice('');setFailedAttempt(undefined);setAttempt(value);
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
  const pendingUser=active&&!history.some(message=>message.turnId===active.id&&message.role==='user');
  return <div className="workspace"><header className="topbar"><div><span className="eyebrow">PRIVATE RESEARCH</span><h1>Persona Lab</h1></div><span className="ai-tag">연구용 AI 시뮬레이션 · 비공식</span><button className="quiet" onClick={async()=>{invalidateOwner();await clearOwnerQueries(client);await fetch('/api/auth',{method:'DELETE'});window.location.assign('/login');}}>로그아웃</button></header>
    <div className="workspace-body"><aside className="sidebar"><h2>대화 공간</h2><p className="muted">실제 인물이나 공식 계정이 아닙니다. 생성된 글은 실제 활동 근거로 사용하지 않습니다.</p>
      <label htmlFor="persona">연구 페르소나</label><select id="persona" value={personId} onChange={event=>setPersonId(event.target.value)} disabled={busy||draftBusy||Boolean(active)}>{personas.map(persona=><option key={persona.id} value={persona.personId}>{persona.label}</option>)}</select>
      <label htmlFor="rag-condition">새 세션의 RAG 조건</label><select id="rag-condition" value={condition} onChange={event=>setCondition(event.target.value as RagCondition)} disabled={busy||draftBusy||Boolean(active)}>{Object.entries(conditionLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      {condition!=='off'&&<><label htmlFor="mode">검색 알고리즘</label><select id="mode" value={mode} onChange={event=>setMode(event.target.value as Mode)} disabled={busy||draftBusy||Boolean(active)}><option value="lexical">Lexical</option><option value="semantic">Semantic</option></select></>}
      <button disabled={!personId||busy||draftBusy||Boolean(active)} onClick={async()=>{const owner=ownerEpoch.current;const view=viewEpoch.current;setError('');try{const value=await sessionMutation.mutateAsync({personId,ragCondition:condition,retrievalMode:condition==='off'?'off':mode,timezone:'UTC'});if(!currentView(owner,view))return;client.setQueryData<{sessions:Session[]}>(['sessions'],previous=>({sessions:[value.session,...(previous?.sessions??[])]}));await selectSession(value.session.id);}catch(e){if(currentView(owner,view))setError((e as Error).message);}}}>새 대화 시작</button>
      <h3>저장된 대화</h3><nav aria-label="저장된 대화">{sessions.length===0&&<p className="muted">아직 저장된 대화가 없어요.</p>}{sessions.map(value=><button className={`session-button ${session?.id===value.id?'selected':''}`} key={value.id} disabled={busy||draftBusy||Boolean(active)} onClick={()=>{setPersonId(value.personId);setMode(value.retrievalMode==='off'?'semantic':value.retrievalMode);setCondition(value.ragCondition??'off');void selectSession(value.id);}}><strong>{personas.find(persona=>persona.personId===value.personId)?.label??'연구 페르소나'}</strong><small>{sessionLabel(value)} · {new Date(value.createdAt).toLocaleDateString('ko-KR')}</small></button>)}</nav>
      <div className="privacy-note">로컬 전용 · 히스토리는 개인 연구 DB에 저장됩니다. Semantic 모드는 승인된 경우 외부 임베딩을 사용할 수 있습니다.</div></aside>
    <main className="main-panel"><section className="chat-heading"><div><h2>{selected?.label??'페르소나를 선택해 주세요'}</h2><p className="muted">{selected?.reviewStatus??'연구용'} · {session?`고정 revision ${session.personaRevision}`:'새 대화를 시작하면 인사말이 표시됩니다.'}</p></div>{session&&<span className="mode-tag" data-testid="session-mode">{sessionLabel(session)}</span>}</section>
      <div className="persistent-disclosure">AI가 생성하는 연구용 대화입니다. 이미지 설명과 의도 해석은 AI 파생 자료이며 실제 작가 의도가 아닙니다. 게시일과 실제 활동일은 다를 수 있습니다.</div>
      <section className="messages" aria-label="대화 내역" aria-live="polite">{history.length===0&&<div className="empty-state"><h3>근거는 명확하게, 대화는 편안하게.</h3><p>페르소나와 검색 방식을 선택하고 새 대화를 시작해 보세요.</p></div>}{history.map(message=><article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role==='user'?'나':'AI 시뮬레이션'}</div><p>{message.content}</p></article>)}{pendingUser&&<article className="message user"><div className="message-label">나</div><p>{active.userText}</p></article>}{active&&<article className="message assistant pending"><div className="message-label">AI 시뮬레이션 · {active.state}</div><p role="status">응답을 준비하고 있어요…</p><button className="quiet" onClick={async()=>{const owner=ownerEpoch.current;const view=viewEpoch.current;const id=active.sessionId;try{await cancelMutation.mutateAsync(active.id);if(currentView(owner,view,id))setNotice('취소를 요청했습니다. 상태를 확인합니다.');}catch(e){if(currentView(owner,view,id))setError((e as Error).message);}}}>생성 취소</button></article>}<div ref={bottom}/></section>
      {session&&!active&&sessionQuery.isError&&<button className="quiet" disabled={busy} onClick={async()=>{const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;setError('');try{await refreshHistory(id);}catch(e){if(currentView(owner,view,id))setError((e as Error).message);}}}>대화 내역 다시 확인</button>}
      {notice&&<p className="notice" role="status">{notice}</p>}{failedAttempt&&!active&&<button className="quiet" disabled={busy} onClick={()=>void submit({...failedAttempt,clientRequestId:crypto.randomUUID()})}>다시 보내기</button>}{visibleError&&<div className="error" role="alert"><span>요청을 처리하지 못했습니다: {visibleError}</span>{attempt&&!active&&<button className="quiet" disabled={busy} onClick={()=>void submit(attempt)}>같은 요청 ID로 다시 확인</button>}</div>}
      <form className="composer" onSubmit={event=>{event.preventDefault();if(!text.trim()||!session||busy||active)return;if(intent==='timeline'&&((start&&!end)||(!start&&end)||(start&&end&&start>=end))){setError('날짜는 시작일 포함 / 종료일 제외의 유효한 UTC 범위로 함께 입력해 주세요.');return;}void submit({clientRequestId:crypto.randomUUID(),text:text.trim(),intent,...(intent==='timeline'?{timeline:{...(query.trim()?{query:query.trim()}:{}),...(start&&end?{start,end}:{}),dateBasis:basis,limit:5}}:{})});}}>
        <div className="composer-options"><label htmlFor="intent">대화 종류</label><select id="intent" value={intent} onChange={event=>setIntent(event.target.value as 'small_talk'|'timeline')} disabled={busy||draftBusy||Boolean(active)}><option value="small_talk">일상 대화</option><option value="timeline">타임라인 근거 질문</option></select></div>
        {intent==='timeline'&&<fieldset className="timeline-filter"><legend>명시적 타임라인 필터 · UTC</legend><label>검색어<input aria-label="타임라인 검색어" value={query} maxLength={500} onChange={event=>setQuery(event.target.value)} placeholder="선택 사항"/></label><label>날짜 기준<select aria-label="날짜 기준" value={basis} onChange={event=>setBasis(event.target.value as 'posted'|'event')}><option value="posted">게시일</option><option value="event">활동일 (기록된 경우만)</option></select></label><label>시작일 포함<input aria-label="시작일 포함" type="date" value={start} onChange={event=>setStart(event.target.value)}/></label><label>종료일 제외<input aria-label="종료일 제외" type="date" value={end} onChange={event=>setEnd(event.target.value)}/></label><small>자연어 날짜를 자동으로 추정하지 않습니다. RAG 없음은 같은 모델의 검증되지 않은 응답을 비교하며 사실 근거를 제공하지 않습니다.</small></fieldset>}
        <label className="sr-only" htmlFor="message">메시지</label><div className="compose-row"><textarea id="message" rows={3} maxLength={8000} value={text} onChange={event=>{setText(event.target.value);if(event.target.value!==failedAttempt?.text)setFailedAttempt(undefined);}} disabled={!session||busy||Boolean(active)} placeholder={session?'이야기를 입력해 주세요…':'먼저 새 대화를 시작해 주세요.'}/><button disabled={!session||!text.trim()||busy||Boolean(active)}>{busy?'전송 중…':'보내기'}</button></div>
      </form>
      <details className="draft-panel"><summary>가상 포스트 초안 · 실제 활동 근거 아님</summary><p className="muted">AI 생성 창작물은 타임라인 검색에 재유입되지 않습니다. 이미지 생성은 무료 자격을 검증하는 별도 private runner에서 실행합니다.</p><label htmlFor="brief">창작 브리프</label><textarea id="brief" maxLength={2000} value={brief} onChange={event=>setBrief(event.target.value)} placeholder="가상의 주제 / 분위기"/><button disabled={!session||!brief.trim()||draftBusy||Boolean(active)||busy} onClick={async()=>{if(!session)return;const id=session.id;const owner=ownerEpoch.current;const view=viewEpoch.current;draftAttempt.current=draftAttemptFor(draftAttempt.current,id,brief,()=>crypto.randomUUID());setError('');try{await draftMutation.mutateAsync(draftAttempt.current);if(currentView(owner,view,id))draftAttempt.current=undefined;}catch(e){if(currentView(owner,view,id))setError((e as Error).message);}}}>{draftBusy?'초안 준비 중…':'가상 초안 만들기'}</button>{draft&&<p className="draft-output">{draft}</p>}<p className="unavailable">External image 이미지: 별도 무료 runner · 이 버튼은 캡션만 생성 · 실제 완료 여부는 private 결과 참조</p></details>
    </main></div></div>;
}
