'use client';
import { useState } from 'react';
export default function Login() {
  const [password,setPassword]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <main className="login-shell"><section className="login-card"><div className="eyebrow">PRIVATE RESEARCH WORKSPACE</div><h1>Persona Lab</h1><p className="disclosure">연구용 AI 시뮬레이션 · 실제 인물 / 공식 계정이 아닙니다.</p><p>개인 연구용 로컬 공간입니다. 비밀번호를 입력해 주세요.</p><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(!response.ok) throw new Error();setPassword('');window.location.assign('/');}catch{setError('로그인할 수 없습니다. 비밀번호와 로컬 서버 상태를 확인해 주세요.');}finally{setBusy(false);}}}><label htmlFor="password">연구 공간 비밀번호</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required/><button disabled={busy}>{busy?'확인 중…':'로그인'}</button>{error&&<p role="alert">{error}</p>}</form><small>계정 / 모델 API 키는 브라우저에 전달하지 않습니다.</small></section></main>;
}
