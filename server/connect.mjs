import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const rooms = new Map();
const clients = new Map();
const PORT = Number(process.env.PORT || 8787);
const ORIGIN = process.env.CONNECT_ORIGIN || '*';
const MAX_BODY = 16_384;
const now = () => Date.now();
const id = (n=12) => randomBytes(n).toString('hex');
const code = () => randomBytes(4).toString('hex').toUpperCase();
const json = (res,status,data) => { res.writeHead(status, {'content-type':'application/json','access-control-allow-origin':ORIGIN,'access-control-allow-headers':'content-type,x-connect-token','access-control-allow-methods':'GET,POST,OPTIONS','cache-control':'no-store'});res.end(JSON.stringify(data)); };
function err(status,message){const e=new Error(message);e.status=status;throw e;}
function roomFor(c){const r=rooms.get(c?.toUpperCase());if(!r)err(404,'Room not found');return r;}
function auth(r,t){const p=r.players.get(t);if(!p)err(403,'Invalid participant token');return p;}
function publicPlayers(r){return [...r.players.values()].map(({token,...rest})=>rest);}
function emit(r,type,payload){const e={schema:'braidata.connect.event.v1',type,roomId:r.code,seq:++r.seq,at:now(),payload};r.events.push(e);if(r.events.length>100)r.events.shift();for(const c of r.streams){try{c.write('id: '+e.seq+'\nevent: message\ndata: '+JSON.stringify(e)+'\n\n');}catch{r.streams.delete(c);}}return e;}
function parse(req){return new Promise((resolve,reject)=>{let size=0;const a=[];req.on('data',b=>{size+=b.length;if(size>MAX_BODY){reject(Object.assign(new Error('Payload too large'),{status:413}));req.destroy();}else a.push(b);});req.on('end',()=>{try{resolve(a.length?JSON.parse(Buffer.concat(a).toString()):{});}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}));}});req.on('error',reject);});}
const server=createServer(async(req,res)=>{
 try{
  if(req.method==='OPTIONS')return json(res,204,{});
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health')return json(res,200,{ok:true,service:'Braidata Connect',schema:'braidata.connect.v1',rooms:rooms.size});
  if(u.pathname==='/api/rooms'&&req.method==='POST'){
   const b=await parse(req),capacity=Math.min(8,Math.max(2,Number(b.maxPlayers)||4));
   let c=code();while(rooms.has(c))c=code();
   const hostToken=id(), host={id:id(6),name:String(b.name||'Host').slice(0,32),role:'host',peerId:null,x:0,y:0,z:0,ry:0,ready:false,joinedAt:now(),token:hostToken};
   const r={code:c,name:String(b.title||'Connect Playground').slice(0,80),hostToken,capacity,players:new Map([[hostToken,host]]),streams:new Set(),events:[],seq:0,createdAt:now(),updatedAt:now()};
   rooms.set(c,r);return json(res,201,{room:state(r),token:hostToken,participantId:host.id});
  }
  const m=u.pathname.match(/^\/api\/rooms\/([A-F0-9]{8})(?:\/([a-z-]+))?$/i);
  if(!m)err(404,'Unknown endpoint');
  const r=roomFor(m[1]),action=m[2]||'state';
  if(req.method==='GET'&&action==='state')return json(res,200,{room:state(r)});
  if(req.method==='POST'&&action==='join'){
    const b=await parse(req);
    if(r.players.size>=r.capacity)err(409,'Room full');
    const token=id(),p={id:id(6),name:String(b.name||'Guest').trim().slice(0,32)||'Guest',role:'player',peerId:null,x:0,y:0,z:0,ry:0,ready:false,joinedAt:now(),token};
    r.players.set(token,p);r.updatedAt=now();emit(r,'presence.join',{player:withoutToken(p)});return json(res,200,{room:state(r),token,participantId:p.id});
  }
  const token=req.headers['x-connect-token']||u.searchParams.get('token'),p=auth(r,token);
  if(req.method==='GET'&&action==='events'){
    res.writeHead(200,{'content-type':'text/event-stream','access-control-allow-origin':ORIGIN,'cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
    res.write('retry: 2000\n\n');r.streams.add(res);
    const last=Number(u.searchParams.get('last')||0);
    res.write('event: snapshot\ndata: '+JSON.stringify({room:state(r)})+'\n\n');
    for(const e of r.events.filter(e=>e.seq>last))res.write('id: '+e.seq+'\nevent: message\ndata: '+JSON.stringify(e)+'\n\n');
    const ping=setInterval(()=>res.write(': keepalive\n\n'),15000);
    req.on('close',()=>{clearInterval(ping);r.streams.delete(res);});return;
  }
  if(req.method!=='POST')err(405,'Method not allowed');
  const b=await parse(req);
  if(action==='message'){
   const message=String(b.text||'').trim().slice(0,500);if(!message)err(400,'Empty message');
   emit(r,'chat.message',{from:p.id,name:p.name,text:message,channel:'room'});
  }else if(action==='state'){
   p.x=clamp(b.x);p.y=clamp(b.y);p.z=clamp(b.z);p.ry=clamp(b.ry);p.ready=Boolean(b.ready);r.updatedAt=now();
   emit(r,'player.state',{id:p.id,x:p.x,y:p.y,z:p.z,ry:p.ry,ready:p.ready});
  }else if(action==='peer'){
   p.peerId=String(b.peerId||'').slice(0,128)||null;emit(r,'presence.peer',{id:p.id,peerId:p.peerId});
  }else if(action==='game-event'){
   const kind=String(b.kind||'').slice(0,64);if(!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind))err(400,'Invalid event');
   emit(r,'game.event',{from:p.id,kind,data:typeof b.data==='object'&&b.data!==null?b.data:{}});
  }else if(action==='leave'){
   r.players.delete(token);emit(r,'presence.leave',{id:p.id});
   if(!r.players.size){rooms.delete(r.code);for(const s of r.streams)s.end();}
  }else err(404,'Unknown action');
  return json(res,200,{ok:true});
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Internal server error'});}
});
function clamp(v){const n=Number(v);return Number.isFinite(n)?Math.max(-10000,Math.min(10000,n)):0;}
function withoutToken(p){const {token,...rest}=p;return rest;}
function state(r){return {code:r.code,name:r.name,capacity:r.capacity,players:publicPlayers(r),createdAt:r.createdAt,updatedAt:r.updatedAt,seq:r.seq};}
const sweep=setInterval(()=>{for(const [key,r] of rooms)if(now()-r.updatedAt>2*60*60*1000){for(const s of r.streams)s.end();rooms.delete(key);}},60000);
server.on('close',()=>clearInterval(sweep));
server.listen(PORT,()=>console.log('Braidata Connect API listening on '+PORT));
