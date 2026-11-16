import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateTrack, validateRepository, validateEvidence } from '../validate_lyrics.mjs';

const audioBytes=Buffer.from('fixture audio');
const source={platform:'netease',id:42,track:{id:42},url:'https://music.163.com/#/song?id=42',lrc:'[00:01]first\n[00:10]middle\n[00:20]last',lines:[{t:1,text:'first'},{t:10,text:'middle'},{t:20,text:'last'}]};
const hit=(audioSeconds,text)=>({audioSeconds,endSeconds:audioSeconds+1,similarity:.95,meanProbability:.9,recognizedText:text});
function fixture() {
  return {schemaVersion:1,key:'song-1',songId:1,songName:'Fixture',rowKey:'Fixture',derivative:false,audio:{url:'assets/audio/fixture.m4a',sha256:crypto.createHash('sha256').update(audioBytes).digest('hex')},match:{status:'matched',sourceId:42,sourcePath:'sources/42.json',sourceUrl:source.url,selected:{id:42,titleScore:1,artistMatch:true}},alignment:{status:'pending_asr',offsetSeconds:null,humanVerified:false}};
}
const codes=(record,options={})=>validateTrack(record,{source,audioBytes,...options}).map(x=>x.code);
test('pending and unavailable work are valid; readiness is not required',()=>{
  assert.deepEqual(codes(fixture()),[]);
  const r=fixture();r.match={status:'not_found'};r.audio={url:'',sha256:null};r.alignment.status='not_started';
  assert.deepEqual(validateTrack(r),[]);
});
test('documented alias review preserves raw ranking without allowing unsupported matches',()=>{
  const r=fixture();r.match.selected.titleScore=.7;
  assert.ok(codes(r).includes('matched_evidence'));
  r.match.review={reason:'Confirmed canonical longer title and original artist',evidenceUrl:source.url};
  assert.deepEqual(codes(r),[]);
  delete r.match.review.evidenceUrl;
  assert.ok(codes(r).includes('matched_evidence'));
});
test('current audio URL and actual SHA independently establish identity',()=>{
  const r=fixture();
  assert.ok(codes(r,{expected:{key:r.key,songId:r.songId,songName:r.songName,rowKey:r.rowKey,audioUrl:'assets/audio/new.m4a'}}).includes('audio_identity'));
  assert.ok(codes(r,{audioBytes:Buffer.from('replacement')}).includes('audio_sha256'));
  r.audio.url+='?v=deadbeef';assert.ok(codes(r).includes('audio_version'));
});
test('selected source cannot silently reference another track',()=>{
  const r=fixture();r.match.sourcePath='sources/43.json';assert.ok(codes(r).includes('source_identity'));
  assert.ok(codes(fixture(),{source:{...source,id:43}}).includes('source_identity'));
  assert.ok(codes(fixture(),{source:undefined}).includes('missing_source'));
});
test('unknown status and automatic human verification claims are rejected',()=>{
  const r=fixture();r.alignment.status='verified';r.alignment.humanVerified=true;
  assert.ok(codes(r).includes('alignment_status'));assert.ok(codes(r).includes('verification_claim'));
});
function draft() {
  const r=fixture();r.alignment={status:'asr_consistent_draft',offsetSeconds:2,humanVerified:false,method:'fixture',caveat:'ASR only, not listening verification',sourceFirstLine:source.lines[0],anchorCandidate:hit(3,'first'),checks:source.lines.slice(1).map(x=>({sourceLine:x,candidate:hit(x.t+2,x.text),residualSeconds:0}))};return r;
}
test('consistent draft requires two distinct checks with correct residuals',()=>{
  assert.deepEqual(codes(draft()),[]);
  const duplicate=draft();duplicate.alignment.checks[1]=structuredClone(duplicate.alignment.checks[0]);
  assert.ok(codes(duplicate).includes('independent_spotchecks'));
  const bad=draft();bad.alignment.checks[0].candidate.audioSeconds+=4;bad.alignment.checks[0].candidate.endSeconds+=4;assert.ok(codes(bad).includes('check_residual'));
  const low=draft();low.alignment.anchorCandidate.similarity=.3;assert.ok(codes(low).includes('draft_anchor'));
});
test('version review cannot be promoted by successful ASR',()=>{
  const r=draft();r.match.status='version_review_required';assert.ok(codes(r).includes('version_gate'));
});
test('raw ASR evidence binds model, window and audio SHA',()=>{
  const record=fixture(), evidence={audioSha256:record.audio.sha256,model:'whisper-base',start:0,end:35,result:{segments:[]}};
  assert.deepEqual(validateEvidence(evidence,record),[]);
  assert.equal(validateEvidence({...evidence,audioSha256:'0'.repeat(64)},record)[0].code,'evidence_audio_identity');
  assert.equal(validateEvidence({...evidence,end:0},record)[0].code,'evidence_schema');
});
test('repository validator accepts an incomplete scope with zero tracks',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lyrics-validation-'));
  // Fixture creation only: no repository source or generated lyrics are touched.
  fs.mkdirSync(path.join(temp,'data/xiaosonglu'),{recursive:true});fs.mkdirSync(path.join(temp,'js'));
  fs.writeFileSync(path.join(temp,'data/xiaosonglu/song_catalog.json'),JSON.stringify({songs:[{song_id:1,song_name:'Fixture'}]}));
  fs.writeFileSync(path.join(temp,'data/xiaosonglu/audio_index.json'),JSON.stringify({audios:{}}));
  fs.writeFileSync(path.join(temp,'js/app.js'),'const DERIVATIVE_TRACKS = [\n].map(([songName');
  const report=validateRepository(temp);
  assert.equal(report.expected,1);assert.equal(report.present,0);assert.equal(report.errors,0);assert.deepEqual(report.missing,['song-1']);
});
test('actual Python detector matches a clear anchor and preserves genuine lyric text',()=>{
  const py=String.raw`import ast,difflib,json,re,sys,unicodedata
sys.path.insert(0,".tmp/lyrics-python-deps")
from opencc import OpenCC
_converter=OpenCC("t2s")
p=ast.parse(open(sys.argv[1],encoding='utf-8').read())
selected=[x for x in p.body if isinstance(x,ast.FunctionDef) and x.name in ('detect','is_content') or isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='norm' for t in x.targets)]
exec(compile(ast.Module(body=selected,type_ignores=[]),'<isolated-align-functions>','exec'))
w={'word':'hello world','start':1,'end':5,'probability':.99}
print(json.dumps({'clear':detect({'segments':[{'words':[w]}]},'hello world',0),'long':detect({'segments':[{'words':[{**w,'word':'hello world this is a long recognized segment'}]}]},'hello world',0),'traditional':detect({'segments':[{'words':[{**w,'word':'關心'}]}]},'关心',0),'realLyricKept':is_content({'text':'词不达意的时候我会沉默'}),'creditsExcluded':not any(is_content({'text':v}) for v in ['制作人 : 林忆莲/Jim Lee','小提琴 : 李琪','Lyrics: Example'])}))`;
  const result=spawnSync('python',['-c',py,path.resolve('scripts/align_song_lyrics.py')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const evidence=JSON.parse(result.stdout);
  assert.equal(evidence.clear.similarity,1);
  assert.equal(evidence.clear.audioSeconds,1);
  assert.equal(evidence.long.similarity,1);
  assert.equal(evidence.traditional.similarity,1*.6);
  assert.equal(evidence.creditsExcluded,true,'Credit timestamps must not become sung anchors');
  assert.equal(evidence.realLyricKept,true,'Metadata filtering must preserve a genuine lyric starting with 词');
});
