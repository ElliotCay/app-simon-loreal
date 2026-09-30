const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
class Element {
 constructor(){this.children=[];this.dataset={};this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.listeners={};this.hidden=false;this.disabled=false;this.value='';this.textContent='';}
 append(e){this.children.push(e)} replaceChildren(){this.children=[]} setAttribute(){} addEventListener(n,f){this.listeners[n]=f} focus(){} remove(){} get firstElementChild(){return this.children[0]}
}
const source=n=>readFileSync(`${__dirname}/../${n}`,'utf8');
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
// Seven targets on screen at 650 ms: three good, a fourth and fifth good, two bad. One more bad later.
const TARGETS=[[0,1300,0],[100,1300,1],[200,1300,2],[300,1300,0],[400,1300,1],[500,1300,3],[600,1300,5],[2000,1000,4]];
async function main(){
 let now=0,frame; const ids=new Map();const el=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id)};
 const storage=new Map();const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const context=vm.createContext({window:{scrollTo(){}},document:{body:new Element(),getElementById:el,createElement:()=>new Element(),createDocumentFragment:()=>new Element(),querySelectorAll:()=>[],addEventListener(){}},performance:{now:()=>now},requestAnimationFrame:f=>(frame=f,1),cancelAnimationFrame(){},URLSearchParams,location:{search:'?debug=1'},console:{debug(){}},Math,localStorage,AbortSignal});
 for(const file of ['sprites.js','leaderboard.js'])vm.runInContext(source(file),context);
 const calls=[], server={games:true,scores:true,count:0};
 context.fetch=async(url,options={})=>{
  calls.push({url,method:options.method||'GET',options});
  if(url==='/api/games'){ if(!server.games) throw new Error('offline'); return {ok:true,json:async()=>({game_id:`game-${++server.count}`,targets:TARGETS})}; }
  if(url==='/api/scores' && options.method==='POST'){ if(!server.scores) return {ok:false,status:503}; return {ok:true,json:async()=>({score:450,good:5,errors:1,best:450,new_best:true,rank:2,players:9,gap:150})}; }
  if(url==='/api/scores') return {ok:true,json:async()=>[{name:'Ada Lovelace',score:450,is_mine:true}]};
  return {ok:true,json:async()=>({ok:true})};
 };
 const posted=()=>calls.filter(c=>c.url==='/api/scores' && c.method==='POST');
 context.Sprites=context.window.Sprites;context.Leaderboard=context.window.Leaderboard;vm.runInContext(source('game.js'),context);
 const api=context.window.SpyRushDebug;const arena=el('arena');
 const targets=()=>arena.children.flatMap(s=>s.children).filter(e=>e.listeners&&e.listeners.pointerdown).sort((a,b)=>a.dataset.index-b.dataset.index);
 const tap=button=>button.listeners.pointerdown({preventDefault(){}});
 const play=async id=>{id?el(id).listeners.click():el('player-form').listeners.submit({preventDefault(){}});await settle();};
 // The clock advances from the start of the countdown; `at` is the time into the round.
 let origin=0; const go=at=>{now=origin+1800+at;frame(now);};

 assert.equal(api.settings(0).spawnDelay,650);assert.equal(api.settings(30000).spawnDelay,250);assert.equal(api.settings(15000).targetLifetime,1112.5);assert.equal(api.settings(30000).maxTargets,6);
 const drawn=api.buildTargets();assert.ok(drawn.length>=40&&drawn.length<=90);assert.equal(JSON.stringify(drawn[0].slice(0,2)),'[0,1300]');
 assert.ok(drawn.every(([at,life,kind])=>Number.isInteger(at)&&at<30000&&life>=550&&life<=1300&&kind>=0&&kind<6));

 const L=context.Leaderboard;
 assert.equal(L.fullName(' Élodie ','  Dupont-Martin'),'Élodie Dupont-Martin');assert.equal(L.fullName('Jean','D’Ormesson'),'Jean D’Ormesson');
 for(const [first,last] of [['','Dupont'],['Ada',''],['Ada','Lovelace2'],['ada@x.fr','x'],['a'.repeat(20),'b'.repeat(25)]])assert.equal(L.fullName(first,last),'');

 await play();assert.equal(api.getState().running,false,'no round without a first and last name');assert.ok(el('name-error').textContent);assert.equal(calls.length,0);
 el('first-name').value='Ada';el('last-name').value='Lovelace';
 origin=now;await play();assert.equal(api.getState().running,true);assert.equal(el('unranked').hidden,true);
 frame(now);assert.equal(targets().length,0,'no target during the countdown');assert.equal(el('countdown').textContent,3);
 go(650);assert.equal(el('countdown').textContent,'');
 const shown=targets();assert.equal(shown.length,7);
 for(const [i,expected] of [[0,100],[1,200],[2,300],[3,400]]){tap(shown[i]);assert.equal(api.getState().score,expected);}
 assert.equal(api.getState().multiplier,2);assert.equal(el('multiplier').textContent,'×2');
 tap(shown[4]);assert.equal(api.getState().score,600,'fifth good hit in a row is doubled');
 tap(shown[4]);shown[4].listeners.click();assert.equal(api.getState().score,600,'no duplicate hit');
 tap(shown[5]);assert.equal(api.getState().score,450);assert.equal(api.getState().multiplier,1,'an error resets the combo');
 go(1950);assert.equal(api.getState().active,0,'targets expire');assert.equal(api.getState().score,450,'expiry has no penalty');
 go(2000);assert.equal(api.getState().active,1);const stale=targets()[0];go(3000);tap(stale);assert.equal(api.getState().score,450,'an expired target cannot be hit');
 go(30000);assert.equal(api.getState().running,false);assert.equal(el('end').hidden,false);assert.equal(el('final-score').textContent,450);assert.equal(el('best-streak').textContent,5);
 await settle();
 assert.equal(posted().length,1,'automatic submission after a round');
 assert.deepEqual(JSON.parse(posted()[0].options.body),{name:'Ada Lovelace',game_id:'game-1',hits:[[0,650],[1,650],[2,650],[3,650],[4,650],[5,650]]});
 assert.equal(posted()[0].options.credentials,'same-origin');assert.equal(posted()[0].options.cache,'no-store');
 assert.equal(el('record').textContent,'NOUVEAU RECORD PERSONNEL');assert.match(el('standing').textContent,/^2e sur 9 joueurs, à 151 points/);
 assert.equal(el('save').hidden,true);assert.equal(calls.filter(c=>c.url==='/api/session').length,1);

 origin=now;await play('replay');assert.equal(api.getState().score,0);assert.equal(api.getState().errors,0);
 go(650);tap(targets()[0]);origin=now;await play('retry-game');
 assert.equal(api.getState().running,true);assert.equal(api.getState().score,0);assert.equal(api.getState().active,0);assert.equal(el('timer').textContent,'30.0');
 assert.equal(posted().length,1,'restarting does not save an unfinished round');
 go(650);const late=targets()[0];now=origin+1800+30000;tap(late);assert.equal(api.getState().score,0,'deadline rejects click');assert.equal(api.getState().running,false);
 await settle();assert.equal(posted().length,2);

 server.scores=false;origin=now;await play('replay');go(650);tap(targets()[0]);go(30000);await settle();
 assert.equal(el('save').hidden,false,'a failed save can be retried');assert.match(el('submit-status').textContent,/impossible/);
 server.scores=true;el('save').listeners.click();await settle();
 assert.equal(el('save').hidden,true);assert.equal(JSON.parse(posted().at(-1).options.body).game_id,JSON.parse(posted().at(-2).options.body).game_id,'the retry sends the same round');

 server.games=false;const before=posted().length;origin=now;await play('replay');
 assert.equal(api.getState().running,true,'the game stays playable offline');assert.equal(el('unranked').hidden,false);assert.equal(api.getState().round.game_id,null);
 go(30000);await settle();assert.equal(posted().length,before,'an unranked round is never submitted');assert.match(el('submit-status').textContent,/ne compte pas/);
 console.log('PASS: difficulty, local draw, names, countdown, combo, duplicate/late/expired clicks, 30-second deadline, replay, automatic save, save retry, offline round, same-origin API.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
