const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
class Element {
 constructor(){this.children=[];this.dataset={};this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.listeners={};this.hidden=false;this.disabled=false;this.value='';}
 append(e){this.children.push(e)} replaceChildren(){this.children=[]} setAttribute(){} addEventListener(n,f){this.listeners[n]=f} focus(){} remove(){} get firstElementChild(){return this.children[0]}
}
const source=n=>readFileSync(`${__dirname}/../${n}`,'utf8');
async function main(){
 let now=0,frame,random=.1, rng=[]; const ids=new Map();const el=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id)};
 const storage=new Map();const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const context=vm.createContext({window:{scrollTo(){}},document:{getElementById:el,createElement:()=>new Element(),querySelectorAll:()=>[],addEventListener(){}},performance:{now:()=>now},requestAnimationFrame:f=>(frame=f,1),cancelAnimationFrame(){},URLSearchParams,location:{search:'?debug=1'},console:{debug(){}},Math:Object.assign(Object.create(Math),{random:()=>rng.length?rng.shift():random}),localStorage,crypto:require('node:crypto').webcrypto,AbortSignal});
 for(const file of ['sprites.js','leaderboard.js'])vm.runInContext(source(file),context);
 const calls=[], attempts=[];
 context.fetch=async(url,options={})=>{
  calls.push({url,options});
  let data={ok:true};
  if(url==='/api/attempts' && options.method==='POST'){
    const body=JSON.parse(options.body); data=attempts.find(r=>r.attempt_id===body.attempt_id);
    if(!data){data={...body,id:attempts.length+1,created_at:new Date().toISOString(),is_mine:true};attempts.push(data);}
  } else if(url==='/api/attempts') data=[...attempts].sort((a,b)=>b.score-a.score);
  return {ok:true,json:async()=>data};
 };
 context.Sprites=context.window.Sprites;context.Leaderboard=context.window.Leaderboard;vm.runInContext(source('game.js'),context);
 const api=context.window.SpyRushDebug;const arena=el('arena'); el('player-name').value='Auto Agent'; const play=()=>el('player-form').listeners.submit({preventDefault(){}});
 assert.equal(api.settings(0).spawnDelay,900);assert.equal(api.settings(30000).spawnDelay,250);assert.equal(api.settings(15000).targetLifetime,1337.5);assert.equal(api.settings(30000).maxTargets,6);
 // Each random value selects a different one of the six types.
 for(const [r,points] of [[0,100],[1,100],[2,100],[3,-150],[4,-150],[5,-200]]){
  rng=[.1,r<3?.1:.9,r<3?(r+.1)/3:(r-3+.1)/3];play();frame(now);const button=arena.children.flatMap(s=>s.children)[0];assert.ok(button);button.listeners.click();assert.equal(api.getState().score,points);button.listeners.click();assert.equal(api.getState().score,points,'no duplicate hit');
 }
 play();frame(now);now+=1700;frame(now);assert.equal(api.getState().score,0,'expiry has no penalty');
 now+=28300;frame(now);assert.equal(api.getState().running,false);assert.equal(el('end').hidden,false);
 assert.equal(el('replay').disabled,false,'retry stays available during automatic save');
 el('replay').listeners.click();assert.equal(api.getState().score,0);assert.equal(api.getState().errors,0);
 frame(now);const late=arena.children.flatMap(s=>s.children)[0];now+=30000;late.listeners.click();assert.equal(api.getState().score,0,'deadline rejects click');assert.equal(api.getState().running,false);
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok((await context.Leaderboard.getAttempts()).some(r=>r.name==='Auto Agent'),'automatic submission after a round');
 const id=()=>require('node:crypto').randomUUID();
 const saved=await context.Leaderboard.submitScore(' Test ',300,id());assert.equal(saved.name,'Test');
 await context.Leaderboard.submitScore('Test',100,id());
 await context.Leaderboard.submitScore('Test',450,id());
 const records=(await context.Leaderboard.getAttempts()).filter(r=>r.name==='Test');assert.equal(records.length,3);assert.equal(records[0].score,450);
 await assert.rejects(()=>context.Leaderboard.submitScore(' ',10,id()));await assert.rejects(()=>context.Leaderboard.submitScore('Agent',20001,id()));
 const round=id();await context.Leaderboard.submitScore('Retry',100,round);await context.Leaderboard.submitScore('Retry',100,round);
 assert.equal(attempts.filter(r=>r.attempt_id===round).length,1);
 const post=calls.find(c=>c.url==='/api/attempts' && c.options.method==='POST');
 assert.equal(post.options.credentials,'same-origin');assert.equal(post.options.cache,'no-store');assert.ok(JSON.parse(post.options.body).attempt_id);
 assert.equal(calls.filter(c=>c.url==='/api/session').length,1);
 console.log('PASS: six target scores, duplicate/late clicks, expiry, 30-second deadline, replay, difficulty, all attempts, automatic save, retry identifier, same-origin API.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
