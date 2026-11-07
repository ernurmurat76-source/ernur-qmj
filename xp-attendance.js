'use strict';
const crypto=require('crypto');
module.exports=function createAttendance({dbRequest,authenticatedTeacher,readJson,sendJson,secret}){
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const sign=v=>crypto.createHmac('sha256',secret).update(v).digest('base64url');
const tokenFor=id=>{const p=encode({id,exp:Date.now()+7*86400000});return p+'.'+sign(p)};
function studentFrom(req){const token=String(req.headers['x-student-token']||'');const [p,s]=token.split('.');if(!p||!s||s!==sign(p))return null;try{const data=JSON.parse(Buffer.from(p,'base64url').toString());return data.exp>Date.now()?data.id:null}catch{return null}}
function passwordHash(password,salt){return salt+':'+crypto.scryptSync(password,salt,64).toString('hex')}
function passwordMatches(password,stored){const [salt,digest]=String(stored).split(':');if(!salt||!digest)return false;const a=Buffer.from(passwordHash(password,salt).split(':')[1],'hex'),b=Buffer.from(digest,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
const q=v=>encodeURIComponent(v);
const rows=async resource=>await dbRequest(resource);
const post=async(resource,body)=>await dbRequest(resource,{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(body)});
return async function(req,res,pathname){
if(!pathname.startsWith('/api/xp/'))return false;
try{
if(!secret)return sendJson(res,503,{error:'ACCESS_CODE_SECRET орнатылмаған'});
if(pathname==='/api/xp/student/login'&&req.method==='POST'){
const b=await readJson(req);const login=String(b.login||'').trim().toLowerCase();
if(!/^[a-z0-9_-]{4,40}$/.test(login)||String(b.password||'').length>200)return sendJson(res,401,{error:'Логин немесе құпиясөз қате'});
const found=await rows('xp_students?login=eq.'+q(login)+'&active=eq.true&select=id,full_name,password_hash&limit=1');
if(!found?.[0]||!passwordMatches(String(b.password||''),found[0].password_hash))return sendJson(res,401,{error:'Логин немесе құпиясөз қате'});
return sendJson(res,200,{token:tokenFor(found[0].id),name:found[0].full_name});
}
if(pathname==='/api/xp/student/scan'&&req.method==='POST'){
const id=studentFrom(req);if(!id)return sendJson(res,401,{error:'Оқушы кабинетіне кіріңіз'});
const b=await readJson(req);const challenge=String(b.challenge||'');
if(!/^[a-f0-9]{64}$/.test(challenge))return sendJson(res,400,{error:'QR қате'});
const result=await post('rpc/xp_scan',{p_student:id,p_challenge_hash:hash(challenge)});
return sendJson(res,200,{status:'pending',attendanceId:result});
}
const teacher=await authenticatedTeacher(req);
if(!teacher)return sendJson(res,401,{error:'Мұғалім кабинетіне кіріңіз'});
if(pathname==='/api/xp/classes'&&req.method==='GET'){
const classes=await rows('xp_classes?teacher_id=eq.'+q(teacher.id)+'&select=id,title&order=created_at.desc');
return sendJson(res,200,{classes});
}
if(pathname==='/api/xp/classes'&&req.method==='POST'){
const classes=await rows('xp_classes?teacher_id=eq.'+q(teacher.id)+'&select=id&limit=1');
if(classes?.length)return sendJson(res,409,{error:'Сынып бұрыннан құрылған'});
const created=await post('xp_classes',{teacher_id:teacher.id,title:'9 А'});
return sendJson(res,201,{classId:created[0].id});
}
const match=pathname.match(/^\/api\/xp\/classes\/([0-9a-f-]+)\/(students|sessions|attendance)$/);
if(match){
const classId=match[1],section=match[2];
const owned=await rows('xp_classes?id=eq.'+q(classId)+'&teacher_id=eq.'+q(teacher.id)+'&select=id&limit=1');
if(!owned?.length)return sendJson(res,403,{error:'Сыныпқа рұқсат жоқ'});
if(section==='students'&&req.method==='POST'){
const b=await readJson(req);const name=String(b.name||'').trim(),login=String(b.login||'').trim().toLowerCase();
if(name.length<3||name.length>120||!/^[a-z0-9_-]{4,40}$/.test(login))return sendJson(res,400,{error:'Аты немесе логині қате'});
const password=crypto.randomBytes(12).toString('base64url');
const created=await post('xp_students',{class_id:classId,full_name:name,login,password_hash:passwordHash(password,crypto.randomBytes(16).toString('hex'))});
return sendJson(res,201,{id:created[0].id,login,password});
}
if(section==='students'&&req.method==='GET'){
const students=await rows('xp_students?class_id=eq.'+q(classId)+'&select=id,full_name,login,active&order=full_name.asc');
return sendJson(res,200,{students});
}
if(section==='sessions'&&req.method==='POST'){
const challenge=crypto.randomBytes(32).toString('hex');
const created=await post('xp_sessions',{class_id:classId,challenge_hash:hash(challenge),expires_at:new Date(Date.now()+120000).toISOString()});
return sendJson(res,201,{sessionId:created[0].id,challenge,expiresAt:created[0].expires_at});
}
if(section==='attendance'&&req.method==='GET'){
const sessions=await rows('xp_sessions?class_id=eq.'+q(classId)+'&select=id,starts_at&order=starts_at.desc&limit=1');
if(!sessions?.length)return sendJson(res,200,{attendance:[]});
const attendance=await rows('xp_attendance?session_id=eq.'+q(sessions[0].id)+'&select=id,student_id,status,scanned_at');
return sendJson(res,200,{attendance});
}
}
if(pathname==='/api/xp/confirm'&&req.method==='POST'){
const b=await readJson(req);if(!/^[0-9a-f-]{36}$/i.test(String(b.attendanceId||'')))return sendJson(res,400,{error:'Қате ID'});
const result=await post('rpc/xp_confirm',{p_attendance:b.attendanceId,p_teacher:teacher.id});
return sendJson(res,200,{confirmed:result===true});
}
return sendJson(res,404,{error:'XP API табылмады'});
}catch(e){return sendJson(res,Number(e.status)||500,{error:Number(e.status)>=500?'XP жүйесінде қате':e.message})}
};
};
