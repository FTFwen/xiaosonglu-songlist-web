import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MATCH_STATUSES = new Set(['unsearched','not_found','fetch_error','instrumental','no_timed_lyrics','version_review_required','matched','candidate_review_required']);
export const ALIGN_STATUSES = new Set(['not_started','unavailable','pending_asr','version_review_required','anchor_not_found','asr_anchor_candidate','large_offset_review_required','asr_consistent_draft','timing_drift_review_required','spotcheck_review_required','alignment_error']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const lineValid = x => x && finite(x.t) && x.t >= 0 && typeof x.text === 'string' && x.text.trim().length > 0;
const sameLine = (a,b) => a && b && a.t === b.t && a.text === b.text;
const hitValid = x => x && finite(x.audioSeconds) && x.audioSeconds >= 0 && finite(x.endSeconds) && x.endSeconds >= x.audioSeconds && finite(x.similarity) && x.similarity >= 0 && x.similarity <= 1 && finite(x.meanProbability) && x.meanProbability >= 0 && x.meanProbability <= 1 && typeof x.recognizedText === 'string' && x.recognizedText.trim().length > 0;
const goodHit = x => hitValid(x) && x.similarity >= .72 && x.meanProbability >= .35;

// Pure validation; read-only callers supply current catalog/audio and source snapshots.
export function validateTrack(record, { expected, source, audioBytes } = {}) {
  const issues = [];
  const add = (code, message, severity='error') => issues.push({code,severity,message});
  if (!record || typeof record !== 'object') return [{code:'track_schema',severity:'error',message:'Track must be an object'}];
  if (record.schemaVersion !== 1 || !Number.isInteger(record.songId) || typeof record.songName !== 'string' || !record.songName) add('track_schema','Invalid schemaVersion/songId/songName');
  const key = `${record.derivative ? 'derivative' : 'song'}-${Math.abs(record.songId)}`;
  if (record.key !== key) add('track_key','Key does not match songId/derivative identity');
  if (expected) {
    if (record.key !== expected.key || record.songId !== expected.songId || record.songName !== expected.songName) add('catalog_identity','Track identity differs from current catalog');
    if (record.audio?.url !== expected.audioUrl) add('audio_identity','Audio URL differs from current audio index');
    if (record.rowKey != null && record.rowKey !== expected.rowKey) add('row_identity','rowKey differs from current catalog');
    if (record.rowKey == null) add('missing_row_key','Legacy record has no rowKey','warning');
  }
  const audio = record.audio;
  if (!audio || typeof audio.url !== 'string' || !(audio.sha256 === null || /^[0-9a-f]{64}$/.test(audio.sha256))) add('audio_schema','Invalid audio URL or SHA-256');
  if (audioBytes !== undefined) {
    const actual = sha(audioBytes);
    if (audio?.sha256 !== actual) add('audio_sha256','Stored SHA-256 does not identify the current audio bytes');
    const version = /[?&]v=([0-9a-f]+)(?:&|$)/i.exec(audio?.url || '')?.[1];
    if (version && !actual.startsWith(version.toLowerCase())) add('audio_version','Audio cache version differs from current bytes');
  }
  const m = record.match || {}, a = record.alignment || {};
  if (!MATCH_STATUSES.has(m.status)) add('match_status','Unknown match status: '+m.status);
  if (!ALIGN_STATUSES.has(a.status)) add('alignment_status','Unknown alignment status: '+a.status);
  if (a.humanVerified !== false) add('verification_claim','Automatic pipeline records must explicitly remain humanVerified=false');
  if (a.offsetSeconds !== null && !finite(a.offsetSeconds)) add('offset_schema','offsetSeconds must be null or finite');
  if (Object.hasOwn(a, 'timeline')) {
    const timeline = a.timeline;
    if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline) ||
        !finite(timeline.scale) || timeline.scale < 0.97 || timeline.scale > 1.03 ||
        !finite(timeline.interceptSeconds) || Math.abs(timeline.interceptSeconds) > 600) {
      add('timeline_schema','timeline requires a finite scale in [0.97, 1.03] and interceptSeconds in [-600, 600]');
    }
  }
  const needsSource = ['matched','candidate_review_required','instrumental','no_timed_lyrics'].includes(m.status) || m.sourceId != null;
  if (needsSource) {
    if (!Number.isInteger(m.sourceId) || m.sourcePath !== `sources/${m.sourceId}.json` || m.selected?.id !== m.sourceId) add('source_identity','Selected id/path/sourceId disagree');
    if (!source) add('missing_source','Selected source is absent');
    else {
      if (source.id !== m.sourceId || source.track?.id !== m.sourceId || source.platform !== 'netease') add('source_identity','Source document identity disagrees');
      if (source.url !== m.sourceUrl || !String(source.url).endsWith(`id=${m.sourceId}`)) add('source_url','Source URL does not identify selected song');
      if (typeof source.lrc !== 'string' || !Array.isArray(source.lines)) add('source_schema','Source needs raw LRC and parsed lines');
      else if (source.lines.some((x,i,arr) => !lineValid(x) || (i > 0 && x.t < arr[i-1].t))) add('source_lines','Source lines must have nonnegative ordered timestamps and text');
    }
  }
  if (m.status === 'matched' && (m.selected?.titleScore !== 1 || m.selected?.artistMatch !== true) && !(m.review?.reason && /^https:\/\//.test(m.review?.evidenceUrl || ''))) add('matched_evidence','Matched status lacks exact title/artist evidence or documented source review');
  if (m.status === 'version_review_required' && a.status !== 'version_review_required') add('version_gate','Version review cannot be bypassed by ASR');
  if (a.status === 'pending_asr' && (!audio?.sha256 || !source || !['matched','candidate_review_required'].includes(m.status))) add('pending_evidence','Pending ASR needs audio identity and eligible source');
  if (a.status?.startsWith('asr_') && m.status !== 'matched') add('unresolved_match','ASR evidence cannot resolve song/version identity','warning');
  if (a.anchorCandidate && !hitValid(a.anchorCandidate)) add('anchor_schema','Invalid ASR anchor evidence');
  if (a.sourceFirstLine && source?.lines && !source.lines.some(x => sameLine(x,a.sourceFirstLine))) add('anchor_source','Anchor line is absent from selected source');
  if (a.status === 'asr_consistent_draft') {
    if (!finite(a.offsetSeconds) || !goodHit(a.anchorCandidate) || !lineValid(a.sourceFirstLine)) add('draft_anchor','Consistent draft needs offset and a qualifying anchor');
    else if (Math.abs(a.offsetSeconds-(a.anchorCandidate.audioSeconds-a.sourceFirstLine.t)) > .002) add('anchor_offset','Offset differs from anchor evidence');
    const checks = Array.isArray(a.checks) ? a.checks : [];
    const independent = new Set(checks.filter(x => lineValid(x.sourceLine) && goodHit(x.candidate) && finite(x.residualSeconds) && Math.abs(x.residualSeconds) <= 1.25 && (!a.sourceFirstLine || !sameLine(x.sourceLine,a.sourceFirstLine))).map(x => JSON.stringify(x.sourceLine)));
    if (independent.size < 2) add('independent_spotchecks','Consistent draft requires two distinct non-anchor source lines');
    for (const check of checks) {
      if (!source?.lines?.some(x => sameLine(x,check.sourceLine))) add('check_source','Spotcheck line absent from source');
      if (hitValid(check.candidate) && lineValid(check.sourceLine) && finite(a.offsetSeconds) && (!finite(check.residualSeconds) || Math.abs(check.residualSeconds-(check.candidate.audioSeconds-check.sourceLine.t-a.offsetSeconds)) > .002)) add('check_residual','Stored residual disagrees with timestamps');
    }
    if (!a.method || !a.caveat) add('draft_provenance','ASR draft needs method and non-verification caveat');
  }
  return issues;
}

export function validateEvidence(evidence, record) {
  const issues=[];
  if (!evidence || evidence.audioSha256 !== record.audio?.sha256) issues.push({code:'evidence_audio_identity',severity:'error',message:'ASR evidence SHA differs from this audio'});
  if (!evidence || evidence.model !== 'whisper-base' || !finite(evidence.start) || evidence.start < 0 || !finite(evidence.end) || evidence.end <= evidence.start || !Array.isArray(evidence.result?.segments)) issues.push({code:'evidence_schema',severity:'error',message:'Invalid ASR model/window/result evidence'});
  return issues;
}

export function currentTracks(root) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root,'data/xiaosonglu/song_catalog.json'),'utf8')).songs;
  const audios = JSON.parse(fs.readFileSync(path.join(root,'data/xiaosonglu/audio_index.json'),'utf8')).audios;
  const app = fs.readFileSync(path.join(root,'js/app.js'),'utf8');
  const begin = app.indexOf('const DERIVATIVE_TRACKS = [');
  const end = app.indexOf('].map(([songName',begin);
  if (begin < 0 || end < begin) throw Error('Cannot locate built-in derivative declarations');
  const derivatives = [...app.slice(begin,end).matchAll(/\['([^']*)',\s*'([^']*)',\s*'([^']+\.mp3)',\s*'([0-9a-f]+)'\]/g)].map((m,i) => ({song_id:-1101-i,song_name:'小松绿-'+m[1],row_key:'小松绿-'+m[1],audio:`assets/derivative/${m[3]}?v=${m[4]}`,derivative:true}));
  return [...catalog,...derivatives].map(s => ({key:`${s.derivative?'derivative':'song'}-${Math.abs(s.song_id)}`,songId:s.song_id,songName:s.song_name,rowKey:s.row_key||s.song_name,audioUrl:s.audio||audios[s.row_key||s.song_name]||''}));
}

export function validateRepository(root, { hashAudio=true } = {}) {
  const dir = path.join(root,'data/lyrics'), expected = currentTracks(root), byKey = new Map(expected.map(x=>[x.key,x]));
  const report = {expected:expected.length,present:0,missing:[],matchStatuses:{},alignmentStatuses:{},issues:[]};
  const issue = (key,code,message,severity='error') => report.issues.push({key,code,message,severity});
  const readJson = file => JSON.parse(fs.readFileSync(file,'utf8'));
  const files = fs.existsSync(path.join(dir,'tracks')) ? fs.readdirSync(path.join(dir,'tracks')).filter(x=>x.endsWith('.json')) : [];
  const records = new Map();
  for (const name of files) {
    const key = name.slice(0,-5);
    try {
      const r = readJson(path.join(dir,'tracks',name)), exp=byKey.get(key);
      records.set(key,r);
      if (!exp) issue(key,'unexpected_track','Track is outside current scope'); else report.present++;
      if (r.key !== key) issue(key,'filename_identity','Filename differs from track key');
      let source, audioBytes;
      if (Number.isInteger(r.match?.sourceId)) {
        const sourceFile=path.join(dir,'sources',`${r.match.sourceId}.json`);
        if (fs.existsSync(sourceFile)) source=readJson(sourceFile);
      }
      const url=r.audio?.url;
      if (url) {
        const local=path.resolve(root,url.split('?')[0]);
        if (!local.startsWith(path.resolve(root)+path.sep)) issue(key,'unsafe_audio_path','Audio path escapes repository');
        else if (!fs.existsSync(local)) issue(key,'missing_audio','Referenced local audio is absent');
        else if (hashAudio) audioBytes=fs.readFileSync(local);
      }
      for (const x of validateTrack(r,{expected:exp,source,audioBytes})) report.issues.push({key,...x});
      const evidencePaths=[r.alignment?.evidencePath,...(r.alignment?.checks||[]).map(x=>x.evidencePath)].filter(Boolean);
      for (const relative of evidencePaths) {
        if (typeof relative !== 'string' || !/^evidence\/[a-zA-Z0-9_-]+\.json$/.test(relative)) { issue(key,'evidence_path','Unexpected ASR evidence path'); continue; }
        const evidenceFile=path.join(dir,relative);
        if (!fs.existsSync(evidenceFile)) issue(key,'missing_evidence','Referenced ASR evidence file is absent');
        else for (const x of validateEvidence(readJson(evidenceFile),r)) report.issues.push({key,...x});
      }
      for (const [field,value] of [['matchStatuses',r.match?.status],['alignmentStatuses',r.alignment?.status]]) report[field][value]=(report[field][value]||0)+1;
    } catch(e) { issue(key,'unreadable_snapshot',e.message); }
  }
  report.missing=expected.filter(x=>!records.has(x.key)).map(x=>x.key);
  const indexFile=path.join(dir,'index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const index=readJson(indexFile);
      if (index.schemaVersion !== 1 || index.count !== expected.length || !Number.isInteger(index.processed) || index.processed<0 || index.processed>index.count || !Array.isArray(index.tracks) || index.tracks.length!==index.processed) issue('index','index_schema','Invalid scope count/processed/tracks');
      const seen=new Set();
      for (const entry of index.tracks||[]) {
        if (seen.has(entry.key)) issue(entry.key,'duplicate_index','Duplicate index entry'); seen.add(entry.key);
        if (!byKey.has(entry.key) || entry.path!==`tracks/${entry.key}.json`) issue(entry.key,'index_identity','Unexpected index key or path');
        const r=records.get(entry.key);
        if (!r) issue(entry.key,'index_missing_track','Indexed file absent');
        else if (r.match?.status!==entry.matchStatus || r.alignment?.status!==entry.alignmentStatus) issue(entry.key,'stale_index_status','Index status differs from track snapshot','warning');
      }
    } catch(e) { issue('index','unreadable_snapshot',e.message); }
  } else issue('index','index_not_written','Index not yet written','warning');
  report.errors=report.issues.filter(x=>x.severity==='error').length;
  report.warnings=report.issues.length-report.errors;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), rootArg=args.find(x=>x.startsWith('--root='));
  const report=validateRepository(rootArg ? rootArg.slice(7) : process.cwd(),{hashAudio:!args.includes('--skip-audio-hash')});
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.errors ? 1 : 0;
}
