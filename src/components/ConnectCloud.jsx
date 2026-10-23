import React,{useEffect,useState} from 'react';
const endpoint='/api/connect';
async function call(action,data={},token='',method='POST'){
 const url=endpoint+'?action='+encodeURIComponent(action)+(data.code?'&code='+encodeURIComponent(data.code):'')+(data.since!==undefined?'&since='+encodeURIComponent(data.since):'');
 const response=await fetch(url,{method,headers:{...(method==='POST'?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(method==='POST'?{body:JSON.stringify(data)}:{})});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Request failed');return result;
}
const field='bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 w-full text-slate-100';
const btn='bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 rounded-lg px-3 py-2';
export default function ConnectCloud(){
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[bootstrap,setBootstrap]=useState(''),[name,setName]=useState('Host'),[token,setToken]=useState(''),[code,setCode]=useState(''),[room,setRoom]=useState(null),[message,setMessage]=useState(''),[messages,setMessages]=useState([]),[snapshot,setSnapshot]=useState('{}'),[status,setStatus]=useState(''),[health,setHealth]=useState(null);
 const [cursor,setCursor]=useState('0'),[guestMode,setGuestMode]=useState(false),[inviteCopied,setInviteCopied]=useState(false);
 useEffect(()=>{
   const url=new URL(window.location.href);
   const invited=url.searchParams.get('room');
   if(invited&&/^[A-F0-9]{8}$/i.test(invited)){setCode(invited.toUpperCase());setGuestMode(true);}
   try{const saved=JSON.parse(localStorage.getItem('connect.guest.session')||'null');if(saved?.token&&saved?.code){setToken(saved.token);setCode(saved.code);setName(saved.name||'Guest');setGuestMode(true);}}catch{}
 },[]);
 const guestJoin=async()=>{const r=await call('guest-join',{code,name});setToken(r.token);setCode(r.code);setRoom(r);setGuestMode(true);setMessages([]);setCursor('0');localStorage.setItem('connect.guest.session',JSON.stringify({token:r.token,code:r.code,name}));setStatus('Guest joined · '+r.code);};
 const invite=()=>{if(!code)return;const u=new URL(window.location.href);u.searchParams.set('room',code);navigator.clipboard.writeText(u.toString()).then(()=>{setInviteCopied(true);setTimeout(()=>setInviteCopied(false),2500)}).catch(e=>setStatus(e.message));};
 const logout=()=>{setToken('');setRoom(null);setMessages([]);setCursor('0');localStorage.removeItem('connect.guest.session');setStatus('Session cleared');};
 const kick=async userId=>{await call('kick',{code,userId},token);await reload();};

 const run=fn=>async(...args)=>{try{setStatus('');const out=await fn(...args);return out;}catch(e){setStatus(e.message);}};
 useEffect(()=>{call('health',{},'','GET').then(setHealth).catch(e=>setHealth({error:e.message}));},[]);
 useEffect(()=>{if(!token||!code)return;let active=true;const check=async()=>{try{const r=await call('events',{code,since:cursor},token,'GET');if(!active)return;if(r.events?.length){setMessages(p=>[...p,...r.events].slice(-80));setCursor(r.next);}}catch(e){if(active)setStatus(e.message)}};check();const interval=setInterval(check,3500);return()=>{active=false;clearInterval(interval)};},[token,code,cursor]);
 const login=async(action)=>{const result=await call(action,action==='bootstrap'?{email,password,bootstrapKey:bootstrap}:{email,password});setToken(result.token);setGuestMode(false);localStorage.removeItem('connect.guest.session');setStatus('Authenticated');};
 const create=async()=>{const r=await call('create',{title:'Connect Session',name},token);setCode(r.code);setRoom(r);setMessages([]);setCursor('0');};
 const join=async()=>{const r=await call('join',{code,name},token);setRoom(r);setMessages([]);setCursor('0');};
 const reload=async()=>{const r=await call('room',{code},token,'GET');setRoom(r);setSnapshot(JSON.stringify(r.room.snapshot||{},null,2));};
 const resume=async()=>{const r=await call('resume',{code},token);setSnapshot(JSON.stringify(r.snapshot||{},null,2));setStatus('Host recovered; epoch '+r.epoch);};
 const save=async()=>{await call('snapshot',{code,state:JSON.parse(snapshot)},token);setStatus('Snapshot saved to Neon');};
 const send=async e=>{e.preventDefault();await call('publish',{code,kind:'chat.message',data:{text:message}},token);setMessage('');};
 return <section className="max-w-7xl mx-auto mt-8 p-5 bg-slate-900 rounded-xl border border-slate-700 text-slate-100 space-y-4"><header><div className="text-xs tracking-widest text-emerald-400">BRAIDATA CONNECT · NEON</div><h2 className="text-2xl font-bold">Cloud Rooms & Recovery</h2><p className="text-slate-400 text-sm">Persistent Vercel API · Authenticate, restore host, save snapshots and poll room events</p></header>
 {guestMode&&<p className="text-emerald-300 text-sm">Invitation mode: enter a display name and choose Join as guest. No account or password required.</p>}
 <p className="text-sm">{health?.ok?'API connected to Neon':health?'API unavailable: '+(health.error||'configuration required'):'Checking API...'}</p>
 <div className="grid md:grid-cols-4 gap-3"><input aria-label="Email" className={field} placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)}/><input aria-label="Password" className={field} placeholder="Password (12+ chars)" type="password" value={password} onChange={e=>setPassword(e.target.value)}/><input aria-label="Admin bootstrap key" className={field} type="password" placeholder="One-time admin bootstrap key" value={bootstrap} onChange={e=>setBootstrap(e.target.value)}/><div className="flex gap-2"><button className={btn} onClick={run(()=>login('login'))}>Login</button><button className={btn} onClick={run(()=>login('bootstrap'))}>Create admin</button></div></div>
 <div className="grid md:grid-cols-4 gap-3"><input aria-label="Player name" className={field} value={name} onChange={e=>setName(e.target.value)}/><input aria-label="Cloud room code" className={field} placeholder="Room code" value={code} onChange={e=>setCode(e.target.value.toUpperCase())}/><div className="flex gap-2 flex-wrap"><button className={btn} disabled={!token||guestMode} onClick={run(create)}>Create persisted room</button><button className={btn} disabled={!code} onClick={run(guestJoin)}>Join as guest</button></div><div className="flex gap-2"><button className={btn} disabled={!token||!code} onClick={run(join)}>Join</button><button className={btn} disabled={!token||!code} onClick={run(reload)}>Refresh</button><button className={btn} disabled={!token||!code||guestMode} onClick={run(resume)}>Resume host</button><button className={btn} onClick={logout}>Logout</button></div></div>
 {code&&<div className="bg-slate-950 rounded-lg p-3 flex items-center gap-3 flex-wrap"><span className="text-emerald-300 font-mono">Room {code}</span><button className={btn} onClick={invite}>{inviteCopied?'Copied!':'Copy guest invitation link'}</button><span className="text-xs text-slate-400">Share this link, not your admin credentials. Anyone with the link can join.</span></div>}
 {status&&<p role="status" className="text-amber-300 text-sm">{status}</p>}
 <div className="grid lg:grid-cols-2 gap-4"><div className="rounded-lg bg-slate-950 p-3"><h3 className="font-semibold mb-2">Persistent chat / events</h3><div className="h-44 overflow-auto text-sm space-y-1">{messages.map((m,i)=><p key={m.id||i}><span className="text-emerald-300">{m.kind}</span> {m.data?.text||JSON.stringify(m.data)}</p>)}</div><form className="flex gap-2" onSubmit={run(send)}><input className={field} value={message} onChange={e=>setMessage(e.target.value)} placeholder="Message"/><button className={btn} disabled={!token||!code}>Send</button></form></div><div className="rounded-lg bg-slate-950 p-3"><h3 className="font-semibold mb-2">Host snapshot / recover</h3><textarea aria-label="Session snapshot JSON" className={field+' h-32 font-mono text-xs'} value={snapshot} onChange={e=>setSnapshot(e.target.value)}/><button className={btn} disabled={!token||!code||guestMode} onClick={run(save)}>Save snapshot</button><p className="mt-2 text-xs text-slate-400">Only the authenticated original host can save or resume.</p></div></div>
 {room?.players?.length>0&&!guestMode&&<div className="bg-slate-950 rounded-lg p-3"><h3 className="font-semibold mb-2">Participants · host controls</h3>{room.players.map(p=><div className="flex gap-3 justify-between items-center py-1" key={p.user_id}><span>{p.name} <span className="text-xs text-slate-500">{p.user_id.slice(0,8)}</span></span><button className={btn} onClick={run(()=>kick(p.user_id))}>Remove</button></div>)}</div>}
 {room&&<pre className="text-xs overflow-x-auto p-3 bg-slate-950 rounded-lg">{JSON.stringify(room,null,2)}</pre>}</section>;
}
