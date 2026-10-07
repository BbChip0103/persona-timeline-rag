'use client';
import { useEffect, useRef, useState } from 'react';
import { turnNotice } from '../lib/turn-notice';
import { readTurnStream } from '../lib/turn-stream';

type Mode='off'|'lexical'|'semantic';
type RagCondition='off'|'caption'|'caption_image';
type Persona={id:string;personId:string;label:string;language:string;revision:string;reviewStatus:string;aiDisclosure:string};
type Session={id:string;personId:string;personaRevision:string;retrievalMode:Mode;ragCondition?:RagCondition;createdAt:string};
type Message={id:string;turnId:string|null;role:'user'|'assistant';content:string};
type Evidence={sourceId:string;sourceUrl:string;postedAt:string;eventDate:string|null;quote:string;origin?:'source_caption'|'ai_image_annotation';annotationId?:string;annotationRevision?:string;annotationHash?:string;imageHash?:string};
type Reply={grounding?:'unverified_model'|'source_bound_quotes';content:string;status:string;evidence:Evidence[];limitations:string[]};
type Turn={id:string;sessionId:string;userText:string;state:string;reply?:Reply;errorCode?:string};
type Attempt={clientRequestId:string;text:string;intent:'small_talk'|'timeline';timeline?:{query?:string;start?:string;end?:string;dateBasis:'posted'|'event';limit:number}};
const terminal=(state:string)=>['completed','failed','cancelled'].includes(state);
const conditionLabel:Record<RagCondition,string>={off:'RAG 없음',caption:'본문만',caption_image:'본문 + 이미지 설명'};
const sessionLabel=(session:Session)=>session.ragCondition?`${conditionLabel[session.ragCondition]}${session.ragCondition==='off'?'':` · ${session.retrievalMode}`}`:`기존 세션 · ${modeLabel[session.retrievalMode]}`;
const modeLabel:Record<Mode,string>={off:'RAG off · 검색 없음',lexical:'Lexical · 캡션 검색',semantic:'Semantic · 임베딩 검색'};
async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  const response=await fetch(`/api/proxy/${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal});
  const result=await response.json();
  if(!response.ok) {if(response.status===403) window.location.assign('/login');throw new Error(typeof result?.error?.code==='string'?result.error.code:'API_UNAVAILABLE');}
  return result as T;
}
function safeMetadata(value:string|undefined):string {return value && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) && !/sk-|Bearer|password|api[_-]?key/i.test(value)?value:'비공개';}
function safeSource(value:string):string|undefined {try{const url=new URL(value);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{/* Unsafe source URLs are never links. */}}
export default function Chat() {
  const [personas,setPersonas]=useState<Persona[]>([]);const [sessions,setSessions]=useState<Session[]>([]);const [personId,setPersonId]=useState('');const [mode,setMode]=useState<Mode>('semantic');const [condition,setCondition]=useState<RagCondition>('off');
  const [session,setSession]=useState<Session>();const [history,setHistory]=useState<Message[]>([]);const [replies,setReplies]=useState<Record<string,Reply>>({});
  const [text,setText]=useState('');const [intent,setIntent]=useState<'small_talk'|'timeline'>('small_talk');const [query,setQuery]=useState('');const [basis,setBasis]=useState<'posted'|'event'>('posted');const [start,setStart]=useState('');const [end,setEnd]=useState('');
  const [busy,setBusy]=useState(false);const [active,setActive]=useState<Turn>();const [attempt,setAttempt]=useState<Attempt>();const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [brief,setBrief]=useState('');const [draft,setDraft]=useState('');const [draftBusy,setDraftBusy]=useState(false);
  const sessionRef=useRef<string|undefined>(undefined);const bottom=useRef<HTMLDivElement>(null);
  async function refreshHistory(id:string) {
    const value=await api<{session:Session;history:Message[]}>(`sessions/${id}`);
    if(sessionRef.current!==id) return;
    setSession(value.session);setHistory(value.history);
    const ids=[...new Set(value.history.filter(message=>message.role==='assistant'&&message.turnId).map(message=>message.turnId!))].slice(-20);
    const turns=await Promise.all(ids.map(turnId=>api<{turn:Turn}>(`turns/${turnId}`).catch(()=>undefined)));
    if(sessionRef.current!==id) return;
    setReplies(Object.fromEntries(turns.filter(value=>value?.turn.reply).map(value=>[value!.turn.id,value!.turn.reply!])));
  }
  async function selectSession(id:string) {
    sessionRef.current=id;setActive(undefined);setAttempt(undefined);setError('');setNotice('');setDraft('');setBusy(true);
    try {await refreshHistory(id);localStorage.setItem('ptr-session-id',id);
      const activeId=localStorage.getItem(`ptr-active-turn-${id}`);
      if(activeId){const value=await api<{turn:Turn}>(`turns/${activeId}`).catch(()=>undefined);if(value&&!terminal(value.turn.state))setActive(value.turn);else {if(value)setNotice(turnNotice(value.turn));localStorage.removeItem(`ptr-active-turn-${id}`);}}
    }catch(e){setError((e as Error).message);sessionRef.current=undefined;setSession(undefined);}finally{setBusy(false);}
  }
  useEffect(()=>{let stopped=false;void Promise.all([api<{personas:Persona[]}>('personas'),api<{sessions:Session[]}>('sessions')]).then(async([people,stored])=>{
    if(stopped)return;setPersonas(people.personas);setPersonId(people.personas[0]?.personId??'');setSessions(stored.sessions);
    const saved=localStorage.getItem('ptr-session-id');const chosen=stored.sessions.find(value=>value.id===saved);
    if(chosen){setPersonId(chosen.personId);setMode(chosen.retrievalMode==='off'?'semantic':chosen.retrievalMode);setCondition(chosen.ragCondition??'off');await selectSession(chosen.id);}
  }).catch(e=>!stopped&&setError((e as Error).message));return()=>{stopped=true;};},[]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'auto',block:'nearest'});},[history.length,active?.state]);
  useEffect(()=>{
    if(!active||terminal(active.state))return;
    // Server push (SSE) instead of polling. A broken stream falls back to one status read and reconnects;
    // a stream the server ended on purpose (max duration) reconnects for a fresh snapshot. Never resubmits.
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;let failures=0;
    const settle=async(turn:Turn)=>{
      if(turn.reply)setReplies(previous=>({...previous,[turn.id]:turn.reply!}));
      setNotice(turnNotice(turn));
      await refreshHistory(turn.sessionId);if(controller.signal.aborted)return;localStorage.removeItem(`ptr-active-turn-${turn.sessionId}`);setActive(undefined);setAttempt(undefined);
    };
    const connect=async()=>{try{
      const response=await fetch(`/api/proxy/turns/${active.id}/events`,{cache:'no-store',signal:controller.signal});
      if(response.status===403){window.location.assign('/login');return;}
      if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('text/event-stream')) {
        const value=await api<{turn:Turn}>(`turns/${active.id}`,undefined,controller.signal);if(controller.signal.aborted)return;
        if(terminal(value.turn.state)){await settle(value.turn);return;}
        throw new Error('STREAM_UNAVAILABLE');
      }
      failures=0;
      const done=await readTurnStream(response.body,frame=>{
        if(frame.event==='turn'){const turn=frame.data as Turn;if(terminal(turn.state)){void settle(turn);return true;}setActive(turn);}
        else if(frame.event==='state'){const state=(frame.data as {state?:string}).state;if(state)setActive(previous=>previous?{...previous,state}:previous);}
        return false;
      });
      if(!done&&!controller.signal.aborted)timer=setTimeout(connect,300);
    }catch{if(controller.signal.aborted)return;failures++;setNotice('상태 확인 연결이 지연되고 있어요. 생성 요청은 재전송하지 않습니다.');timer=setTimeout(connect,Math.min(1000*failures,10000));}};
    void connect();return()=>{controller.abort();clearTimeout(timer);};
  },[active?.id]);
  async function submit(value:Attempt) {
    if(!session)return;setBusy(true);setError('');setNotice('');setAttempt(value);
    try {const result=await api<{turn:Turn}>(`sessions/${session.id}/turns`,value);
      if(terminal(result.turn.state)){await refreshHistory(session.id);setAttempt(undefined);setNotice(turnNotice(result.turn));}else {localStorage.setItem(`ptr-active-turn-${result.turn.sessionId}`,result.turn.id);setActive(result.turn);}
      setText('');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const selected=personas.find(persona=>persona.personId===(session?.personId??personId));
  const pendingUser=active&&!history.some(message=>message.turnId===active.id&&message.role==='user');
  return <div className="workspace"><header className="topbar"><div><span className="eyebrow">PRIVATE RESEARCH</span><h1>Persona Lab</h1></div><span className="ai-tag">연구용 AI 시뮬레이션 · 비공식</span><button className="quiet" onClick={async()=>{await fetch('/api/auth',{method:'DELETE'});window.location.assign('/login');}}>로그아웃</button></header>
    <div className="workspace-body"><aside className="sidebar"><h2>대화 공간</h2><p className="muted">실제 인물이나 공식 계정이 아닙니다. 생성된 글은 실제 활동 근거로 사용하지 않습니다.</p>
      <label htmlFor="persona">연구 페르소나</label><select id="persona" value={personId} onChange={event=>setPersonId(event.target.value)} disabled={busy||draftBusy||Boolean(active)}>{personas.map(persona=><option key={persona.id} value={persona.personId}>{persona.label}</option>)}</select>
      <label htmlFor="rag-condition">새 세션의 RAG 조건</label><select id="rag-condition" value={condition} onChange={event=>setCondition(event.target.value as RagCondition)} disabled={busy||draftBusy||Boolean(active)}>{Object.entries(conditionLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      {condition!=='off'&&<><label htmlFor="mode">검색 알고리즘</label><select id="mode" value={mode} onChange={event=>setMode(event.target.value as Mode)} disabled={busy||draftBusy||Boolean(active)}><option value="lexical">Lexical</option><option value="semantic">Semantic</option></select></>}
      <button disabled={!personId||busy||draftBusy||Boolean(active)} onClick={async()=>{setBusy(true);setError('');try{const value=await api<{session:Session}>('sessions',{personId,ragCondition:condition,retrievalMode:condition==='off'?'off':mode,timezone:'UTC'});setSessions(previous=>[value.session,...previous]);await selectSession(value.session.id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>새 대화 시작</button>
      <h3>저장된 대화</h3><nav aria-label="저장된 대화">{sessions.length===0&&<p className="muted">아직 저장된 대화가 없어요.</p>}{sessions.map(value=><button className={`session-button ${session?.id===value.id?'selected':''}`} key={value.id} disabled={busy||draftBusy||Boolean(active)} onClick={()=>{setPersonId(value.personId);setMode(value.retrievalMode==='off'?'semantic':value.retrievalMode);setCondition(value.ragCondition??'off');void selectSession(value.id);}}><strong>{personas.find(persona=>persona.personId===value.personId)?.label??'연구 페르소나'}</strong><small>{sessionLabel(value)} · {new Date(value.createdAt).toLocaleDateString('ko-KR')}</small></button>)}</nav>
      <div className="privacy-note">로컬 전용 · 히스토리는 개인 연구 DB에 저장됩니다. Semantic 모드는 승인된 경우 외부 임베딩을 사용할 수 있습니다.</div></aside>
    <main className="main-panel"><section className="chat-heading"><div><h2>{selected?.label??'페르소나를 선택해 주세요'}</h2><p className="muted">{selected?.reviewStatus??'연구용'} · {session?`고정 revision ${session.personaRevision}`:'새 대화를 시작하면 인사말이 표시됩니다.'}</p></div>{session&&<span className="mode-tag" data-testid="session-mode">{sessionLabel(session)}</span>}</section>
      <div className="persistent-disclosure">AI가 생성하는 연구용 대화입니다. 이미지 설명과 의도 해석은 AI 파생 자료이며 실제 작가 의도가 아닙니다. 게시일과 실제 활동일은 다를 수 있습니다.</div>
      <section className="messages" aria-label="대화 내역" aria-live="polite">{history.length===0&&<div className="empty-state"><h3>근거는 명확하게, 대화는 편안하게.</h3><p>페르소나와 검색 방식을 선택하고 새 대화를 시작해 보세요.</p></div>}{history.map(message=><article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role==='user'?'나':'AI 시뮬레이션'}</div><p>{message.content}</p>{message.role==='assistant'&&message.turnId&&replies[message.turnId]&&<SourceCards reply={replies[message.turnId]!}/>}</article>)}{pendingUser&&<article className="message user"><div className="message-label">나</div><p>{active.userText}</p></article>}{active&&<article className="message assistant pending"><div className="message-label">AI 시뮬레이션 · {active.state}</div><p role="status">응답을 준비하고 있어요…</p><button className="quiet" onClick={async()=>{try{await api(`turns/${active.id}/cancel`,{});setNotice('취소를 요청했습니다. 상태를 확인합니다.');}catch(e){setError((e as Error).message);}}}>생성 취소</button></article>}<div ref={bottom}/></section>
      {notice&&<p className="notice" role="status">{notice}</p>}{error&&<div className="error" role="alert"><span>요청을 처리하지 못했습니다: {error}</span>{attempt&&!active&&<button className="quiet" disabled={busy} onClick={()=>void submit(attempt)}>같은 요청 ID로 다시 확인</button>}</div>}
      <form className="composer" onSubmit={event=>{event.preventDefault();if(!text.trim()||!session||busy||active)return;if(intent==='timeline'&&((start&&!end)||(!start&&end)||(start&&end&&start>=end))){setError('날짜는 시작일 포함 / 종료일 제외의 유효한 UTC 범위로 함께 입력해 주세요.');return;}void submit({clientRequestId:crypto.randomUUID(),text:text.trim(),intent,...(intent==='timeline'?{timeline:{...(query.trim()?{query:query.trim()}:{}),...(start&&end?{start,end}:{}),dateBasis:basis,limit:5}}:{})});}}>
        <div className="composer-options"><label htmlFor="intent">대화 종류</label><select id="intent" value={intent} onChange={event=>setIntent(event.target.value as 'small_talk'|'timeline')} disabled={busy||draftBusy||Boolean(active)}><option value="small_talk">일상 대화</option><option value="timeline">타임라인 근거 질문</option></select></div>
        {intent==='timeline'&&<fieldset className="timeline-filter"><legend>명시적 타임라인 필터 · UTC</legend><label>검색어<input aria-label="타임라인 검색어" value={query} maxLength={500} onChange={event=>setQuery(event.target.value)} placeholder="선택 사항"/></label><label>날짜 기준<select aria-label="날짜 기준" value={basis} onChange={event=>setBasis(event.target.value as 'posted'|'event')}><option value="posted">게시일</option><option value="event">활동일 (기록된 경우만)</option></select></label><label>시작일 포함<input aria-label="시작일 포함" type="date" value={start} onChange={event=>setStart(event.target.value)}/></label><label>종료일 제외<input aria-label="종료일 제외" type="date" value={end} onChange={event=>setEnd(event.target.value)}/></label><small>자연어 날짜를 자동으로 추정하지 않습니다. RAG 없음은 같은 모델의 검증되지 않은 응답을 비교하며 사실 근거를 제공하지 않습니다.</small></fieldset>}
        <label className="sr-only" htmlFor="message">메시지</label><div className="compose-row"><textarea id="message" rows={3} maxLength={8000} value={text} onChange={event=>setText(event.target.value)} disabled={!session||busy||Boolean(active)} placeholder={session?'이야기를 입력해 주세요…':'먼저 새 대화를 시작해 주세요.'}/><button disabled={!session||!text.trim()||busy||Boolean(active)}>{busy?'전송 중…':'보내기'}</button></div>
      </form>
      <details className="draft-panel"><summary>가상 포스트 초안 · 실제 활동 근거 아님</summary><p className="muted">AI 생성 창작물은 타임라인 검색에 재유입되지 않습니다. 이미지 생성은 무료 자격을 검증하는 별도 private runner에서 실행합니다.</p><label htmlFor="brief">창작 브리프</label><textarea id="brief" maxLength={2000} value={brief} onChange={event=>setBrief(event.target.value)} placeholder="가상의 주제 / 분위기"/><button disabled={!session||!brief.trim()||draftBusy||Boolean(active)||busy} onClick={async()=>{if(!session)return;setDraftBusy(true);setError('');try{const value=await api<{artifact:{content:string};image:{code:string}}>(`sessions/${session.id}/drafts`,{brief});setDraft(value.artifact.content);}catch(e){setError((e as Error).message);}finally{setDraftBusy(false);}}}>{draftBusy?'초안 준비 중…':'가상 초안 만들기'}</button>{draft&&<p className="draft-output">{draft}</p>}<p className="unavailable">External image 이미지: 별도 무료 runner · 이 버튼은 캡션만 생성 · 실제 완료 여부는 private 결과 참조</p></details>
    </main></div></div>;
}
function SourceCards({reply}:{reply:Reply}) {return <div className="evidence"><span className="reply-status">근거 상태: {reply.status} · {reply.grounding==='unverified_model'?'검증되지 않은 모델 응답':reply.grounding==='source_bound_quotes'?'인용 원문 일치만 검증 · 의미적 사실 검수 아님':'원문 인용'}</span>{reply.evidence.map((source,index)=><section className={`source-card ${source.origin==='ai_image_annotation'?'ai-annotation':''}`} data-evidence-origin={source.origin??'source_caption'} key={`${source.sourceId}-${index}`}><h4>{source.origin==='ai_image_annotation'?'AI 이미지 설명 · 검수되지 않은 파생 근거':'본문 원문 근거'}</h4><blockquote>{source.quote}</blockquote><dl>{source.origin==='ai_image_annotation'&&<><div><dt>설명 ID / revision</dt><dd>{safeMetadata(source.annotationId)} / {safeMetadata(source.annotationRevision)}</dd></div><div><dt>설명 hash</dt><dd>{safeMetadata(source.annotationHash)}</dd></div><div><dt>이미지 hash</dt><dd>{safeMetadata(source.imageHash)}</dd></div></>}<div><dt>게시일</dt><dd>{source.postedAt}</dd></div><div><dt>활동일</dt><dd>{source.eventDate??'기록 없음 · 게시일로 추정하지 않음'}</dd></div></dl>{safeSource(source.sourceUrl)?<a href={safeSource(source.sourceUrl)} target="_blank" rel="noopener noreferrer">원본 링크 ↗</a>:<span>안전하지 않은 원본 링크는 표시하지 않습니다.</span>}</section>)}{reply.limitations.length>0&&<ul className="limitations">{reply.limitations.map((value,index)=><li key={index}>{value}</li>)}</ul>}</div>;}
