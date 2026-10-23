import React,{useEffect,useRef,useState} from 'react';
import Peer from 'peerjs';

const input='w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-emerald-500 outline-none';
const btn='rounded-xl bg-emerald-700 px-4 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-40';
const secondary='rounded-xl bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700 disabled:opacity-40';
async function publish(code,token,kind,data){
 const res=await fetch('/api/connect?action=publish',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({code,kind,data})});
 const payload=await res.json();if(!res.ok)throw Error(payload.error||'Publish failed');return payload;
}
export default function ConnectRealtime({code,token,current,isHost=false,events=[]}){
 const [coords,setCoords]=useState({x:0,y:0,z:0,ry:0});
 const [kind,setKind]=useState('demo.switch.activated');
 const [payload,setPayload]=useState('{"target":"console","active":true}');
 const [micOn,setMicOn]=useState(false),[voiceStatus,setVoiceStatus]=useState('Desactivado'),[error,setError]=useState('');
 const [remotePeers,setRemotePeers]=useState([]);
 const peer=useRef(null),stream=useRef(null),calls=useRef(new Map()),audio=useRef(new Map()),me=useRef(''),room=useRef('');
 const enabled=Boolean(code&&token&&current?.id);
 const emit=async(k,d)=>{setError('');try{await publish(code,token,k,d)}catch(e){setError(e.message)}};
 const stop=()=>{for(const c of calls.current.values())c.close();calls.current.clear();for(const a of audio.current.values())a.remove();audio.current.clear();stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;peer.current?.destroy();peer.current=null;me.current='';setMicOn(false);setVoiceStatus('Desactivado');setRemotePeers([])};
 const bindCall=call=>{if(calls.current.has(call.peer))return;calls.current.set(call.peer,call);call.on('stream',s=>{let el=audio.current.get(call.peer);if(!el){el=document.createElement('audio');el.autoplay=true;el.playsInline=true;document.body.appendChild(el);audio.current.set(call.peer,el)}el.srcObject=s;el.play().catch(()=>setError('El navegador bloqueó el audio remoto; interactuá con la página.'));setRemotePeers([...calls.current.keys()]);});call.on('close',()=>{calls.current.delete(call.peer);audio.current.get(call.peer)?.remove();audio.current.delete(call.peer);setRemotePeers([...calls.current.keys()])});call.on('error',e=>setError(e.message))};
 useEffect(()=>()=>{for(const c of calls.current.values())c.close();for(const a of audio.current.values())a.remove();stream.current?.getTracks().forEach(t=>t.stop());peer.current?.destroy()},[]);
 useEffect(()=>{if(room.current&&room.current!==code)stop();room.current=code},[code]);
 const announce=async()=>{if(me.current&&enabled)await publish(code,token,'player.input',{type:'voice.presence',peerId:me.current})};
 const start=async()=>{
  if(!enabled)return;setError('');setVoiceStatus('Solicitando micrófono…');
  try{
   const s=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
   stream.current=s;const p=new Peer();peer.current=p;
   p.on('call',call=>{if(!stream.current){call.close();return}call.answer(stream.current);bindCall(call)});
   p.on('open',async id=>{me.current=id;setMicOn(true);setVoiceStatus('Micrófono activo · P2P');try{await announce()}catch(e){setError(e.message)}});
   p.on('error',e=>{setError('WebRTC: '+e.message);setVoiceStatus('Error de conexión')});
  }catch(e){setError(e.message);stop()}
 };
 const recent=events.filter(e=>e.kind==='player.input'||e.kind==='game.event');
 useEffect(()=>{if(!peer.current||!stream.current||!me.current)return;for(const e of recent){const d=e.data||e.body;if(e.kind!=='player.input'||d?.type!=='voice.presence'||!d.peerId||e.user_id===current?.id||d.peerId===me.current||calls.current.has(d.peerId))continue;
   // Only the lexicographically lower Peer ID initiates, preventing duplicate calls.
   if(me.current<d.peerId){const call=peer.current.call(d.peerId,stream.current);if(call)bindCall(call)}
 }},[events,current?.id,micOn]);
 useEffect(()=>{if(!micOn)return;const id=setInterval(()=>announce().catch(e=>setError(e.message)),12000);return()=>clearInterval(id)},[micOn,code,token]);
 const positions=recent.filter(e=>e.kind==='player.input'&&(e.data||e.body)?.type==='player.transform').slice(-15);
 const gameEvents=recent.filter(e=>e.kind==='game.event'||(e.data||e.body)?.type==='game.event').slice(-15);
 return <div className="grid lg:grid-cols-3 gap-4">
  <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 space-y-4"><h3 className="text-lg font-semibold">Posición 3D</h3><p className="text-xs text-slate-400">Transformaciones manuales persistidas como eventos en Neon.</p><div className="grid grid-cols-2 gap-3">{Object.keys(coords).map(axis=><label className="text-xs text-slate-400" key={axis}>{axis.toUpperCase()}<input className={input} type="number" step="0.1" value={coords[axis]} onChange={e=>setCoords(v=>({...v,[axis]:Number(e.target.value)}))}/></label>)}</div><button className={btn} disabled={!enabled} onClick={()=>emit('player.input',{type:'player.transform',...coords})}>Publicar posición</button><div className="text-xs text-slate-400 space-y-1 max-h-24 overflow-auto">{positions.map(e=><p key={e.id}>{e.sender_name}: {JSON.stringify(e.data||e.body)}</p>)}</div></section>
  <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 space-y-4"><h3 className="text-lg font-semibold">Eventos</h3><p className="text-xs text-slate-400">Eventos compartidos entre participantes. Los invitados envían entradas, no eventos autoritativos.</p><input className={input} value={kind} onChange={e=>setKind(e.target.value)} placeholder="Nombre del evento"/><textarea className={input+' h-24 font-mono text-xs'} value={payload} onChange={e=>setPayload(e.target.value)}/><button className={btn} disabled={!enabled} onClick={()=>{try{const data={type:'game.event',event:kind,payload:JSON.parse(payload)};emit(isHost?'game.event':'player.input',data)}catch(e){setError('JSON inválido: '+e.message)}}}>Emitir evento</button><div className="text-xs text-slate-400 max-h-24 overflow-auto space-y-1">{gameEvents.map(e=><p key={e.id}>{e.sender_name}: {JSON.stringify(e.data||e.body)}</p>)}</div></section>
  <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 space-y-4"><h3 className="text-lg font-semibold">Voz WebRTC</h3><p className="text-xs text-slate-400">Audio directo entre navegadores en esta sala persistente. Activá el micrófono en ambos dispositivos. Sin audio espacial ni servidor TURN garantizado.</p><div className="text-sm text-emerald-300">{voiceStatus}</div><div className="flex gap-2 flex-wrap"><button className={btn} disabled={!enabled||micOn} onClick={start}>Activar micrófono</button><button className={secondary} disabled={!micOn} onClick={stop}>Desactivar</button></div><p className="text-xs text-slate-400">Conexiones de voz: {remotePeers.length}</p>{error&&<p role="alert" className="text-xs text-red-300 break-words">{error}</p>}</section>
 </div>
}
