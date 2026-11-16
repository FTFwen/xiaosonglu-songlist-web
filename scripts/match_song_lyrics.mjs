import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd(), dir=path.join(root,'data/lyrics');
for(const p of ['','sources','tracks'])fs.mkdirSync(path.join(dir,p),{recursive:true});
const catalog=JSON.parse(fs.readFileSync('data/xiaosonglu/song_catalog.json','utf8')).songs;
const audios=JSON.parse(fs.readFileSync('data/xiaosonglu/audio_index.json','utf8')).audios;
const app=fs.readFileSync('js/app.js','utf8');const block=app.slice(app.indexOf('const DERIVATIVE_TRACKS'),app.indexOf('].map(([songName'));
const derivatives=[...block.matchAll(/\['([^']*)',\s*'([^']*)',\s*'([^']+\.mp3)',\s*'([0-9a-f]+)'\]/g)].map((m,i)=>({song_id:-1101-i,song_name:'小松绿-'+m[1],display_song_name:m[1],artist:'白烁',language:'',audio:'assets/derivative/'+m[3]+'?v='+m[4],derivative:true}));
const rows=[...catalog,...derivatives];
const H={Referer:'https://music.163.com/','User-Agent':'Mozilla/5.0'};
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/official|乐团/gu,'').replace(/[\s\p{P}\p{S}]/gu,'');
const clean=x=>String(x).replace(/^小松绿-/u,'').replace(/^（区）/u,'').replace(/[（(](?:半首|第[一二三]遍)[）)]/giu,'').trim();
const aliases={194:'秒針を噛む',26:'カタオモイ',28:'月が綺麗ね',146:'最终祈愿',190:'小夜子 中文填词',242:'神的随波逐流 泠鸢',278:'Mystic Light Quest',73:'モア！ジャンプ！モア！',357:'追憶'};
const works={'江南':['江南','林俊杰'],'失落沙洲':['失落沙洲','徐佳莹'],'春天的芭蕾':['春天的芭蕾','常思思'],'心墙':['心墙','郭静'],'单相思':['カタオモイ','Aimer'],'天狼星的心脏':['シリウスの心臓','ヰ世界情緒'],'茉莉雨':['茉莉雨','林俊杰'],'マリーの架空世界':['マリーの架空世界','じん']};
const reviewIds=new Set([17,76,77,128,132,190,191,242,145,160,158,252]);
function parse(text){let out=[];for(const l of String(text||'').split(/\r?\n/)){const body=l.replace(/\[[^\]]*\]/g,'').trim();if(!body)continue;for(const m of l.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g))out.push({t:Number(m[1])*60+Number(m[2])+(m[3]?Number(m[3].padEnd(3,'0'))/1000:0),text:body});}return out.sort((a,b)=>a.t-b.t)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){let err;for(let n=0;n<3;n++){try{const r=await fetch(url,{headers:H,signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.code&&j.code!==200)throw Error('API '+j.code);await sleep(220);return j}catch(e){err=e;await sleep(1000*(n+1));}}throw err}
function rank(s,t){const title=norm(clean(s.song_name)),ct=norm(t.name);let titleScore=title===ct?1:ct.startsWith(title)||title.startsWith(ct)?0.7:0;const names=(t.artists||t.ar||[]).map(x=>x.name);const tokens=String(s.artist||'').split(/[\/、,，()（）]/).map(norm).filter(x=>x.length>=2);const am=tokens.some(x=>names.some(a=>norm(a).includes(x)||x.includes(norm(a))));return {titleScore,artistMatch:am,score:titleScore*.8+(am?.2:0)}}
function save(file,obj){fs.writeFileSync(file,JSON.stringify(obj,null,2)+'\n')}
function special(s){return reviewIds.has(s.song_id)||/中文填词|中文版/.test([s.song_name,s.display_version].join(' '));}
const reviewed=new Set(fs.existsSync(path.join(dir,'overrides.json'))?JSON.parse(fs.readFileSync(path.join(dir,'overrides.json'),'utf8')).map(x=>x.key):[]);
function languageConflict(s,source){return /中文/.test(s.language||'')&&(source.lines.map(x=>x.text).join('').match(/[\u3040-\u30ff]/g)||[]).length>=8;}
const manifest=[];const force=process.argv.includes('--force');const retry=process.argv.includes('--retry');
for(let i=0;i<rows.length;i++){
 const s=rows[i],key=(s.derivative?'derivative-':'song-')+Math.abs(s.song_id),file=path.join(dir,'tracks',key+'.json');
 if(fs.existsSync(file)&&(reviewed.has(key)||(!force&&!(retry&&['not_found','no_timed_lyrics','fetch_error','candidate_review_required'].includes(JSON.parse(fs.readFileSync(file,'utf8')).match.status))))){const old=JSON.parse(fs.readFileSync(file,'utf8'));old.rowKey=s.row_key||s.song_name;old.edition=s.display_version||'';old.remark=s.remark||'';const url=s.audio||audios[s.row_key||s.song_name]||'',local=url.split('?')[0],sha=local&&fs.existsSync(local)?crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex'):null;if(old.audio?.sha256!==sha||old.audio?.url!==url){old.audio={url,sha256:sha};old.alignment={status:sha&&old.match.sourcePath?'pending_asr':'unavailable',offsetSeconds:null,humanVerified:false};}if(special(s)){old.match.status='version_review_required';old.alignment={status:'version_review_required',offsetSeconds:null,humanVerified:false};}save(file,old);manifest.push(old);continue;}
 const audioUrl=s.audio||audios[s.row_key||s.song_name]||'', local=audioUrl.split('?')[0];
 const record={schemaVersion:1,key,songId:s.song_id,songName:s.song_name,rowKey:s.row_key||s.song_name,displaySongName:s.display_song_name||s.song_name,artist:s.artist,language:s.language,derivative:!!s.derivative,edition:s.display_version||'',remark:s.remark||'',audio:{url:audioUrl,sha256:local&&fs.existsSync(local)?crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex'):null},retrievedAt:new Date().toISOString(),match:{status:'unsearched'},alignment:{status:'not_started',offsetSeconds:null,humanVerified:false}};
 try{
 const base=clean(s.song_name);const inferred=s.derivative?catalog.find(x=>clean(x.song_name)===base&&x.artist):null;
 const work=s.derivative?works[base]:null;const searchSong={...s,song_name:work?.[0]||(!special(s)&&aliases[s.song_id])||base,artist:work?.[1]||inferred?.artist||(s.derivative?'':s.artist)};
 const q=work?.[0]||aliases[s.song_id]||base;const queries=[q];const hint=String(searchSong.artist||'').split(/[,，、（(]/)[0].trim();if(hint)queries.push(q+' '+hint);
 if(norm(clean(s.display_song_name||''))!==norm(q))queries.push(clean(s.display_song_name));
 const urls=[];let found=[];
 for(const query of [...new Set(queries)]){const u='https://music.163.com/api/search/get?s='+encodeURIComponent(query)+'&type=1&limit=20&offset=0';urls.push(u);const j=await get(u);found.push(...(j.result?.songs||[]));}
 found=[...new Map(found.map(t=>[t.id,t])).values()];const candidates=found.map(t=>({id:t.id,name:t.name,artists:(t.artists||t.ar||[]).map(x=>x.name),album:t.album?.name||'',durationMs:t.duration||t.dt,...rank(searchSong,t)})).sort((a,b)=>b.score-a.score);
 record.match={status:'not_found',queries:urls,candidates:candidates.slice(0,8),workQuery:searchSong};
 const options=candidates.filter(x=>x.titleScore===1);if(!options.length&&candidates[0]?.titleScore>=.7)options.push(candidates[0]);options.sort((a,b)=>b.score-a.score);
 let chosen,source;
 for(const item of options.slice(0,3)){
 const sourceFile=path.join(dir,'sources',item.id+'.json');let trial;
 if(fs.existsSync(sourceFile))trial=JSON.parse(fs.readFileSync(sourceFile,'utf8'));else{const u='https://music.163.com/api/song/lyric?id='+item.id+'&lv=1&kv=1&tv=-1';const j=await get(u);trial={platform:'netease',id:item.id,url:'https://music.163.com/#/song?id='+item.id,apiUrl:u,retrievedAt:new Date().toISOString(),track:item,lrc:j.lrc?.lyric||'',translationLrc:j.tlyric?.lyric||'',romanizationLrc:j.romalrc?.lyric||'',instrumental:!!j.nolyric,lines:parse(j.lrc?.lyric)};save(sourceFile,trial);}
 if(!source){source=trial;chosen=item;}if(trial.lines.length>=6){source=trial;chosen=item;break;}
 }
 if(chosen){const timed=source.lines.filter(l=>! /^(作[词曲]|编曲|词|曲|制作|翻译|翻唱|策划|混音|录音|出品|监制)\s*[:：]/u.test(l.text));
 record.match={...record.match,status:source.instrumental?'instrumental':timed.length<3?'no_timed_lyrics':special(s)?'version_review_required':chosen.titleScore===1&&chosen.artistMatch?'matched':'candidate_review_required',sourceId:chosen.id,sourcePath:'sources/'+chosen.id+'.json',sourceUrl:source.url,selected:chosen,timedLineCount:timed.length};
 if(record.match.status==='matched'&&languageConflict(s,source)){record.match.status='version_review_required';record.match.review={reason:'Catalog language conflicts with source lyrics; either catalog language or selected lyric edition needs confirmation.',evidenceUrl:source.url};}
  record.alignment.status=record.match.status==='version_review_required'?'version_review_required':timed.length>=3&&record.audio.sha256?'pending_asr':'unavailable';}
 }catch(e){record.match.status='fetch_error';record.match.error=String(e.message)}
 save(file,record);manifest.push(record);console.log(JSON.stringify({done:i+1,total:rows.length,key,name:s.song_name,status:record.match.status,source:record.match.sourceId}));
 save(path.join(dir,'index.json'),{schemaVersion:1,generatedAt:new Date().toISOString(),scope:'current catalog + built-in derivatives; not browser-local imports',count:rows.length,processed:manifest.length,tracks:manifest.map(x=>({key:x.key,songId:x.songId,songName:x.songName,path:'tracks/'+x.key+'.json',matchStatus:x.match.status,alignmentStatus:x.alignment.status}))});
}
console.log(JSON.stringify({complete:true,total:manifest.length}));
