"""Generate unverified, per-audio rigid-shift drafts. Never marks human verification."""
import os,json,pathlib,hashlib,re,time,difflib,whisper,sys,unicodedata
sys.stdout.reconfigure(encoding='utf-8')
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'data/lyrics';os.environ['PATH']=str(ROOT/'tools/ffmpeg')+os.pathsep+os.environ['PATH'];model=None
sys.path.insert(0,str(ROOT/'.tmp/lyrics-python-deps'))
from opencc import OpenCC
_converter=OpenCC('t2s')
norm=lambda s:re.sub(r'[^\w\u3040-\u30ff\u3400-\u9fff]','',_converter.convert(unicodedata.normalize('NFKC',str(s))).lower(),flags=re.UNICODE)
def save(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def is_content(x):
 text=x['text'].strip()
 return not re.match(r'^(作[词曲]|编曲|词|曲|制作人?|翻译|翻唱|策划|混音(?:师)?|录音(?:师)?|出品(?:人)?|监制|演唱|歌手|和声|吉他|贝斯|母带|小提琴|钢琴|弦乐|鼓|作詞|作編曲|編曲|Vocal|Lyrics|Music|Composer|Arranger|Producer|Guitar|Piano)\s*[:：]',text,re.I) and not re.match(r'^(music\s*\.*|间奏|純音樂|纯音乐|此歌曲|本歌曲|歌词来自|未经许可|未经著作权人)',text,re.I)
def detect(result,target,base):
 t=norm(target);best=None
 words=[w for seg in result['segments'] for w in seg.get('words',[])]
 for i in range(len(words)):
  phrase=''
  for j in range(i,min(len(words),i+45)):
   if j>i and words[j]['start']-words[j-1]['end']>2:break
   phrase+=norm(words[j]['word'])
   if not phrase:continue
   too_long=len(phrase)>max(6,len(t)*1.8)
   if too_long and not phrase.startswith(t):break
   score=difflib.SequenceMatcher(None,t,phrase[:len(t)] if too_long else phrase).ratio()
   if len(t)<3:score*=.6
   if best is None or score>best['similarity']:
    best={'audioSeconds':round(base+words[i]['start'],3),'endSeconds':round(base+words[j]['end'],3),'similarity':score,'recognizedText':''.join(w['word'] for w in words[i:j+1]),'meanProbability':round(sum(w['probability'] for w in words[i:j+1])/(j-i+1),3),'tokenPrefixOnly':too_long}
   if too_long:break
 return best
def transcribe(audio,base,end,lang,key,label,sha):
 evidence=D/'evidence';evidence.mkdir(exist_ok=True);p=evidence/(key+'-'+label+'.json')
 if p.exists():
  v=json.loads(p.read_text(encoding='utf-8'))
  if v['audioSha256']==sha and v['start']==base and v['end']==end:return v['result'],str(p.relative_to(D)).replace('\\','/')
 res=model.transcribe(audio[int(base*16000):int(end*16000)],language=lang,fp16=False,word_timestamps=True,temperature=0,condition_on_previous_text=False)
 save(p,{'audioSha256':sha,'model':'whisper-base','start':base,'end':end,'result':res});return res,str(p.relative_to(D)).replace('\\','/')
if '--retry' in sys.argv:
 for p in (D/'tracks').glob('*.json'):
  r=json.loads(p.read_text(encoding='utf-8'))
  if r['alignment']['status'] in ['anchor_not_found','spotcheck_review_required','timing_drift_review_required','alignment_error'] and r['match'].get('sourcePath') and r['audio'].get('sha256'):
   r['alignment']={'status':'pending_asr','offsetSeconds':None,'humanVerified':False};save(p,r)
seen=set();start=time.time()
while time.time()-start<2400:
 for p in sorted((D/'tracks').glob('*.json')):
  if p.name in seen:continue
  r=json.loads(p.read_text(encoding='utf-8'));a=r.get('alignment',{})
  if a.get('status')!='pending_asr':continue
  seen.add(p.name)
  if r['match']['status'] in ['version_review_required','instrumental','no_timed_lyrics']:
   r['alignment']={'status':'version_review_required','offsetSeconds':None,'humanVerified':False};save(p,r);continue
  try:
   source=json.loads((D/r['match']['sourcePath']).read_text(encoding='utf-8'));lines=[x for x in source['lines'] if is_content(x) and norm(x['text'])!=norm(r['songName'])];local=ROOT/r['audio']['url'].split('?')[0]
   if hashlib.sha256(local.read_bytes()).hexdigest()!=r['audio']['sha256']:raise ValueError('audio hash changed')
   if not lines:raise ValueError('no lyrical line')
   if model is None:model=whisper.load_model('base')
   audio=whisper.load_audio(str(local));duration=len(audio)/16000
   lang='ja' if '日' in r.get('language','') and '中文' not in r.get('language','') else 'zh' if '中文' in r.get('language','') else None
   length=min(duration,65,max(35,lines[0]['t']+20));result,ep=transcribe(audio,0,length,lang,r['key'],'first',r['audio']['sha256'])
   first=detect(result,lines[0]['text'],0);a={'status':'anchor_not_found','evidencePath':ep,'method':'whisper-base-first-line-rigid-shift','humanVerified':False,'audioDurationSeconds':round(duration,3),'sourceFirstLine':lines[0],'anchorCandidate':first,'offsetSeconds':None,'checks':[],'asrLanguage':result.get('language'),'caveat':'ASR candidate only. No listening confirmation. Uniform offset does not prove lyric edition or completeness.'}
   if first and first['similarity']>=.72 and first['meanProbability']>=.35:
    delta=round(first['audioSeconds']-lines[0]['t'],3);a['offsetSeconds']=delta;a['status']='asr_anchor_candidate'
    if abs(delta)>45:a['status']='large_offset_review_required'
    else:
     targets=[]
     for fraction in [.5,.9]:
      candidates=[x for x in lines if 15<x['t']+delta<duration-4 and x!=lines[0] and all(abs(x['t']-t['t'])>=15 for t in targets)]
      if candidates:targets.append(min(candidates,key=lambda x:abs(x['t']+delta-duration*fraction)))
     for n,target in enumerate(targets):
      at=target['t']+delta;base=max(0,at-6);end=min(duration,at+14)
      res,cep=transcribe(audio,base,end,lang,r['key'],'check'+str(n),r['audio']['sha256']);hit=detect(res,target['text'],base)
      a['checks'].append({'sourceLine':target,'evidencePath':cep,'candidate':hit,'residualSeconds':round(hit['audioSeconds']-at,3) if hit else None})
     good=[x for x in a['checks'] if x['candidate'] and x['candidate']['similarity']>=.72 and x['candidate']['meanProbability']>=.35]
     if len(good)==2 and all(abs(x['residualSeconds'])<=1.25 for x in good):a['status']='asr_consistent_draft'
     elif any(abs(x['residualSeconds'])>2 for x in good):a['status']='timing_drift_review_required'
     else:a['status']='spotcheck_review_required'
   r['alignment']=a;save(p,r);print(json.dumps({'key':r['key'],'name':r['songName'],'status':a['status'],'offset':a['offsetSeconds']},ensure_ascii=False),flush=True)
  except Exception as e:r['alignment']={**a,'status':'alignment_error','error':str(e),'humanVerified':False};save(p,r);print(str(e),flush=True)
 index=D/'index.json'
 if index.exists():
  v=json.loads(index.read_text(encoding='utf-8'))
  if not any(json.loads(p.read_text(encoding='utf-8'))['alignment']['status']=='pending_asr' for p in (D/'tracks').glob('*.json')):break
 time.sleep(2)
print('ALIGNMENT_PASS_FINISHED',len(seen),flush=True)
