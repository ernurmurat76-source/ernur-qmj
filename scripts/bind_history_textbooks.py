#!/usr/bin/env python3
"""Bind uploaded history/law textbooks to topic-matched QMJ records."""
from __future__ import annotations
import hashlib, json, os, re, subprocess, tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
import fitz
from PIL import Image, ImageEnhance, ImageOps

ROOT=Path(__file__).resolve().parents[1]
DB=ROOT/'data/qmj-reference-index.json'
BOOK_ROOT=ROOT.parent/'history_books'
CACHE=ROOT.parent/'history_ocr_cache'
OUT=ROOT/'public/history-excerpts'
TESSDATA=ROOT.parent/'upload'
SUBJECTS={'Қазақстан тарихы','Дүниежүзі тарихы','Құқық негіздері'}
STOP={'және','мен','пен','бен','үшін','туралы','бойынша','деген','қандай','қалай','неге','болды','болған','оның','олардың','бір','сабақ','тақырыбы','зерттеу','сұрағы','тарихы','негіздері'}

BOOKS={
 ('Қазақстан тарихы',5,''):['kazah tarih/kazah tarih 1 (2).pdf'],
 ('Қазақстан тарихы',6,''):['kazah tarih/kazah tarih 1 (3).pdf'],
 ('Қазақстан тарихы',7,''):['kazah tarih/kazah tarih 1 (5).pdf'],
 ('Қазақстан тарихы',9,''):['kazah tarih/kazah tarih 1 (6).pdf'],
 ('Қазақстан тарихы',10,''):['kazah tarih/10 snyp.pdf'],
 ('Қазақстан тарихы',11,'ЖМБ'):['kazah tarih/kazah tarih 1 (1).pdf'],
 ('Қазақстан тарихы',11,'ҚГБ'):['kazah tarih/kazah tarih 1 (1).pdf'],
 ('Дүниежүзі тарихы',5,''):['Dunie juzi tarih/5 snyp.pdf'],
 ('Дүниежүзі тарихы',6,''):['Dunie juzi tarih/6 snyp.pdf'],
 ('Дүниежүзі тарихы',7,''):['Dunie juzi tarih/7 synp.pdf'],
 ('Дүниежүзі тарихы',8,''):['Dunie juzi tarih/8 snyp.pdf'],
 ('Дүниежүзі тарихы',9,''):['Dunie juzi tarih/9 synp 1 bolim.pdf','Dunie juzi tarih/9 synp 2 bolim.pdf'],
 ('Дүниежүзі тарихы',10,'ЖМБ'):['Dunie juzi tarih/10 snyp 1 bolim.pdf','Dunie juzi tarih/10 snyp 2 bolim.pdf'],
 ('Дүниежүзі тарихы',10,'ҚГБ'):['Dunie juzi tarih/10 snyp 1 bolim.pdf','Dunie juzi tarih/10 snyp 2 bolim.pdf'],
 ('Дүниежүзі тарихы',11,'ЖМБ'):['Dunie juzi tarih/11 snyp 1 bolim.pdf','Dunie juzi tarih/11 snyp 2 bolim.pdf'],
 ('Дүниежүзі тарихы',11,'ҚГБ'):['Dunie juzi tarih/11 snyp 1 bolim.pdf','Dunie juzi tarih/11 snyp 2 bolim.pdf'],
 ('Құқық негіздері',9,''):['Quqyq negizderi/9 snyp.pdf'],
 ('Құқық негіздері',10,'ЖМБ'):['Quqyq negizderi/10 snyp.pdf'],
 ('Құқық негіздері',10,'ҚГБ'):['Quqyq negizderi/10 snyp 1 bolim.pdf','Quqyq negizderi/10 snyp 2 bolim.pdf'],
 ('Құқық негіздері',11,'ЖМБ'):['Quqyq negizderi/11 snyp 1 bolim.pdf','Quqyq negizderi/11 snyp 2 bolim.pdf'],
 ('Құқық негіздері',11,'ҚГБ'):['Quqyq negizderi/11 snyp 1 bolim.pdf','Quqyq negizderi/11 snyp 2 bolim.pdf'],
}

def norm(v):
 v=str(v or '').lower().replace('ё','е'); v=re.sub(r'зерттеу\s+сұрағы\s*:',' ',v); v=re.sub(r'[^0-9a-zа-яәіңғүұқөһ]+',' ',v)
 return re.sub(r'\s+',' ',v).strip()
def words(v): return {w for w in norm(v).split() if len(w)>=4 and w not in STOP}
def cache_path(pdf): return CACHE/f"{pdf.stem}-{hashlib.sha1(str(pdf.relative_to(BOOK_ROOT)).encode()).hexdigest()[:12]}.json"

def ocr_book(relative):
 pdf=BOOK_ROOT/relative; target=cache_path(pdf)
 if target.exists(): return relative,len(json.loads(target.read_text(encoding='utf-8'))['pages'])
 doc=fitz.open(pdf); embedded=[p.get_text('text').strip() for p in doc]
 useful=[re.sub(r'bilimland|copyright|https?\S+|\d+','',t,flags=re.I) for t in embedded]
 if sum(len(t)>450 for t in useful)>=len(doc)*.55: texts=embedded
 else:
  with tempfile.TemporaryDirectory(prefix='history-ocr-') as tmp:
   side=Path(tmp)/'sidecar.txt'; output=Path(tmp)/'searchable.pdf'; env=os.environ.copy(); env['TESSDATA_PREFIX']=str(TESSDATA)
   p=subprocess.run(['ocrmypdf','--skip-text','--jobs','2','--optimize','0','--output-type','pdf','--tesseract-timeout','15','--tesseract-pagesegmode','6','-l','kaz+rus','--sidecar',str(side),str(pdf),str(output)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env)
   if not side.exists(): raise RuntimeError(f'OCR failed ({p.returncode}): {relative}')
   texts=side.read_text(encoding='utf-8',errors='replace').split('\f'); texts=(texts+['']*len(doc))[:len(doc)]
 pages=[{'page':i+1,'text':t} for i,t in enumerate(texts)]; target.parent.mkdir(parents=True,exist_ok=True)
 target.write_text(json.dumps({'book':relative,'pages':pages},ensure_ascii=False),encoding='utf-8'); return relative,len(pages)

def score(topic,section,text):
 tw,sw,pw=words(topic),words(section),words(text)
 if not tw:return 0
 hit=sum(w in pw for w in tw); partial=sum(w not in pw and any(len(w)>=6 and (w[:6] in p or p[:6] in w) for p in pw) for w in tw)
 return hit*3+partial*1.2+min(sum(w in pw for w in sw),4)*.5+(4 if norm(topic) and norm(topic) in norm(text) else 0)
def marker(text):
 n=norm(text); return any(x in n for x in ('тапсырма','сұрақтар','сұрақ пен тапсырма','ойланып','тексеріңдер','орындаңдар'))
def choose(record,rels):
 cand=[]
 for rel in rels:
  pages=json.loads(cache_path(BOOK_ROOT/rel).read_text(encoding='utf-8'))['pages']
  for i,p in enumerate(pages):
   s=score(record.get('topic'),record.get('section'),p['text'])
   if s:cand.append((s,rel,i,pages))
 if not cand:return None
 s,rel,i,pages=max(cand,key=lambda x:x[0]); nearby=[j for j in range(i,min(i+9,len(pages))) if marker(pages[j]['text'])]
 return rel,(nearby[0] if nearby else i)+1,s
def excerpt(rel,page,rid):
 token=hashlib.sha256(f'{rel}|{page}|{rid}'.encode()).hexdigest()[:20]; name=f'task-{token}.jpg'; target=OUT/name
 if target.exists():return f'/history-excerpts/{name}'
 p=fitz.open(BOOK_ROOT/rel)[page-1]; pix=p.get_pixmap(matrix=fitz.Matrix(2,2),colorspace=fitz.csRGB,alpha=False)
 im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples); im=im.crop((int(im.width*.055),int(im.height*.045),int(im.width*.945),int(im.height*.955)))
 im=ImageEnhance.Contrast(ImageOps.autocontrast(im)).enhance(1.08)
 if im.width>1500:im.thumbnail((1500,2100),Image.Resampling.LANCZOS)
 OUT.mkdir(parents=True,exist_ok=True); im.save(target,'JPEG',quality=88,optimize=True); return f'/history-excerpts/{name}'

def main():
 rels=sorted({x for xs in BOOKS.values() for x in xs}); missing=[x for x in rels if not (BOOK_ROOT/x).is_file()]
 if missing:raise SystemExit(f'Missing: {missing}')
 CACHE.mkdir(parents=True,exist_ok=True)
 with ProcessPoolExecutor(max_workers=min(4,len(rels),os.cpu_count() or 2)) as pool:
  jobs=[pool.submit(ocr_book,x) for x in rels]
  for f in as_completed(jobs):
   r,n=f.result(); print(f'OCR {r}: {n} pages',flush=True)
 data=json.loads(DB.read_text(encoding='utf-8')); bound=unavailable=low=0
 for r in data['records']:
  if r.get('subject') not in SUBJECTS:continue
  key=(r['subject'],int(r['grade']),str(r.get('track',''))); rels=BOOKS.get(key); flags=[x for x in r.get('quality_flags',[]) if x!='textbook_binding_pending']
  if not rels: unavailable+=1; r['quality_flags']=list(dict.fromkeys(flags+['textbook_not_supplied'])); continue
  m=choose(r,rels)
  if not m or m[2]<4: low+=1; r['quality_flags']=list(dict.fromkeys(flags+['textbook_topic_not_matched'])); continue
  rel,page,s=m; r['textbook_task']={'visual':excerpt(rel,page,r['id']),'page':page,'book':rel,'match_score':round(s,2)}
  r['quality_flags']=list(dict.fromkeys(flags+['textbook_topic_matched','textbook_task_image'])); r.setdefault('source',{})['publisher_task_status']='teacher-supplied textbook task excerpt embedded'; bound+=1
 data['history_textbook_binding']={'bound':bound,'unavailable_book':unavailable,'low_confidence':low,'generated_by':'scripts/bind_history_textbooks.py'}
 DB.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); print(json.dumps(data['history_textbook_binding'],ensure_ascii=False))
if __name__=='__main__':main()
