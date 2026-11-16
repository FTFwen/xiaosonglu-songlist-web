import fs from 'node:fs';
const dir='data/lyrics';
const corrections=JSON.parse(fs.readFileSync(`${dir}/overrides.json`,'utf8'));
const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
const headers={Referer:'https://music.163.com/','User-Agent':'Mozilla/5.0'};
async function get(url){const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();if(data.code!==200)throw Error('API '+data.code);return data;}
function parse(text){const out=[];for(const line of String(text||'').split(/\r?\n/)){const text=line.replace(/\[[^\]]*\]/g,'').trim();if(!text)continue;for(const m of line.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g))out.push({t:+m[1]*60+(+m[2])+(m[3]?Number(m[3].padEnd(3,'0'))/1000:0),text});}return out.sort((a,b)=>a.t-b.t);}
for(const c of corrections){
 if(!c.reason||!c.evidenceUrl||!c.status)throw Error('Incomplete override '+c.key);
 let source;
 if(c.proposedSourceId!==null){
  const id=c.proposedSourceId,sp=`${dir}/sources/${id}.json`;
  if(fs.existsSync(sp))source=JSON.parse(fs.readFileSync(sp));
  else{
   const detail=await get(`https://music.163.com/api/song/detail/?id=${id}&ids=[${id}]`),t=detail.songs?.[0];
   if(!t)throw Error('Missing song detail '+id);
   const track={id,name:t.name,artists:(t.artists||t.ar||[]).map(x=>x.name),album:t.album?.name||'',durationMs:t.duration||t.dt,titleScore:1,artistMatch:c.status==='matched',score:c.status==='matched'?1:.8,reviewedWorkIdentity:true};
   const apiUrl=`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,j=await get(apiUrl);
   source={platform:'netease',id,url:`https://music.163.com/#/song?id=${id}`,apiUrl,retrievedAt:new Date().toISOString(),track,lrc:j.lrc?.lyric||'',translationLrc:j.tlyric?.lyric||'',romanizationLrc:j.romalrc?.lyric||'',instrumental:!!j.nolyric,lines:parse(j.lrc?.lyric)};
   save(sp,source);
  }
  if(source.id!==id||(source.lines.length<3&&c.status!=='no_timed_lyrics'))throw Error('Invalid cached source '+id);
 }
 if(process.argv.includes('--fetch-sources-only'))continue;
 const p=`${dir}/tracks/${c.key}.json`,r=JSON.parse(fs.readFileSync(p)),prior=r.match.sourceId||null;
 if(!source){for(const k of ['sourceId','sourcePath','sourceUrl','selected','timedLineCount'])delete r.match[k];}
 else Object.assign(r.match,{sourceId:source.id,sourcePath:`sources/${source.id}.json`,sourceUrl:source.url,selected:source.track,timedLineCount:source.lines.length});
 r.match.status=c.status;
 r.match.review={reason:c.reason,evidenceUrl:c.evidenceUrl,previousSourceId:r.match.review?.previousSourceId??prior};
 const status=c.status==='version_review_required'?'version_review_required':!source||source.lines.length<3?'unavailable':r.audio.sha256?'pending_asr':'unavailable';
 if(prior!==c.proposedSourceId||r.alignment.status==='not_started'||status==='version_review_required'||status==='unavailable')r.alignment={status,offsetSeconds:null,humanVerified:false};
 save(p,r);console.log(c.key,c.status,c.proposedSourceId);
}
