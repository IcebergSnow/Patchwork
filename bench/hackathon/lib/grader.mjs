import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, delay, root } from './common.mjs';

async function port() {const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export function gradingProfile(candidate,data) {
  return `(version 1)
(allow default)
(deny file-read* (subpath "/Users") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath ${JSON.stringify(root)}))
(allow file-read-metadata)
(allow file-read* (subpath ${JSON.stringify(candidate)}) (subpath ${JSON.stringify(data)}))
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(data)}) (literal "/dev/null"))
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny process-info* (target others))
`;
}
export async function grade(candidate,dir) {
  if(process.platform!=='darwin')throw new Error('Deterministic grading requires macOS sandbox-exec; no unisolated fallback.');
  await mkdir(dir,{recursive:true});const data=path.join(dir,'data');await mkdir(data,{recursive:true});
  const db=path.join(data,'bookings.sqlite'),profile=path.join(dir,'grading.sb');
  await writeFile(profile,gradingProfile(candidate,data),{mode:0o600});
  const p=await port(),base=`http://127.0.0.1:${p}`;
  const env={PATH:process.env.PATH,HOME:data,TMPDIR:data+'/',PORT:String(p),DB_PATH:db,NO_COLOR:'1'};
  let child,stderr='';const results=[];
  async function stop(){if(!child)return;try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}await new Promise(r=>{if(child.exitCode!==null||child.signalCode)r();else child.once('close',r);});child=null;}
  async function start(){child=spawn('/usr/bin/sandbox-exec',['-f',profile,process.execPath,'server/main.mjs'],{cwd:candidate,env,detached:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>{if(stderr.length<4000)stderr+=b;});child.on('error',()=>{});
    for(let i=0;i<50;i++){try{await fetch(base+'/api/slots',{signal:AbortSignal.timeout(300)});return;}catch{}if(child.exitCode!==null)break;await delay(100);}throw new Error('Application did not become ready.');}
  async function request(route,body){const r=await fetch(base+route,{...(body!==undefined&&{method:'POST',headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)});return {status:r.status,body:await r.json()};}
  const assert=(value,message)=>{if(!value)throw new Error(message);};
  async function check(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message});}}
  const deadline=setTimeout(()=>{if(child)try{process.kill(-child.pid,'SIGKILL');}catch{}},45000);
  try {
    await start();
    await check('slot contract',async()=>{const r=await request('/api/slots');assert(r.status===200&&r.body.slots.length===3&&['s1','s2','s3'].every(id=>r.body.slots.some(s=>s.slotId===id&&typeof s.label==='string'&&s.available===true)),'Expected stable camelCase slots with availability.');});
    await check('create and list booking',async()=>{const r=await request('/api/bookings',{slotId:'s1',name:'Ada'});assert(r.status===201&&r.body.booking?.id&&r.body.booking.slotId==='s1'&&r.body.booking.name==='Ada','Booking POST contract failed.');const list=await request('/api/bookings');assert(list.status===200&&list.body.bookings.some(b=>b.id===r.body.booking.id),'Booking is absent from GET.');});
    await check('validation',async()=>{for(const body of [{slotId:'s2',name:'  '},{slotId:'missing',name:'Ada'},'{broken']){const r=await request('/api/bookings',body);assert(r.status===400&&typeof r.body.error==='string','Invalid input must return JSON 400.');}});
    await check('atomic conflict handling',async()=>{const rs=await Promise.all(['Grace','Lin'].map(name=>request('/api/bookings',{slotId:'s2',name})));assert(rs.map(r=>r.status).sort().join(',')==='201,409','Concurrent booking must have exactly one success.');const r=await request('/api/bookings',{slotId:'s1',name:'Again'});assert(r.status===409,'Duplicate booking must return 409.');});
    await check('frontend page and module wiring',async()=>{const page=await (await fetch(base+'/',{signal:AbortSignal.timeout(3000)})).text();for(const id of ['slot','name','booking-form','message'])assert(new RegExp(`id=["']${id}["']`).test(page),`Missing UI selector ${id}.`);assert(/type=["']module["']/.test(page),'Missing module script.');const js=await (await fetch(base+'/app.js',{signal:AbortSignal.timeout(3000)})).text();assert((/\bcreateBooking\s*\(/.test(js))&&(/\bloadSlots\s*\(/.test(js))&&js.includes('submit'),'Frontend not wired to API/form.');});
    await check('frontend client against real HTTP',async()=>{
      const script=`const original=fetch;globalThis.fetch=(url,options)=>original(new URL(url,${JSON.stringify(base)}),options);const api=await import(${JSON.stringify(pathToFileURL(path.join(candidate,'public/api.mjs')).href)});const slots=await api.loadSlots();if(!Array.isArray(slots)||!slots.some(s=>s.slotId==='s3'))throw Error('loadSlots contract');const b=await api.createBooking('s3','Frontend');if(!b.id||b.slotId!=='s3')throw Error('createBooking contract');let rejected=false;try{await api.createBooking('missing','Invalid')}catch(e){rejected=!!e.message}if(!rejected)throw Error('API errors must reject');`;
      await command('/usr/bin/sandbox-exec',['-f',profile,process.execPath,'--input-type=module','-e',script],{cwd:candidate,env,timeout:8000});
    });
    await check('persistent bookings after restart',async()=>{const before=await request('/api/bookings');assert(before.body.bookings?.length===3,'Expected three successful integrated bookings.');await stop();await start();const after=await request('/api/bookings');assert(JSON.stringify(after.body.bookings)===JSON.stringify(before.body.bookings),'Bookings changed after restart.');});
    await check('SQLite and availability integration',async()=>{const data=await readFile(db);assert(data.subarray(0,16).toString()==='SQLite format 3\0','Storage is not SQLite.');const r=await request('/api/slots');assert(r.body.slots.length===3&&r.body.slots.every(s=>s.available===false),'Availability did not reflect persistent bookings.');});
  } catch(e){results.push({name:'application startup',pass:false,error:e.message});}
  finally{clearTimeout(deadline);await stop();}
  return {passed:results.filter(r=>r.pass).length,total:8,checks:results,allPassed:results.length===8&&results.every(r=>r.pass),stderr,
    limitations:['UI selectors and module wiring are smoke-tested; this is not a full browser usability test.','The grader measures the submitted main snapshot and does not repair it.']};
}
