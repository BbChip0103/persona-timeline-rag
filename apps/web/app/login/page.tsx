'use client';
import { useState } from 'react';
export default function Login() {
  const [password,setPassword]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <main className="login-shell"><section className="login-card"><h1>대화 공간</h1><p className="disclosure">AI 캐릭터와 이야기를 시작해 보세요.</p><p>비밀번호를 입력해 주세요.</p><form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(!response.ok) throw new Error();setPassword('');window.location.assign('/');}catch{setError('로그인할 수 없어요. 비밀번호를 다시 확인해 주세요.');}finally{setBusy(false);}}}><label htmlFor="password">비밀번호</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required/><button disabled={busy}>{busy?'확인 중…':'로그인'}</button>{error&&<p role="alert">{error}</p>}</form></section></main>;
}
