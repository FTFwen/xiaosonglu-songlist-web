import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchSongLyrics, saveIfChanged } from './match_song_lyrics.mjs';
import { validateRepository } from './validate_lyrics.mjs';

const scripts=path.dirname(fileURLToPath(import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function runScript(name,cwd) {
  const child=spawnSync(process.execPath,[path.join(scripts,name)],{cwd,encoding:'utf8',timeout:180000});
  if(child.error||child.status!==0)throw Error(name+': '+(child.error?.message||child.stderr||child.stdout));
}
function copyFile(from,to) {
  fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
}
function copyJsonDirectory(from,to) {
  if(!fs.existsSync(from))return;
  for(const name of fs.readdirSync(from))if(name.endsWith('.json')&&fs.statSync(path.join(from,name)).isFile())copyFile(path.join(from,name),path.join(to,name));
}
function publishJson(from,to) {
  const next=read(from);
  if(fs.existsSync(to)) {
    const previous=read(to),a={...next},b={...previous};delete a.generatedAt;delete b.generatedAt;
    if(JSON.stringify(a)===JSON.stringify(b))return false;
  }
  return saveIfChanged(to,next);
}

// Does not invoke Whisper or deployment. Callers deploy only when changed=true.
// Overrides/reports run in a private workspace so legacy key-only tools cannot
// accidentally apply an override to a new occupant of a numeric song slot.
export async function syncSongLyrics({root=process.cwd(),fetchJson,now,log=()=>{},run=runScript}={}) {
  root=path.resolve(root);
  const result=await matchSongLyrics({root,fetchJson,now,log});
  const dir=path.join(root,'data/lyrics');
  const staging=fs.mkdtempSync(path.join(os.tmpdir(),'song-lyrics-sync-'));
  let changed=result.changed;
  try {
    for(const relative of ['data/xiaosonglu/song_catalog.json','data/xiaosonglu/audio_index.json','js/app.js'])copyFile(path.join(root,relative),path.join(staging,relative));
    const stageDir=path.join(staging,'data/lyrics');
    fs.mkdirSync(path.join(stageDir,'tracks'),{recursive:true});
    fs.mkdirSync(path.join(stageDir,'sources'),{recursive:true});
    for(const record of result.records)copyFile(path.join(dir,'tracks',record.key+'.json'),path.join(stageDir,'tracks',record.key+'.json'));
    copyJsonDirectory(path.join(dir,'sources'),path.join(stageDir,'sources'));
    // Apply each reviewed correction independently. One unavailable source must
    // leave a retryable snapshot without preventing other songs from publishing.
    for(const correction of result.applicableOverrides) {
      saveIfChanged(path.join(stageDir,'overrides.json'),[correction]);
      try {
        run('apply_lyrics_overrides.mjs',staging);
        const file=path.join(stageDir,'tracks',correction.key+'.json'),record=read(file);
        delete record.match.overridePending;delete record.match.error;
        saveIfChanged(file,record);
      }
      catch(error) {
        const file=path.join(stageDir,'tracks',correction.key+'.json'),record=read(file);
        record.match={status:'fetch_error',error:String(error.message),overridePending:true};
        record.alignment={status:'unavailable',offsetSeconds:null,humanVerified:false};
        saveIfChanged(file,record);
      }
    }
    run('report_song_lyrics.mjs',staging);
    for(const record of result.records) {
      const relative=path.join('tracks',record.key+'.json');
      changed=saveIfChanged(path.join(dir,relative),fs.readFileSync(path.join(stageDir,relative),'utf8'))||changed;
    }
    for(const name of fs.readdirSync(path.join(stageDir,'sources')).filter(x=>/^\d+\.json$/.test(x)))changed=saveIfChanged(path.join(dir,'sources',name),fs.readFileSync(path.join(stageDir,'sources',name),'utf8'))||changed;
    for(const name of ['index.json','coverage.json','review-queue.json'])changed=publishJson(path.join(stageDir,name),path.join(dir,name))||changed;
    changed=saveIfChanged(path.join(dir,'REPORT.md'),fs.readFileSync(path.join(stageDir,'REPORT.md'),'utf8'))||changed;
    const draftDir=path.join(stageDir,'draft-lrc');
    for(const name of fs.readdirSync(draftDir))if(/^(song|derivative)-\d+\.lrc$/.test(name))changed=saveIfChanged(path.join(dir,'draft-lrc',name),fs.readFileSync(path.join(draftDir,name),'utf8'))||changed;
    // Retire only pipeline-named obsolete drafts; user-named files stay untouched.
    const liveDrafts=new Set(fs.readdirSync(draftDir));
    const outputDrafts=path.join(dir,'draft-lrc');
    if(fs.existsSync(outputDrafts))for(const name of fs.readdirSync(outputDrafts)) {
      if(!/^(song|derivative)-\d+\.lrc$/.test(name)||liveDrafts.has(name))continue;
      const source=path.join(outputDrafts,name);
      if(!fs.readFileSync(source,'utf8').includes('[by:UNVERIFIED ASR DRAFT; audio sha256 '))continue;
      const target=path.join(dir,'retired-draft-lrc',name);
      if(fs.existsSync(target))continue;
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(source,target);changed=true;
    }
    const validation=validateRepository(root);
    if(validation.errors||validation.missing.length)throw Error('Lyric validation failed: '+JSON.stringify(validation));
    return {changed,searched:result.searched,total:result.records.length,validation,fetchErrors:validation.matchStatuses.fetch_error||0};
  } finally {
    // This directory was exclusively created above, contains only generated copies.
    fs.rmSync(staging,{recursive:true,force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),rootArg=args.find(x=>x.startsWith('--root='));
  if(args.some(x=>!x.startsWith('--root=')))throw Error('Usage: node scripts/sync_song_lyrics.mjs [--root=PATH]');
  const result=await syncSongLyrics({root:rootArg?.slice(7)||process.cwd()});
  console.log(JSON.stringify(result,null,2));
}
