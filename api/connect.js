import {neon} from '@neondatabase/serverless';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {SignJWT,jwtVerify} from 'jose';
const id=()=>randomBytes(12).toString('hex');
const db=()=>neon(process.env.DATABASE_URL);
const key=()=>new TextEncoder().encode(process.env.CONNECT_AUTH_SECRET);
const error=(res,n,message)=>res.status(n).json({error:message});
async function setup(q){
 await q`CREATE TABLE IF NOT EXISTS connect_users(id text primary key,email text unique not null,hash text not null,role text not null)`;
 await q`CREATE TABLE IF NOT EXISTS connect_rooms(code text primary key,owner text references connect_users(id),title text,epoch int default 0,snapshot jsonb default '{}'::jsonb)`;
 await q`CREATE TABLE IF NOT EXISTS connect_members(code text references connect_rooms(code),user_id text references connect_users(id),name text,primary key(code,user_id))`;
 await q`CREATE TABLE IF NOT EXISTS connect_events(id bigint generated always as identity primary key,code text references connect_rooms(code),user_id text,kind text,body jsonb)`;
}
const mkhash=p=>{const salt=id();return salt+':'+scryptSync(p,salt,64).toString('hex')};
const check=(p,v)=>{const [s,h]=v.split(':');const a=scryptSync(p,s,64),b=Buffer.from(h,'hex');return a.length===b.length&&timingSafeEqual(a,b)};
const sign=uid=>new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(uid).setIssuedAt().setExpirationTime('7d').sign(key());
export default async function handler(req,res){
 try{
  if(!process.env.DATABASE_URL||!process.env.CONNECT_AUTH_SECRET||process.env.CONNECT_AUTH_SECRET.length<32)return error(res,503,'NEON_NOT_CONFIGURED');
  const q=db();await setup(q);const action=String(req.query.action||'health'),b=req.body||{};
  if(action==='health')return res.json({ok:true,storage:'neon',service:'Braidata Connect'});
  if(action==='bootstrap'){
   if(req.method!=='POST'||!process.env.CONNECT_BOOTSTRAP_KEY||b.bootstrapKey!==process.env.CONNECT_BOOTSTRAP_KEY)return error(res,403,'BOOTSTRAP_DENIED');
   if((await q`SELECT id FROM connect_users WHERE role='admin' LIMIT 1`).length)return error(res,409,'ADMIN_EXISTS');
   if(typeof b.email!=='string'||!/^\S+@\S+\.\S+$/.test(b.email)||typeof b.password!=='string'||b.password.length<12)return error(res,400,'INVALID_CREDENTIALS');
   const uid=id(),email=b.email.toLowerCase(),h=mkhash(b.password);
   await q`INSERT INTO connect_users VALUES(${uid},${email},${h},'admin')`;
   return res.status(201).json({email,role:'admin',token:await sign(uid)});
  }
  if(action==='login'){
   const email=String(b.email||'').toLowerCase();
   const u=await q`SELECT * FROM connect_users WHERE email=${email}`;
   if(!u.length||typeof b.password!=='string'||!check(b.password,u[0].hash))return error(res,401,'INVALID_LOGIN');
   return res.json({token:await sign(u[0].id),email,role:u[0].role});
  }
  const auth=String(req.headers.authorization||'');
  if(!auth.startsWith('Bearer '))return error(res,401,'AUTH_REQUIRED');
  const j=await jwtVerify(auth.slice(7),key()).catch(()=>null);if(!j)return error(res,401,'BAD_TOKEN');
  const uid=j.payload.sub;
  if(!(await q`SELECT id FROM connect_users WHERE id=${uid}`).length)return error(res,401,'UNKNOWN_USER');
  if(action==='create'){
   const code=randomBytes(4).toString('hex').toUpperCase(),title=String(b.title||'Room').slice(0,80),name=String(b.name||'Host').slice(0,32);
   await q`INSERT INTO connect_rooms(code,owner,title) VALUES(${code},${uid},${title})`;
   await q`INSERT INTO connect_members VALUES(${code},${uid},${name})`;
   return res.status(201).json({code,title});
  }
  const code=String(req.query.code||b.code||'').toUpperCase();
  const rooms=await q`SELECT * FROM connect_rooms WHERE code=${code}`;
  if(!rooms.length)return error(res,404,'UNKNOWN_ROOM');
  const host=rooms[0].owner===uid;
  if(action==='join'){
   const name=String(b.name||'Guest').slice(0,32);
   await q`INSERT INTO connect_members VALUES(${code},${uid},${name}) ON CONFLICT(code,user_id) DO UPDATE SET name=EXCLUDED.name`;
   return res.json({code,host});
  }
  if(!(await q`SELECT user_id FROM connect_members WHERE code=${code} AND user_id=${uid}`).length)return error(res,403,'JOIN_REQUIRED');
  if(action==='room')return res.json({room:rooms[0],players:await q`SELECT user_id,name FROM connect_members WHERE code=${code}`});
  if(action==='resume'){
   if(!host)return error(res,403,'HOST_ONLY');
   const r=await q`UPDATE connect_rooms SET epoch=epoch+1 WHERE code=${code} RETURNING epoch,snapshot`;
   return res.json({code,...r[0]});
  }
  if(action==='snapshot'){
   if(!host)return error(res,403,'HOST_ONLY');
   const state=JSON.stringify(b.state||{});if(state.length>16000)return error(res,413,'SNAPSHOT_TOO_LARGE');
   await q`UPDATE connect_rooms SET snapshot=${state}::jsonb WHERE code=${code}`;return res.json({ok:true});
  }
  if(action==='publish'){
   if(!['chat.message','player.input','game.event'].includes(b.kind))return error(res,400,'INVALID_EVENT');
   const payload=JSON.stringify(b.data||{});if(payload.length>2000)return error(res,413,'TOO_LARGE');
   const kind=b.kind;const r=await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},${kind},${payload}::jsonb) RETURNING id::text`;
   return res.status(201).json({id:r[0].id});
  }
  if(action==='events'){
   const since=String(req.query.since||'0');if(!/^\d+$/.test(since))return error(res,400,'INVALID_CURSOR');
   const events=await q`SELECT id::text,user_id,kind,body FROM connect_events WHERE code=${code} AND id>${since}::bigint ORDER BY id LIMIT 100`;
   return res.json({events,next:events.at(-1)?.id||since});
  }
  return error(res,404,'UNKNOWN_ACTION');
 }catch(e){return error(res,500,'CONNECT_ERROR')}
}
