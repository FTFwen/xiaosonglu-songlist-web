import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchSongLyrics, saveIfChanged } from '../match_song_lyrics.mjs';
import { syncSongLyrics } from '../sync_song_lyrics.mjs';
import { validateRepository } from '../validate_lyrics.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const lyric='[00:01]first\n[00:03]second\n[00:05]third\n[00:07]fourth\n[00:09]fifth\n[00:11]last';
const song=(id,name='Alpha',rowKey=name)=>({song_id:id,song_name:name,row_key:rowKey,artist:'Fixture Artist',language:'英文'});
function fixture(t,songs=[song(1)]) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lyrics-sync-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  saveIfChanged(path.join(root,'js/app.js'),'const DERIVATIVE_TRACKS = [\n].map(([songName');
  saveIfChanged(path.join(root,'data/lyrics/overrides.json'),[]);
  update(root,songs);
  return root;
}
function update(root,songs) {
  const audios={};
  for(const s of songs) {
    const url='assets/audio/'+encodeURIComponent(s.row_key)+'.m4a';audios[s.row_key]=url;
    const file=path.join(root,url);if(!fs.existsSync(file))saveIfChanged(file,'fixture audio '+s.row_key);
  }
  saveIfChanged(path.join(root,'data/xiaosonglu/song_catalog.json'),{songs});
  saveIfChanged(path.join(root,'data/xiaosonglu/audio_index.json'),{audios});
}
function provider(names=['Alpha','Beta','Gamma']) {
  const calls=[];
  const fetchJson=async url=>{
    calls.push(url);const parsed=new URL(url);
    if(parsed.pathname.includes('/search/')) {
      const q=parsed.searchParams.get('s'),name=names.find(x=>q===x||q.startsWith(x+' '));
      return {code:200,result:{songs:name?[{id:100+names.indexOf(name),name,artists:[{name:'Fixture Artist'}],duration:200000}]:[]}};
    }
    return {code:200,lrc:{lyric}};
  };
  return {fetchJson,calls};
}
function track(root,key='song-1') {return read(path.join(root,'data/lyrics/tracks',key+'.json'));}
function snapshot(root) {
  const out={};
  function walk(dir) {for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else out[path.relative(root,file)]=[fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs];}}
  walk(path.join(root,'data/lyrics'));return out;
}

test('equivalent legacy JSON number formatting preserves original bytes and mtime',t=>{
  const root=fixture(t),file=path.join(root,'legacy.json');
  fs.writeFileSync(file,'{\n  "offset": 0.0,\n  "score": 1.0\n}\n');
  const before=fs.readFileSync(file,'utf8'),mtime=fs.statSync(file).mtimeMs;
  assert.equal(saveIfChanged(file,{offset:0,score:1}),false);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(fs.statSync(file).mtimeMs,mtime);
});

test('new song obtains lyrics, default sync leaves pending ASR and no fabricated offset',async t=>{
  const root=fixture(t),p=provider();
  const first=await syncSongLyrics({root,fetchJson:p.fetchJson});
  assert.equal(first.searched,1);assert.equal(first.fetchErrors,0);
  assert.equal(track(root).match.status,'matched');
  assert.deepEqual(track(root).alignment,{status:'pending_asr',offsetSeconds:null,humanVerified:false});
  update(root,[song(1),song(2,'Beta')]);p.calls.length=0;
  const result=await syncSongLyrics({root,fetchJson:p.fetchJson});
  assert.equal(result.searched,1);assert.ok(p.calls.every(x=>!new URL(x).searchParams.get('s')?.startsWith('Alpha')));
  assert.equal(track(root,'song-2').match.sourceId,101);
  assert.equal(result.validation.errors,0);
});

test('audio replacement clears all old alignment evidence but preserves same-row lyrics',async t=>{
  const root=fixture(t),p=provider();await syncSongLyrics({root,fetchJson:p.fetchJson});
  const old=track(root);old.alignment={status:'asr_anchor_candidate',offsetSeconds:12,humanVerified:false,evidencePath:'evidence/old.json',checks:[]};
  saveIfChanged(path.join(root,'data/lyrics/tracks/song-1.json'),old);
  fs.writeFileSync(path.join(root,old.audio.url),'replacement audio bytes');
  const result=await syncSongLyrics({root,fetchJson:async()=>{throw Error('unchanged work must not search');}});
  assert.equal(result.searched,0);assert.equal(track(root).match.sourceId,100);
  assert.notEqual(track(root).audio.sha256,old.audio.sha256);
  assert.deepEqual(track(root).alignment,{status:'pending_asr',offsetSeconds:null,humanVerified:false});
});

test('ID reorder preserves row identity, reviewed overrides follow work and never slot 194',async t=>{
  const root=fixture(t,[song(194,'Alpha'),song(2,'Beta')]),p=provider();await syncSongLyrics({root,fetchJson:p.fetchJson});
  saveIfChanged(path.join(root,'data/lyrics/overrides.json'),[{key:'song-194',proposedSourceId:100,status:'matched',reason:'fixture review',evidenceUrl:'https://music.163.com/#/song?id=100'}]);
  await syncSongLyrics({root,fetchJson:p.fetchJson});
  update(root,[song(2,'Alpha'),song(194,'Beta')]);
  const result=await syncSongLyrics({root,fetchJson:async()=>{throw Error('ID reorder must not search');}});
  assert.equal(result.searched,0);assert.equal(track(root,'song-2').rowKey,'Alpha');
  assert.equal(track(root,'song-2').match.sourceId,100);assert.equal(track(root,'song-2').match.review.reason,'fixture review');
  assert.equal(track(root,'song-194').rowKey,'Beta');assert.equal(track(root,'song-194').match.sourceId,101);
  assert.equal(track(root,'song-194').match.review,undefined);
  const again=await syncSongLyrics({root,fetchJson:async()=>{throw Error('unexpected search');}});assert.equal(again.changed,false);
});

test('a fresh occupant of historical ID 194 uses its own title, never the old alias',async t=>{
  const root=fixture(t,[song(194,'Gamma')]),p=provider();
  await matchSongLyrics({root,fetchJson:p.fetchJson});
  assert.ok(p.calls.some(x=>new URL(x).searchParams.get('s')==='Gamma'));
  assert.ok(p.calls.every(x=>!x.includes(encodeURIComponent('秒針を噛む'))));
});

test('source failure persists fetch_error, next default run retries it only',async t=>{
  const root=fixture(t,[song(1),song(2,'Beta')]),p=provider();
  let fail=true;
  const fetchJson=async url=>{if(fail&&url.includes('/song/lyric')&&new URL(url).searchParams.get('id')==='100')throw Error('fixture source offline');return p.fetchJson(url);};
  const first=await syncSongLyrics({root,fetchJson});
  assert.equal(first.fetchErrors,1);assert.equal(track(root).match.status,'fetch_error');assert.equal(track(root,'song-2').match.status,'matched');
  fail=false;p.calls.length=0;
  const second=await syncSongLyrics({root,fetchJson});assert.equal(second.searched,1);assert.equal(second.fetchErrors,0);
  assert.ok(p.calls.every(x=>!new URL(x).searchParams.get('s')?.startsWith('Beta')));
});

test('not-found and ambiguous records are published, no-change rerun preserves bytes, mtimes and dates',async t=>{
  const root=fixture(t,[song(1,'Unknown'),song(2,'Beta')]),p=provider();
  const fetchJson=async url=>{const data=await p.fetchJson(url);if(new URL(url).searchParams.get('s')?.startsWith('Beta'))for(const x of data.result.songs)x.artists=[{name:'Different Artist'}];return data;};
  await syncSongLyrics({root,fetchJson});
  assert.equal(track(root).match.status,'not_found');assert.equal(track(root,'song-2').match.status,'candidate_review_required');
  const before=snapshot(root);
  const result=await syncSongLyrics({root,fetchJson:async()=>{throw Error('no-change must be offline');},now:()=> '2099-01-01T00:00:00.000Z'});
  assert.equal(result.changed,false);assert.equal(result.searched,0);assert.deepEqual(snapshot(root),before);
  const coverage=read(path.join(root,'data/lyrics/coverage.json'));assert.equal(coverage.processed,2);
});

test('changed row identity searches again and does not inherit an unrelated override',async t=>{
  const root=fixture(t),p=provider();await syncSongLyrics({root,fetchJson:p.fetchJson});
  saveIfChanged(path.join(root,'data/lyrics/overrides.json'),[{key:'song-1',proposedSourceId:100,status:'matched',reason:'Alpha only',evidenceUrl:'https://music.163.com/#/song?id=100'}]);
  update(root,[song(1,'Beta')]);const result=await syncSongLyrics({root,fetchJson:p.fetchJson});
  assert.equal(result.searched,1);assert.equal(track(root).match.sourceId,101);assert.equal(track(root).match.review,undefined);
});

test('override source failure publishes retryable status and retries without rematching the library',async t=>{
  const root=fixture(t),p=provider();await syncSongLyrics({root,fetchJson:p.fetchJson});
  saveIfChanged(path.join(root,'data/lyrics/overrides.json'),[{key:'song-1',proposedSourceId:999,status:'matched',reason:'reviewed replacement',evidenceUrl:'https://music.163.com/#/song?id=999'}]);
  const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const run=(name,cwd)=>{
    if(name==='apply_lyrics_overrides.mjs')throw Error('fixture override source offline');
    const child=spawnSync(process.execPath,[path.join(scripts,name)],{cwd,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  };
  const failed=await syncSongLyrics({root,fetchJson:async()=>{throw Error('reviewed row must not search');},run});
  assert.equal(failed.fetchErrors,1);assert.equal(track(root).match.overridePending,true);
  const source=read(path.join(root,'data/lyrics/sources/100.json'));
  source.id=999;source.track={...source.track,id:999};source.url='https://music.163.com/#/song?id=999';
  saveIfChanged(path.join(root,'data/lyrics/sources/999.json'),source);
  const retried=await syncSongLyrics({root,fetchJson:async()=>{throw Error('override retry must not rematch');}});
  assert.equal(retried.searched,0);assert.equal(retried.fetchErrors,0);assert.equal(track(root).match.sourceId,999);
});

test('removed generated tracks are retained outside inventory and user files are untouched',async t=>{
  const root=fixture(t,[song(1),song(2,'Beta')]),p=provider();await syncSongLyrics({root,fetchJson:p.fetchJson});
  const user=path.join(root,'data/lyrics/tracks/my-notes.txt');saveIfChanged(user,'do not delete');
  update(root,[song(1)]);await syncSongLyrics({root,fetchJson:p.fetchJson});
  assert.equal(fs.readFileSync(user,'utf8'),'do not delete');
  assert.ok(fs.readdirSync(path.join(root,'data/lyrics/retired-tracks')).some(x=>x.startsWith('song-2-')));
  assert.equal(validateRepository(root).errors,0);
});
