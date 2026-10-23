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
 await q`CREATE TABLE IF NOT EXISTS connect_events(id bigint generated always as identity primary key,code text references connect_rooms(code),user_id text,kind text,body jsonb,created_at timestamptz default now())`;
 await q`ALTER TABLE connect_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`;
}
const mkhash=p=>{const salt=id();return salt+':'+scryptSync(p,salt,64).toString('hex')};
const check=(p,v)=>{const [s,h]=v.split(':');const a=scryptSync(p,s,64),b=Buffer.from(h,'hex');return a.length===b.length&&timingSafeEqual(a,b)};
const safeEqualSecret=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const sign=(uid,claims={})=>new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setSubject(uid).setIssuedAt().setExpirationTime('7d').sign(key());
export default async function handler(req,res){
 try{
  if(!process.env.DATABASE_URL||!process.env.CONNECT_AUTH_SECRET||process.env.CONNECT_AUTH_SECRET.length<32)return error(res,503,'NEON_NOT_CONFIGURED');
  const q=db();await setup(q);const action=String(req.query.action||'health'),b=req.body||{};
  if(action==='health')return res.json({ok:true,storage:'neon',service:'Braidata Connect'});
  if(action==='bootstrap'){
   if(req.method!=='POST'||!process.env.CONNECT_BOOTSTRAP_KEY||typeof b.bootstrapKey!=='string'||!safeEqualSecret(b.bootstrapKey.trim(),process.env.CONNECT_BOOTSTRAP_KEY.trim()))return error(res,403,'BOOTSTRAP_DENIED');
   if((await q`SELECT id FROM connect_users WHERE role='admin' LIMIT 1`).length)return error(res,409,'ADMIN_EXISTS');
   if(typeof b.email!=='string'||!/^\S+@\S+\.\S+$/.test(b.email)||typeof b.password!=='string'||b.password.length<12)return error(res,400,'INVALID_CREDENTIALS');
   const uid=id(),email=b.email.toLowerCase(),h=mkhash(b.password);
   await q`INSERT INTO connect_users VALUES(${uid},${email},${h},'admin')`;
   return res.status(201).json({email,role:'admin',token:await sign(uid)});
  }
  if(action==='guest-join'){
   if(req.method!=='POST')return error(res,405,'METHOD_NOT_ALLOWED');
   const code=String(b.code||'').trim().toUpperCase(),name=String(b.name||'').trim().slice(0,32);
   if(!/^[A-F0-9]{8}$/.test(code)||name.length<2)return error(res,400,'INVALID_CODE_OR_NAME');
   const existing=await q`SELECT code FROM connect_rooms WHERE code=${code}`;
   if(!existing.length)return error(res,404,'ROOM_NOT_FOUND');
   const guestId=id(),guestEmail='guest-'+guestId+'@connect.internal',guestHash='!guest-disabled';
   await q`INSERT INTO connect_users(id,email,hash,role) VALUES(${guestId},${guestEmail},${guestHash},'guest')`;
   await q`INSERT INTO connect_members(code,user_id,name) VALUES(${code},${guestId},${name})`;
   return res.status(201).json({code,name,role:'guest',userId:guestId,token:await sign(guestId,{room:code,role:'guest'})});
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
  const user=await q`SELECT id,email,role FROM connect_users WHERE id=${uid}`;
  const role=user[0]?.role;
  if(action==='me')return res.json({user:user[0]});
  if(action==='admin-users'){
   if(role!=='admin')return error(res,403,'ADMIN_ONLY');
   const users=await q`SELECT u.id,u.email,u.role,(SELECT COUNT(*)::int FROM connect_members m WHERE m.user_id=u.id) AS memberships,(SELECT COUNT(*)::int FROM connect_rooms r WHERE r.owner=u.id) AS owned_rooms FROM connect_users u ORDER BY u.role='admin' DESC,u.email`;
   return res.json({users});
  }
  if(action==='admin-delete-user'){
   if(req.method!=='POST')return error(res,405,'METHOD_NOT_ALLOWED');
   if(role!=='admin')return error(res,403,'ADMIN_ONLY');
   const target=String(b.userId||'');if(!target||target===uid)return error(res,400,'INVALID_TARGET');
   const users=await q`SELECT id,role FROM connect_users WHERE id=${target}`;
   if(!users.length)return error(res,404,'USER_NOT_FOUND');
   if(users[0].role==='admin')return error(res,403,'ADMIN_PROTECTED');
   if((await q`SELECT code FROM connect_rooms WHERE owner=${target} LIMIT 1`).length)return error(res,409,'USER_OWNS_ROOMS');
   await q`DELETE FROM connect_members WHERE user_id=${target}`;
   await q`DELETE FROM connect_events WHERE user_id=${target}`;
   await q`DELETE FROM connect_users WHERE id=${target}`;
   return res.json({ok:true,deletedUserId:target});
  }
  if(action==='create'){
   if(role==='guest')return error(res,403,'GUEST_CANNOT_CREATE');
   const code=randomBytes(4).toString('hex').toUpperCase(),title=String(b.title||'Room').slice(0,80),name=String(b.name||'Host').slice(0,32);
   await q`INSERT INTO connect_rooms(code,owner,title) VALUES(${code},${uid},${title})`;
   await q`INSERT INTO connect_members VALUES(${code},${uid},${name})`;
   return res.status(201).json({code,title});
  }
  const code=String(req.query.code||b.code||'').toUpperCase();
  const rooms=await q`SELECT * FROM connect_rooms WHERE code=${code}`;
  if(!rooms.length)return error(res,404,'UNKNOWN_ROOM');
  const host=rooms[0].owner===uid;
  if(j.payload.role==='guest'&&j.payload.room!==code)return error(res,403,'GUEST_ROOM_SCOPE');
  if(action==='join'){
   if(role==='guest')return error(res,403,'GUEST_CANNOT_JOIN_ANOTHER_ROOM');
   const name=String(b.name||'Guest').slice(0,32);
   await q`INSERT INTO connect_members VALUES(${code},${uid},${name}) ON CONFLICT(code,user_id) DO UPDATE SET name=EXCLUDED.name`;
   return res.json({code,host});
  }
  if(!(await q`SELECT user_id FROM connect_members WHERE code=${code} AND user_id=${uid}`).length)return error(res,403,'JOIN_REQUIRED');
  if(action==='room')return res.json({room:rooms[0],host,role,currentUser:user[0],players:await q`SELECT m.user_id,m.name,u.role FROM connect_members m JOIN connect_users u ON u.id=m.user_id WHERE m.code=${code} ORDER BY m.name`});
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
  if(action==='kick'){
   if(!host)return error(res,403,'HOST_ONLY');
   const target=String(b.userId||'');if(!target||target===uid)return error(res,400,'INVALID_TARGET');
   await q`DELETE FROM connect_members WHERE code=${code} AND user_id=${target}`;
   return res.json({ok:true});
  }
  if(action==='publish'){
   if(req.method!=='POST')return error(res,405,'METHOD_NOT_ALLOWED');
   if(role==='guest'&&b.kind==='game.event')return error(res,403,'GUEST_EVENT_RESTRICTED');
   if(!['chat.message','player.input','game.event'].includes(b.kind))return error(res,400,'INVALID_EVENT');
   const payload=JSON.stringify(b.data||{});if(payload.length>2000)return error(res,413,'TOO_LARGE');
   const kind=b.kind;const r=await q`INSERT INTO connect_events(code,user_id,kind,body) VALUES(${code},${uid},${kind},${payload}::jsonb) RETURNING id::text`;
   return res.status(201).json({id:r[0].id});
  }
  if(action==='events'){
   if(req.method!=='GET')return error(res,405,'METHOD_NOT_ALLOWED');
   const since=String(req.query.since||'0');if(!/^\d+$/.test(since))return error(res,400,'INVALID_CURSOR');
   const events=await q`SELECT e.id::text,e.user_id,e.kind,e.body AS data,e.created_at,COALESCE(m.name,'Former participant') AS sender_name FROM connect_events e LEFT JOIN connect_members m ON m.code=e.code AND m.user_id=e.user_id WHERE e.code=${code} AND e.id>${since}::bigint ORDER BY e.id LIMIT 100`;
   return res.json({events,next:events.at(-1)?.id||since});
  }
  return error(res,404,'UNKNOWN_ACTION');
 }catch(e){return error(res,500,'CONNECT_ERROR')}
}
