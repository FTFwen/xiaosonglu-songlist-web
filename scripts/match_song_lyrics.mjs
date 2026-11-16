import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const H={Referer:'https://music.163.com/','User-Agent':'Mozilla/5.0'};
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/official|乐团/gu,'').replace(/[\s\p{P}\p{S}]/gu,'');
const clean=x=>String(x||'').replace(/^小松绿-/u,'').replace(/^（区）/u,'').replace(/[（(](?:半首|第[一二三]遍)[）)]/giu,'').trim();
const works={'江南':['江南','林俊杰'],'失落沙洲':['失落沙洲','徐佳莹'],'春天的芭蕾':['春天的芭蕾','常思思'],'心墙':['心墙','郭静'],'单相思':['カタオモイ','Aimer'],'天狼星的心脏':['シリウスの心臓','ヰ世界情緒'],'茉莉雨':['茉莉雨','林俊杰'],'マリーの架空世界':['マリーの架空世界','じん']};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export function saveIfChanged(file,value) {
  const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  if(fs.existsSync(file)) {
    const previous=fs.readFileSync(file,'utf8');
    if(previous===text)return false;
    if(file.endsWith('.json')) {
      try {if(isDeepStrictEqual(JSON.parse(previous),JSON.parse(text)))return false;}catch{}
    }
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return true;
}
export function parseLrc(text) {
  const out=[];
  for(const line of String(text||'').split(/\r?\n/)) {
    const body=line.replace(/\[[^\]]*\]/g,'').trim();if(!body)continue;
    for(const m of line.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g))out.push({t:+m[1]*60+(+m[2])+(m[3]?Number(m[3].padEnd(3,'0'))/1000:0),text:body});
  }
  return out.sort((a,b)=>a.t-b.t);
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function getJson(url) {
  let error;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetch(url,{headers:H,signal:AbortSignal.timeout(18000)});
      if(!response.ok)throw Error('HTTP '+response.status);
      const data=await response.json();if(data.code&&data.code!==200)throw Error('API '+data.code);
      await sleep(220);return data;
    }catch(e){error=e;if(attempt<2)await sleep(1000*(attempt+1));}
  }
  throw error;
}
// Numeric IDs are allocation slots. Stable row/work identity survives renumbering.
export function identity(row) {
  return JSON.stringify([!!row.derivative,row.row_key??row.rowKey??row.song_name??row.songName,row.song_name??row.songName,row.artist||'',row.language||'',row.display_version??row.edition??'']);
}
export function loadInventory(root) {
  const catalog=read(path.join(root,'data/xiaosonglu/song_catalog.json')).songs;
  const audios=read(path.join(root,'data/xiaosonglu/audio_index.json')).audios;
  const app=fs.readFileSync(path.join(root,'js/app.js'),'utf8');
  const begin=app.indexOf('const DERIVATIVE_TRACKS'),end=app.indexOf('].map(([songName',begin);
  if(begin<0||end<begin)throw Error('Cannot locate built-in derivative declarations');
  const derivatives=[...app.slice(begin,end).matchAll(/\['([^']*)',\s*'([^']*)',\s*'([^']+\.mp3)',\s*'([0-9a-f]+)'\]/g)].map((m,i)=>({song_id:-1101-i,song_name:'小松绿-'+m[1],display_song_name:m[1],artist:'白烁',language:'',audio:'assets/derivative/'+m[3]+'?v='+m[4],derivative:true}));
  const rows=[...catalog,...derivatives],keys=new Set(),identities=new Set();
  for(const row of rows) {
    row.key=(row.derivative?'derivative-':'song-')+Math.abs(row.song_id);row.row_key=row.row_key||row.song_name;
    if(!Number.isInteger(row.song_id)||!row.song_name||keys.has(row.key)||identities.has(identity(row)))throw Error('Duplicate or invalid catalog identity '+row.key);
    keys.add(row.key);identities.add(identity(row));row.audio=row.audio||audios[row.row_key]||'';
  }
  return {catalog,rows};
}
function audioIdentity(root,url) {
  if(!url)return {url:'',sha256:null};
  const file=path.resolve(root,url.split('?')[0]);
  if(!file.startsWith(path.resolve(root)+path.sep))throw Error('Unsafe audio path '+url);
  return {url,sha256:fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null};
}
function rank(song,track) {
  const title=norm(clean(song.song_name)),candidate=norm(track.name);
  const titleScore=title===candidate?1:(candidate.startsWith(title)||title.startsWith(candidate))?.7:0;
  const names=(track.artists||track.ar||[]).map(x=>x.name),tokens=String(song.artist||'').split(/[\/、,，()（）]/).map(norm).filter(x=>x.length>=2);
  const artistMatch=tokens.some(x=>names.some(a=>norm(a).includes(x)||x.includes(norm(a))));
  return {titleScore,artistMatch,score:titleScore*.8+(artistMatch?.2:0)};
}
function resetAlignment(record) {
  return {status:record.match.status==='version_review_required'?'version_review_required':record.audio.sha256&&record.match.sourcePath&&['matched','candidate_review_required'].includes(record.match.status)?'pending_asr':'unavailable',offsetSeconds:null,humanVerified:false};
}
export async function matchSongLyrics({root=process.cwd(),fetchJson=getJson,now=()=>new Date().toISOString(),force=false,retry=false,log=()=>{}}={}) {
  root=path.resolve(root);const dir=path.join(root,'data/lyrics');
  for(const sub of ['sources','tracks'])fs.mkdirSync(path.join(dir,sub),{recursive:true});
  const {catalog,rows}=loadInventory(root),originals=new Map();
  for(const name of fs.readdirSync(path.join(dir,'tracks')).filter(x=>/^(song|derivative)-\d+\.json$/.test(x))) {
    const record=read(path.join(dir,'tracks',name));
    if(record.schemaVersion!==1||record.key!==name.slice(0,-5))throw Error('Invalid generated track '+name);
    originals.set(record.key,record);
  }
  const byIdentity=new Map();
  for(const record of originals.values()) {
    const id=identity(record);if(byIdentity.has(id))throw Error('Duplicate stored row identity '+record.rowKey);byIdentity.set(id,record);
  }
  const correctionsFile=path.join(dir,'overrides.json'),corrections=fs.existsSync(correctionsFile)?read(correctionsFile):[];
  const bindingsFile=path.join(dir,'identity-bindings.json'),bindings=fs.existsSync(bindingsFile)?read(bindingsFile):{schemaVersion:1,overrides:{}};
  const applicableOverrides=[];
  for(const correction of corrections) {
    // Capture legacy key-only overrides before rewriting any numeric slots.
    const explicit=correction.rowKey?rows.find(s=>s.row_key===correction.rowKey&&(!correction.songName||s.song_name===correction.songName)):null;
    const bound=bindings.overrides[correction.key]||(explicit?identity(explicit):originals.has(correction.key)?identity(originals.get(correction.key)):null);
    if(!bound)continue;bindings.overrides[correction.key]=bound;
    const current=rows.find(s=>identity(s)===bound);if(current)applicableOverrides.push({...correction,key:current.key,rowKey:current.row_key});
  }
  let changed=saveIfChanged(bindingsFile,bindings),searched=0;
  const protectedRows=new Set(applicableOverrides.map(x=>x.key)),records=[];
  for(const song of rows) {
    const previous=byIdentity.get(identity(song)),audio=audioIdentity(root,song.audio);
    const shouldSearch=!previous||(!protectedRows.has(song.key)&&(force||previous.match?.status==='fetch_error'||(retry&&['not_found','no_timed_lyrics','candidate_review_required'].includes(previous.match?.status))));
    let record;
    if(!shouldSearch) {
      record={...structuredClone(previous),key:song.key,songId:song.song_id,songName:song.song_name,rowKey:song.row_key,displaySongName:song.display_song_name||song.song_name,edition:song.display_version||'',remark:song.remark||'',audio};
      if(previous.audio?.sha256!==audio.sha256||previous.audio?.url!==audio.url)record.alignment=resetAlignment(record);
    }else {
      searched++;
      record={schemaVersion:1,key:song.key,songId:song.song_id,songName:song.song_name,rowKey:song.row_key,displaySongName:song.display_song_name||song.song_name,artist:song.artist||'',language:song.language||'',derivative:!!song.derivative,edition:song.display_version||'',remark:song.remark||'',audio,retrievedAt:now(),match:{status:'unsearched'},alignment:{status:'not_started',offsetSeconds:null,humanVerified:false}};
      try {
        const special=/中文填词|中文版/.test([song.song_name,song.display_version].join(' '))||previous?.match?.status==='version_review_required';
        const base=clean(song.song_name),inferred=song.derivative?catalog.find(x=>clean(x.song_name)===base&&x.artist):null,work=song.derivative?works[base]:null;
        // Alias follows the literal work title, never the historical numeric ID 194.
        const alias=['秒针を噛む','秒針を噛む'].includes(base)?'秒針を噛む':null;
        const query=work?.[0]||(!special&&alias)||base;
        const searchSong={...song,song_name:query,artist:work?.[1]||inferred?.artist||(song.derivative?'':song.artist)};
        const hint=String(searchSong.artist||'').split(/[,，、（(]/)[0].trim(),queries=[query];if(hint)queries.push(query+' '+hint);
        if(song.display_song_name&&norm(clean(song.display_song_name))!==norm(query))queries.push(clean(song.display_song_name));
        const urls=[],found=new Map();
        for(const q of new Set(queries)) {
          const url='https://music.163.com/api/search/get?s='+encodeURIComponent(q)+'&type=1&limit=20&offset=0';urls.push(url);
          const data=await fetchJson(url);for(const item of data.result?.songs||[])found.set(item.id,item);
        }
        const candidates=[...found.values()].map(t=>({id:t.id,name:t.name,artists:(t.artists||t.ar||[]).map(x=>x.name),album:t.album?.name||'',durationMs:t.duration||t.dt,...rank(searchSong,t)})).sort((a,b)=>b.score-a.score);
        record.match={status:'not_found',queries:urls,candidates:candidates.slice(0,8),workQuery:searchSong};
        const options=candidates.filter(x=>x.titleScore===1);if(!options.length&&candidates[0]?.titleScore>=.7)options.push(candidates[0]);options.sort((a,b)=>b.score-a.score);
        let chosen,source;
        for(const item of options.slice(0,3)) {
          const sourceFile=path.join(dir,'sources',item.id+'.json');let trial;
          if(fs.existsSync(sourceFile))trial=read(sourceFile);
          else {
            const url='https://music.163.com/api/song/lyric?id='+item.id+'&lv=1&kv=1&tv=-1',data=await fetchJson(url);
            trial={platform:'netease',id:item.id,url:'https://music.163.com/#/song?id='+item.id,apiUrl:url,retrievedAt:now(),track:item,lrc:data.lrc?.lyric||'',translationLrc:data.tlyric?.lyric||'',romanizationLrc:data.romalrc?.lyric||'',instrumental:!!data.nolyric,lines:parseLrc(data.lrc?.lyric)};
            changed=saveIfChanged(sourceFile,trial)||changed;
          }
          if(trial.id!==item.id||trial.track?.id!==item.id||!Array.isArray(trial.lines))throw Error('Invalid cached source '+item.id);
          if(!source){source=trial;chosen=item;}if(trial.lines.length>=6){source=trial;chosen=item;break;}
        }
        if(chosen) {
          const timed=source.lines.filter(l=>! /^(作[词曲]|编曲|词|曲|制作|翻译|翻唱|策划|混音|录音|出品|监制)\s*[:：]/u.test(l.text));
          record.match={...record.match,status:source.instrumental?'instrumental':timed.length<3?'no_timed_lyrics':special?'version_review_required':chosen.titleScore===1&&chosen.artistMatch?'matched':'candidate_review_required',sourceId:chosen.id,sourcePath:'sources/'+chosen.id+'.json',sourceUrl:source.url,selected:chosen,timedLineCount:timed.length};
          if(record.match.status==='matched'&&/中文/.test(song.language||'')&&(source.lines.map(x=>x.text).join('').match(/[\u3040-\u30ff]/g)||[]).length>=8){record.match.status='version_review_required';record.match.review={reason:'Catalog language conflicts with source lyrics; either catalog language or selected lyric edition needs confirmation.',evidenceUrl:source.url};}
          record.alignment=resetAlignment(record);
        }
      }catch(error){record.match={status:'fetch_error',error:String(error.message)};record.alignment=resetAlignment(record);}
    }
    changed=saveIfChanged(path.join(dir,'tracks',song.key+'.json'),record)||changed;records.push(record);log({key:song.key,status:record.match.status});
  }
  // Preserve obsolete generated snapshots outside the current tracks inventory.
  const active=new Set(rows.map(s=>s.key));
  for(const [key] of originals)if(!active.has(key)) {
    const source=path.join(dir,'tracks',key+'.json'),digest=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16),retired=path.join(dir,'retired-tracks',key+'-'+digest+'.json');
    fs.mkdirSync(path.dirname(retired),{recursive:true});if(fs.existsSync(retired))throw Error('Retired track already exists; refusing to overwrite '+retired);
    fs.renameSync(source,retired);changed=true;
  }
  const indexFile=path.join(dir,'index.json'),oldIndex=fs.existsSync(indexFile)?read(indexFile):null;
  const entries=records.map(x=>({key:x.key,songId:x.songId,songName:x.songName,path:'tracks/'+x.key+'.json',matchStatus:x.match.status,alignmentStatus:x.alignment.status}));
  const oldEntries=oldIndex?.tracks?.map(({key,songId,songName,path,matchStatus,alignmentStatus})=>({key,songId,songName,path,matchStatus,alignmentStatus}));
  const ordered=value=>value?.slice().sort((a,b)=>a.key.localeCompare(b.key));
  if(!oldIndex||JSON.stringify(ordered(oldEntries))!==JSON.stringify(ordered(entries))||oldIndex.count!==rows.length||oldIndex.processed!==rows.length)changed=saveIfChanged(indexFile,{schemaVersion:1,generatedAt:now(),scope:'current catalog + built-in derivatives; not browser-local imports',count:rows.length,processed:records.length,tracks:entries})||changed;
  return {changed,searched,records,applicableOverrides};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),rootArg=args.find(x=>x.startsWith('--root='));
  const result=await matchSongLyrics({root:rootArg?.slice(7)||process.cwd(),force:args.includes('--force'),retry:args.includes('--retry'),log:x=>console.log(JSON.stringify(x))});
  console.log(JSON.stringify({complete:true,total:result.records.length,changed:result.changed,searched:result.searched}));
}
