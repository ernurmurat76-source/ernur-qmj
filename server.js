'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PptxGenJS = require('pptxgenjs');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFERENCE_PATH = path.join(__dirname, 'data', 'qmj-reference-index.json');
const REFERENCE_DOCX_DIR = path.join(__dirname, 'data', 'reference-docx');
const SUBJECTS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'subjects.json'), 'utf8'));
const SOCIAL_SUBJECTS = new Set(['Қазақстан тарихы', 'Дүниежүзі тарихы', 'Құқық негіздері']);
const AI_FREE_SUBJECTS = new Set(['Математика', 'Алгебра', 'Геометрия', ...SOCIAL_SUBJECTS]);
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'openrouter').toLowerCase();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || (AI_PROVIDER === 'openai' ? 'gpt-4.1-mini' : 'openrouter/free');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ACCESS_CODE_SECRET = process.env.ACCESS_CODE_SECRET || '';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const loginAttempts = new Map();
let referenceDatabase = { records: [] };
try {
  referenceDatabase = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
  if (!Array.isArray(referenceDatabase.records)) referenceDatabase.records = [];
} catch (error) {
  console.error('ҚМЖ анықтамалық базасы жүктелмеді:', error.message);
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', ACCESS_CODE_SECRET).update(value).digest('base64url');
}

function safeEqual(first, second) {
  const a = Buffer.from(String(first));
  const b = Buffer.from(String(second));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAccessCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  const value = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
  return `ERNUR-${value.slice(0, 5)}-${value.slice(5)}`;
}

function databaseReady() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

async function dbRequest(resource, options = {}) {
  if (!databaseReady()) throw Object.assign(new Error('Supabase дерекқоры серверде бапталмаған'), { status: 503 });
  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (SUPABASE_SECRET_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
    ...options,
    headers
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.hint || 'Дерекқор қатесі'), { status: response.status });
  return data;
}

function createAdminSession() {
  const payload = encode(JSON.stringify({ v: 1, role: 'admin', exp: Math.floor(Date.now() / 1000) + 8 * 3600 }));
  return `ADMIN.${payload}.${sign(payload)}`;
}

function verifyAdminSession(token) {
  if (!ACCESS_CODE_SECRET) return false;
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'ADMIN' || !safeEqual(sign(parts[1]), parts[2])) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.v === 1 && payload.role === 'admin' && payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function createTeacherSession(account) {
  const payload = encode(JSON.stringify({
    v: 1,
    role: 'teacher',
    sub: account.id,
    accessCodeId: account.access_code_id,
    exp: Math.floor(Date.now() / 1000) + 30 * 86400
  }));
  return `TEACHER.${payload}.${sign(payload)}`;
}

function verifyTeacherSession(token) {
  if (!ACCESS_CODE_SECRET) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'TEACHER' || !safeEqual(sign(parts[1]), parts[2])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.role !== 'teacher' || !payload.sub || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function teacherProfile(record) {
  return {
    id: record.id,
    fullName: record.full_name,
    email: record.email,
    phone: record.phone || '',
    school: record.school || '',
    subject: record.subject || '',
    createdAt: record.created_at
  };
}

function requestTeacherToken(req) {
  return String(req.headers['x-teacher-token'] || '').trim();
}

async function authenticatedTeacher(req) {
  const session = verifyTeacherSession(requestTeacherToken(req));
  if (!session) return null;
  const rows = await dbRequest(`teacher_accounts?id=eq.${encodeURIComponent(session.sub)}&select=id,access_code_id,full_name,email,phone,school,subject,created_at&limit=1`);
  return rows?.[0] || null;
}

function deviceFingerprint(deviceId) {
  const normalized = String(deviceId || '').trim();
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(normalized)) return '';
  return crypto.createHmac('sha256', ACCESS_CODE_SECRET).update(`device:${normalized}`).digest('hex');
}

async function verifyAccessCode(code, trackUsage = false, deviceId = '') {
  if (!databaseReady()) return { ok: false, status: 503, error: 'Код дерекқоры серверде бапталмаған' };
  const normalized = String(code || '').trim().toUpperCase();
  const fingerprint = deviceFingerprint(deviceId);
  if (!fingerprint) return { ok: false, status: 400, error: 'Құрылғы белгісі табылмады. Бетті жаңартып көріңіз' };
  if (!/^ERNUR-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(normalized)) return { ok: false, status: 401, error: 'Кіру коды қате' };
  const select = 'id,code,duration_days,expires_at,is_active,usage_count,allowed_subjects,bound_device_1,bound_device_2,bound_device_1_at,bound_device_2_at';
  const rows = await dbRequest(`access_codes?code=eq.${encodeURIComponent(normalized)}&select=${select}&limit=1`);
  let record = rows?.[0];
  if (!record) return { ok: false, status: 401, error: 'Кіру коды қате' };
  if (!record.is_active) return { ok: false, status: 401, error: 'Бұл кіру кодын әкімші тоқтатқан' };
  if (new Date(record.expires_at).getTime() <= Date.now()) return { ok: false, status: 401, error: 'Кіру кодының мерзімі аяқталған' };
  const matchesDevice = item => [item?.bound_device_1, item?.bound_device_2].some(value => value && safeEqual(value, fingerprint));
  if (!matchesDevice(record) && !record.bound_device_1) {
    const bound = await dbRequest(`access_codes?id=eq.${encodeURIComponent(record.id)}&bound_device_1=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ bound_device_1: fingerprint, bound_device_1_at: new Date().toISOString() })
    });
    if (bound?.[0]) record = bound[0];
    else {
      const latest = await dbRequest(`access_codes?id=eq.${encodeURIComponent(record.id)}&select=${select}&limit=1`);
      record = latest?.[0];
    }
  }
  if (!matchesDevice(record) && !record.bound_device_2) {
    const bound = await dbRequest(`access_codes?id=eq.${encodeURIComponent(record.id)}&bound_device_2=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ bound_device_2: fingerprint, bound_device_2_at: new Date().toISOString() })
    });
    if (bound?.[0]) record = bound[0];
    else {
      const latest = await dbRequest(`access_codes?id=eq.${encodeURIComponent(record.id)}&select=${select}&limit=1`);
      record = latest?.[0];
    }
  }
  if (!matchesDevice(record)) return { ok: false, status: 403, error: 'Бұл код екі құрылғыға бекітілген. Үшінші құрылғыдан кіруге болмайды' };
  if (trackUsage) {
    dbRequest(`access_codes?id=eq.${encodeURIComponent(record.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_used_at: new Date().toISOString(), usage_count: Number(record.usage_count || 0) + 1 })
    }).catch(error => console.error('Код статистикасы жаңармады:', error.message));
  }
  return { ok: true, record };
}

function normalizeAllowedSubjects(value) {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(input.map(item => String(item || '').trim()).filter(item => SUBJECTS.includes(item)))];
}

function codeAllowsSubject(record, subject) {
  return normalizeAllowedSubjects(record?.allowed_subjects).includes(String(subject || '').trim());
}

function requestAccessCode(req, body = {}) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : String(body.accessCode || '').trim();
}

function requestDeviceId(req) {
  return String(req.headers['x-device-id'] || '').trim();
}

function requestBearer(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function loginAttemptKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function loginBlocked(req) {
  const attempt = loginAttempts.get(loginAttemptKey(req));
  if (!attempt) return false;
  if (attempt.blockedUntil > Date.now()) return true;
  if (attempt.blockedUntil) loginAttempts.delete(loginAttemptKey(req));
  return false;
}

function recordLoginFailure(req) {
  const key = loginAttemptKey(req);
  const attempt = loginAttempts.get(key) || { count: 0, blockedUntil: 0 };
  attempt.count += 1;
  if (attempt.count >= 5) attempt.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(key, attempt);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1000000) reject(new Error('Сұраныс көлемі тым үлкен'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('Сұраныс форматы қате')); }
    });
    req.on('error', reject);
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function asList(value, fallback) {
  const list = Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
  return list.length ? list : fallback;
}

function splitText(value, fallback = []) {
  const list = String(value || '')
    .split(/\n+|(?<=[.!?])\s+(?=[А-ЯӘІҢҒҮҰҚӨҺA-Z])/u)
    .map(item => item.replace(/^[•\-–—\d.)\s]+/, '').trim())
    .filter(item => item.length > 2)
    .slice(0, 8);
  return list.length ? list : fallback;
}

function normalizedWords(value) {
  return new Set(String(value || '').toLocaleLowerCase('kk-KZ').match(/[а-яәіңғүұқөһa-z0-9]{3,}/giu) || []);
}

function referenceSummaries(grade, subject, term = 0) {
  const gradeNumber = Number(String(grade || '').match(/\d+/)?.[0]);
  return referenceDatabase.records
    .filter(item => item.grade === gradeNumber && item.subject === subject && (!term || item.term === term))
    .map(item => ({
      id: item.id,
      lessonNumbers: item.lesson_numbers,
      section: item.section,
      topic: item.topic || `Сабақ ${item.lesson_numbers?.join('–') || ''}`,
      objectives: item.objectives,
      qualityFlags: item.quality_flags
    }));
}

function selectReference(body) {
  const gradeNumber = Number(String(body.grade || '').match(/\d+/)?.[0]);
  const term = Number(body.term || 0);
  const requestedTrack = String(body.track || '').trim().toLocaleUpperCase('kk-KZ');
  const candidates = referenceDatabase.records.filter(item => {
    if (item.grade !== gradeNumber || item.subject !== body.subject) return false;
    if (!requestedTrack) return true;
    const itemTrack = String(item.track || '').trim().toLocaleUpperCase('kk-KZ');
    return !itemTrack || itemTrack === requestedTrack;
  });
  if (!candidates.length) return null;
  const exact = candidates.find(item => item.id === body.referenceId);
  if (exact) return exact;
  const topicWords = normalizedWords(body.topic);
  const objectiveCodes = String(body.objective || '').match(/\b\d{1,2}(?:\.\d+){2,}\b/g) || [];
  let best = null;
  let bestScore = -1;
  for (const item of candidates) {
    let score = 0;
    const itemTopic = String(item.topic || '').toLocaleLowerCase('kk-KZ').replace(/\s+/g, ' ').trim();
    const requestedTopic = String(body.topic || '').toLocaleLowerCase('kk-KZ').replace(/\s+/g, ' ').trim();
    if (itemTopic && itemTopic === requestedTopic) score += 100;
    for (const code of objectiveCodes) if (item.objective_codes?.includes(code)) score += 25;
    const words = normalizedWords(`${item.topic} ${item.section}`);
    for (const word of topicWords) if (words.has(word)) score += 1;
    if (String(item.section || '').toLocaleLowerCase('kk-KZ') === String(body.section || '').toLocaleLowerCase('kk-KZ')) score += 10;
    if (term && item.term === term) score += 4;
    if (requestedTrack && String(item.track || '').trim().toLocaleUpperCase('kk-KZ') === requestedTrack) score += 8;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 3 || AI_FREE_SUBJECTS.has(body.subject) ? best : null;
}

function distributeMinutes(stages) {
  if (!stages.length) return [];
  const defaults = stages.length === 3 ? [8, 30, 7] : Array(stages.length).fill(Math.floor(45 / stages.length));
  const source = stages.map((stage, index) => Number(stage.minutes) > 0 ? Number(stage.minutes) : defaults[index] || 5);
  const total = source.reduce((sum, value) => sum + value, 0) || 45;
  const result = source.map(value => Math.max(1, Math.round(value * 45 / total)));
  result[result.length - 1] += 45 - result.reduce((sum, value) => sum + value, 0);
  return result;
}

function planFromReference(reference, body) {
  if (!reference) return demoPlan(body);
  if (reference.prepared_plan) return normalizePlan(reference.prepared_plan, body, null);
  if (SOCIAL_SUBJECTS.has(body.subject)) return socialStudiesPlan(body, reference);
  const usable = reference.stages.filter(stage => stage.teacher || stage.learner);
  if (!usable.length) return curriculumPlan(body, reference);
  const organization = usable[0];
  const detectedEndingIndex = usable.findLastIndex(stage => /соңы|қорытынды|рефлек/i.test(stage.stage || ''));
  const endingIndex = detectedEndingIndex > 1 ? detectedEndingIndex : Math.max(1, usable.length - 1);
  const beginningIndex = usable.findIndex((stage, index) => index > 0 && index < endingIndex && /басы|кіріспе/i.test(stage.stage || ''));
  const actualBeginningIndex = beginningIndex > 0 ? beginningIndex : 1;
  const ending = usable[endingIndex] || usable[usable.length - 1];
  const middleParts = usable.filter((stage, index) => index > actualBeginningIndex && index < endingIndex);
  if (!middleParts.length && usable[actualBeginningIndex]) middleParts.push(usable[actualBeginningIndex]);
  const merge = (parts, key, fallback) => parts.flatMap(stage => splitText(stage?.[key], [])).filter(Boolean).length
    ? parts.flatMap(stage => splitText(stage?.[key], [])).filter(Boolean)
    : fallback;
  const endingTeacher = splitText(ending?.teacher, ['Сабақты қорытындылайды.']);
  const endingLearner = splitText(ending?.learner, []);
  if (!endingTeacher.some(item => /ББҮ/i.test(item))) endingTeacher.push('ББҮ кестесі арқылы сабақ нәтижесін қорытындылауды ұйымдастырады.');
  if (!endingLearner.some(item => /ББҮ/i.test(item))) endingLearner.push('ББҮ кестесін толтырады: «Білемін», «Білгім келеді», «Үйрендім».');
  const stages = [
    {
      name: 'Ұйымдастыру кезеңі', minutes: 5, method: 'Сабаққа дайындық', workForm: 'Бүкіл сыныппен жұмыс',
      teacherActions: splitText(organization?.teacher, ['Сәлемдесу.', 'Оқушыларды түгелдеу.', 'Сабақтың мақсатымен таныстыру.']),
      learnerActions: splitText(organization?.learner, ['Сабаққа дайындалады.']), descriptors: [],
      feedback: splitText(organization?.assessment, ['Ауызша бағалау']).join(' '), resources: splitText(organization?.resources, ['Оқу құралдары']).slice(0, 5), support: ''
    },
    {
      name: 'Сабақтың басы', minutes: 10, method: 'Алдыңғы білімді еске түсіру', workForm: 'Бүкіл сыныппен жұмыс',
      teacherActions: splitText(usable[actualBeginningIndex]?.teacher, ['Алдыңғы білімді еске түсіреді.']),
      learnerActions: splitText(usable[actualBeginningIndex]?.learner, ['Сұрақтарға жауап береді.']), descriptors: [],
      feedback: splitText(usable[actualBeginningIndex]?.assessment, ['Ауызша кері байланыс']).join(' '), resources: splitText(usable[actualBeginningIndex]?.resources, ['Тақта']).slice(0, 5), support: ''
    },
    {
      name: 'Сабақтың ортасы', minutes: 25, method: 'Оқулықпен жұмыс', workForm: 'Жеке және жұптық жұмыс',
      teacherActions: merge(middleParts, 'teacher', ['Тақырыпқа сәйкес оқулық тапсырмаларын ұсынады.']),
      learnerActions: merge(middleParts, 'learner', ['Тапсырмаларды орындайды.']), descriptors: [],
      feedback: merge(middleParts, 'assessment', ['Дескриптор бойынша бағалау']).join(' '),
      resources: [...new Set(merge(middleParts, 'resources', ['Оқулық', 'Тақта']))].slice(0, 5), support: 'Қажет оқушыға үлгі немесе бастапқы қадам беріледі.'
    },
    {
      name: 'Сабақтың соңы', minutes: 5, method: 'Қорытындылау', workForm: 'Жеке жұмыс',
      teacherActions: endingTeacher, learnerActions: endingLearner, descriptors: [],
      feedback: splitText(ending?.assessment, ['Жинаған ұпайы бойынша бағаланады.']).join(' '),
      resources: [...new Set([...splitText(ending?.resources, []), 'ББҮ кестесі'])].slice(0, 5), support: ''
    }
  ];
  return {
    lessonObjectives: splitText(reference.lesson_objectives, [`${body.topic} тақырыбы бойынша оқу мақсатына жету`]),
    assessmentCriteria: ['оқу мақсатына сәйкес тапсырманы орындайды', 'шешімін немесе жауабын негіздеп түсіндіреді'],
    stages,
    differentiation: 'Қолдауды қажет ететін оқушыға үлгі мен кезеңдік нұсқаулық беріледі; дайын оқушыға дәлелдеуді қажет ететін күрделендірілген тапсырма ұсынылады.',
    safety: 'Сыныптағы қауіпсіздік және цифрлық құралдарды дұрыс пайдалану талаптары сақталады.'
  };
}

function socialStudiesPlan(body, reference) {
  const isLaw = body.subject === 'Құқық негіздері';
  const topic = String(body.topic || reference?.topic || '').trim();
  const objective = String(body.objective || reference?.objectives || '').trim();
  const researchQuestion = topic.match(/Зерттеу сұрағы:\s*(.+)$/i)?.[1] || topic;
  const lessonObjectives = splitText(objective, [`${topic} тақырыбы бойынша негізгі мазмұнды түсіндіру`]).slice(0, 4);
  const textbookVisual = reference?.textbook_task?.visual ? {
    src: reference.textbook_task.visual,
    alt: `${topic} тақырыбына арналған оқулық тапсырмасы`,
    caption: 'Оқулықтағы тапсырма'
  } : null;
  const task = (number, instruction, descriptor, points = 1, visual = null) => ({
    number, instruction, descriptor, points,
    displayMode: visual ? 'image' : 'text', visual
  });
  const sourceWord = isLaw ? 'құқықтық норма мен жағдаятты' : 'тарихи дерек пен оқулық мәтінін';
  return {
    lessonObjectives,
    assessmentCriteria: isLaw
      ? ['құқықтық ұғым мен норманы жағдаятта қолданады', 'қорытындысын құқықтық дәлелмен негіздейді']
      : ['оқиға немесе үдерістің себептері мен салдарын анықтайды', 'тарихи қорытындысын нақты дерекпен негіздейді'],
    stages: [
      {
        name: 'Ұйымдастыру кезеңі', minutes: 5, method: 'Сабаққа дайындық', workForm: 'Бүкіл сыныппен жұмыс',
        teacherActions: ['Сәлемдесу.', 'Сыныптағы оқушылардың көңіл күйлерін сұрап, жағымды ахуал туындату.', 'Оқушыларды түгелдеу.', 'Сабақтың мақсатымен таныстыру.'],
        learnerActions: ['Сабаққа дайындалады және оқу құралдарын реттейді.'], tasks: [], descriptors: [],
        feedback: 'Ауызша бағалау: «Өте жақсы», «Жарайсың».', resources: ['Оқу құралдары'], support: ''
      },
      {
        name: 'Сабақтың басы', minutes: 10, method: 'Бастапқы болжам', workForm: 'Жеке жұмыс',
        teacherActions: ['Тақырып пен зерттеу сұрағын көрсетіп, бастапқы ойды анықтайтын тапсырма береді.'],
        learnerActions: ['Алдыңғы білімін қолданып, бастапқы болжамын жазады.'], descriptors: [],
        tasks: [task(1, isLaw
          ? `«${topic}» тақырыбы бойынша негізгі құқықтық ұғымды анықтап, оның қоғамдағы маңызын бір мысалмен түсіндіріңдер.`
          : `«${researchQuestion}» сұрағына бастапқы жауап жазыңдар. Жауапта кезеңді, орынды және бір негізгі ұғымды көрсетіңдер.`,
          isLaw ? 'құқықтық ұғымды дұрыс анықтап, маңызын нақты мысалмен түсіндіреді' : 'бастапқы пікірінде кезеңді, орынды және негізгі ұғымды дұрыс көрсетеді', 2)],
        feedback: 'Нақтылаушы сұрақ арқылы бастапқы жауап толықтырылады.', resources: ['Тақта', 'Оқулық'], support: 'Негізгі ұғымдар мен сөйлем бастамалары беріледі.'
      },
      {
        name: 'Сабақтың ортасы', minutes: 25, method: isLaw ? 'Құқықтық жағдаятты талдау' : 'Дерек–дәлел–қорытынды', workForm: 'Жеке және жұптық жұмыс',
        teacherActions: [`${sourceWord} талдауға арналған төрт тапсырманы ретімен ұсынады.`, 'Жауаптың дерекке сүйенуін тексеріп, дәлелді нақтылауға бағыттайды.'],
        learnerActions: ['Оқулық мәтіні мен берілген деректерді талдайды.', 'Жауабын жұбымен салыстырып, дәлелін толықтырады.', 'Жеке қорытынды жазады.'], descriptors: [],
        tasks: isLaw ? [
          task(1, textbookVisual ? 'Оқулық үзіндісіндегі тапсырмаларды орындаңдар.' : `Оқулықтағы «${topic}» бөлігін оқып, үш негізгі құқықтық ұғымды және олардың анықтамасын кестеге жазыңдар.`, 'оқулық тапсырмасындағы құқықтық ұғымдар мен нормаларды дұрыс қолданып, жауабын негіздейді', 2, textbookVisual),
          task(2, `«${topic}» тақырыбына байланысты құқықтық жағдаят құрастырып, қатысушыларды, құқықтары мен міндеттерін анықтаңдар.`, 'жағдаяттағы тараптарды, олардың құқықтары мен міндеттерін ажыратады', 2),
          task(3, `Жағдаятты оқу мақсатына сәйкес құқықтық нормамен байланыстырып, қандай әрекет заңды немесе заңсыз екенін түсіндіріңдер.`, 'құқықтық норманы жағдаятқа дұрыс қолданып, шешімін негіздейді', 2),
          task(4, `Мәселені шешудің заңды жолын ұсыныңдар және оның ықтимал салдарын екі дәлелмен бағалаңдар.`, 'заңды шешу жолын ұсынып, ықтимал салдарын екі дәлелмен бағалайды', 2)
        ] : [
          task(1, textbookVisual ? 'Оқулық үзіндісіндегі тапсырмаларды орындаңдар.' : `Оқулықтағы «${topic}» тақырыбына қатысты мәтінді оқып, үш негізгі фактіні «уақыт – оқиға – нәтиже» кестесіне түсіріңдер.`, 'оқулық тапсырмасын орындап, жауабын тақырыпқа қатысты нақты тарихи дерекпен негіздейді', 2, textbookVisual),
          task(2, `Тақырыпқа қатысты бір тарихи деректі «авторы/жасалған уақыты – негізгі ойы – мақсаты – құндылығы» тармақтары бойынша талдаңдар.`, 'тарихи деректің авторын немесе уақытын, негізгі ойын, мақсаты мен құндылығын анықтайды', 2),
          task(3, `«${researchQuestion}» сұрағына жауап беру үшін оқиғаның кемінде екі себебі мен екі салдарын анықтап, олардың байланысын түсіндіріңдер.`, 'екі себеп пен екі салдарды анықтап, олардың өзара байланысын түсіндіреді', 2),
          task(4, `Тақырыптағы оқиға, үдеріс немесе тұлғаның тарихи маңызын екі нақты дерекпен бағалап, дәлелді қорытынды жазыңдар.`, 'тарихи маңызын екі нақты дерекпен бағалап, дәлелді қорытынды жасайды', 2)
        ],
        feedback: 'Дескриптор бойынша дәлелдің нақтылығы көрсетіліп, оқушы жауабын толықтырады.', resources: ['Оқулық', isLaw ? 'Құқықтық жағдаят кестесі' : 'Тарихи дерек', 'Тапсырма парағы'], support: 'Талдау кестесі, тірек ұғымдар және сөйлем бастамалары беріледі.'
      },
      {
        name: 'Сабақтың соңы', minutes: 5, method: 'Дәлелді қорытынды', workForm: 'Жеке жұмыс',
        teacherActions: ['Оқу мақсатына сай қысқа қорытынды тапсырма береді.', 'ББҮ кестесі арқылы сабақ нәтижесін қорытындылауды ұйымдастырады.'],
        learnerActions: ['Қорытынды жауабын жазады.', 'ББҮ кестесін толтырады: «Білемін», «Білгім келеді», «Үйрендім».'], descriptors: [],
        tasks: [task(1, isLaw
          ? `«${topic}» тақырыбы бойынша құқықтық шешімді бір тұжырым және екі дәлелмен қорытындылаңдар.`
          : `«${researchQuestion}» сұрағына бір тұжырым және екі нақты тарихи дәлелмен қорытынды жауап жазыңдар.`,
          isLaw ? 'құқықтық қорытындыны бір тұжырым және екі дәлелмен негіздейді' : 'зерттеу сұрағына бір тұжырым және екі тарихи дәлелмен жауап береді', 2)],
        feedback: 'Қорытынды жауаптың оқу мақсаты мен дәлелге сәйкестігі бойынша кері байланыс беріледі.', resources: ['ББҮ кестесі'], support: 'Қорытындыға арналған сөйлем құрылымы беріледі.'
      }
    ],
    differentiation: 'Қолдауды қажет ететін оқушыға тірек ұғымдар, талдау кестесі және сөйлем бастамалары беріледі; дайын оқушы деректердің сенімділігін салыстырып бағалайды.',
    safety: 'Сыныптағы қауіпсіздік және цифрлық деректермен жауапты жұмыс істеу талаптары сақталады.'
  };
}

function curriculumPlan(body, reference) {
  const geometry = body.subject === 'Геометрия';
  const objective = body.objective || reference?.objectives || '';
  return {
    lessonObjectives: [`${body.topic} тақырыбында берілген оқу мақсатына сәйкес математикалық әрекетті орындау`, 'Шешу жолын математикалық тілде түсіндіріп, нәтижесін тексеру'],
    assessmentCriteria: ['оқу мақсатына сәйкес есептеу, түрлендіру, модельдеу немесе дәлелдеу әрекетін орындайды', 'шешу қадамдарын негіздеп, нәтижесінің дұрыстығын тексереді'],
    stages: [
      {
        name: 'Сабақтың басы', minutes: 8, method: 'Алдыңғы білімді өзектендіру', workForm: 'Бүкіл сыныппен жұмыс',
        teacherActions: [`${body.topic} тақырыбына қажетті алдыңғы білімді анықтайтын қысқа сұрақ немесе есеп ұсынады.`, `Оқу мақсатын өзгеріссіз таныстырады: ${objective}`],
        learnerActions: ['Алдыңғы білімге сүйеніп қысқа жауап береді.', 'Оқу мақсаты бойынша күтілетін математикалық әрекетті анықтайды.'],
        descriptors: [{ text: 'тақырыпқа қажетті ұғымды немесе қасиетті дұрыс атайды', points: 1 }],
        feedback: 'Жауаптың дәлдігіне қарай нақтылаушы сұрақ және қысқа түзету беріледі.', resources: ['Тақта', 'Тірек сұрақ'], support: 'Негізгі ұғымдар мен белгілеулер ұсынылады.'
      },
      {
        name: 'Сабақтың ортасы', minutes: 30, method: geometry ? 'Сызба–дәлел–қорытынды' : 'Үлгі–алгоритм–қолдану', workForm: 'Жеке және жұптық жұмыс',
        teacherActions: [geometry ? 'Тақырыпқа сай сызбаны немесе модельді талдатып, қасиетті қолдану жолын көрсетеді.' : 'Тақырыпқа сай бір үлгінің негізгі қадамдарын түсіндіріп, алгоритмді оқушымен бірге тұжырымдайды.', 'Оқу мақсатына тікелей сәйкес жеке тапсырма береді, кейін жұпта шешу тәсілдерін салыстыруды ұйымдастырады.', 'Қате қадамды анықтауға және нәтижені басқа тәсілмен тексеруге жетелейтін сұрақтар қояды.'],
        learnerActions: [geometry ? 'Сызбадағы берілгендер мен ізделінді шаманы белгілеп, қасиетті қолданады.' : 'Алгоритмді қолданып, есептеу немесе алгебралық түрлендіру орындайды.', 'Шешу қадамдарын жазады және жұбымен салыстырады.', 'Қатесін түзетіп, нәтижесін кері амалмен, орнына қоюмен немесе басқа тәсілмен тексереді.'],
        descriptors: [{ text: 'есептің берілгендері мен қажетті математикалық әрекетті анықтайды', points: 1 }, { text: 'тиісті қасиет, формула немесе алгоритмді дұрыс қолданады', points: 1 }, { text: 'шешу қадамдарын математикалық тілде негіздейді', points: 1 }, { text: 'нәтижесін тексеріп, қорытынды жасайды', points: 1 }],
        feedback: 'Дескриптор бойынша нақты қадамға берілген кері байланыстан кейін оқушы шешімін түзетеді.', resources: geometry ? ['Оқулық', 'Сызба немесе модель', 'Тапсырма парағы'] : ['Оқулық', 'Тапсырма парағы', 'Тақта'], support: 'Қажет оқушыға формула, сызба немесе алгоритмнің бастапқы қадамы беріледі; дайын оқушыға басқа тәсілмен шешу ұсынылады.'
      },
      {
        name: 'Сабақтың соңы', minutes: 7, method: 'Шешімді түсіндір және тексер', workForm: 'Жеке жұмыс',
        teacherActions: ['Оқу мақсатына сәйкес қысқа қорытынды тапсырма ұсынады.', 'Оқушының дәлелі мен тексеру тәсіліне сүйеніп келесі оқу қадамын белгілейді.'],
        learnerActions: ['Қорытынды тапсырманы орындайды.', 'Қолданған тәсілін және нәтижені қалай тексергенін қысқаша түсіндіреді.'],
        descriptors: [{ text: 'оқу мақсатына сәйкес қорытынды тапсырманы орындайды', points: 1 }, { text: 'шешу тәсілі мен тексеру нәтижесін түсіндіреді', points: 1 }],
        feedback: 'Нақты дәлелге сүйенген қорытынды кері байланыс беріледі.', resources: ['Қорытынды тапсырма'], support: 'Сөйлем бастамасы немесе тексеру қадамы ұсынылады.'
      }
    ],
    differentiation: 'Қолдауды қажет ететін оқушыға формула, сызба және кезеңдік нұсқаулық беріледі; жоғары дайындықтағы оқушы шешудің екінші тәсілін ұсынып, тиімділігін негіздейді.',
    safety: 'Сыныптағы және цифрлық құралдармен жұмыс істеу қауіпсіздігі сақталады.'
  };
}

function referenceContext(reference) {
  if (!reference) return 'Сәйкес мұғалімдік үлгі табылмады.';
  const stages = reference.stages.map(stage => ({
    stage: stage.stage, minutes: stage.minutes, teacher: stage.teacher,
    learner: stage.learner, assessment: stage.assessment, resources: stage.resources
  }));
  return JSON.stringify({
    sourceStatus: reference.source?.status === 'teacher-provided-ktz' ? 'Мұғалім берген КТЖ дерегі; оқу мақсаты мен тақырып көзі' : 'Мұғалім берген әдістемелік ҚМЖ үлгісі; нормативтік дерек емес',
    section: reference.section, topic: reference.topic, objectives: reference.objectives,
    lessonObjectives: reference.lesson_objectives, values: reference.values,
    stages, methodologicalGuidance: reference.methodological_guidance || [], track: reference.track || '', knownIssues: reference.quality_flags
  }, null, 2).slice(0, 24000);
}

function demoPlan(body) {
  const pe = body.subject === 'Дене шынықтыру';
  return {
    lessonObjectives: [`Берілген оқу мақсатына сәйкес ${body.topic} тақырыбын меңгеру`, 'Алған білімін немесе дағдысын тәжірибелік тапсырмада қолдану'],
    assessmentCriteria: ['оқу мақсатына сәйкес негізгі әрекетті орындайды', 'нәтижесін түсіндіріп, өзін-өзі бағалайды'],
    stages: [
      {
        name: 'Сабақтың басы', minutes: 8, method: pe ? 'Қауіпсіздік шеңбері' : 'Ой қозғау', workForm: 'Бүкіл сыныппен жұмыс',
        teacherActions: pe ? ['Сәлемдеседі, қатысушыларды тексереді.', 'Қауіпсіздік ережесін және сабақ мақсатын түсіндіреді.', 'Дайындық жаттығуын ұйымдастырады.'] : ['Сәлемдеседі және сабақ мақсатын таныстырады.', 'Алдыңғы білімді анықтайтын нақты сұрақтар қояды.'],
        learnerActions: pe ? ['Қауіпсіздік ережесін қайталайды.', 'Дайындық жаттығуларын дұрыс орындайды.'] : ['Оқу мақсатымен танысады.', 'Сұрақтарға жауап беріп, алдыңғы білімін еске түсіреді.'],
        descriptors: [{ text: pe ? 'қауіпсіздік талабын атайды' : 'алдыңғы білім бойынша нақты жауап береді', points: 1 }], feedback: 'Нақтылаушы ауызша кері байланыс', resources: pe ? ['Ысқырық', 'Белгі конустары'] : ['Тақырыптық слайд', 'Тірек сөздер'], support: 'Қысқа нұсқаулық және әрекет үлгісі'
      },
      {
        name: 'Сабақтың ортасы', minutes: 30, method: pe ? 'Көрсет және орында' : 'Қатені тап және түсіндір', workForm: pe ? 'Топтық жұмыс' : 'Жеке және жұптық жұмыс',
        teacherActions: pe ? ['Қозғалыс техникасын кезеңмен көрсетеді.', 'Жаттығуды топтарда орындатады және қауіпсіздікті бақылайды.', 'Әрекетке қарай түзетуші кері байланыс береді.'] : ['Жаңа мазмұнды мысал арқылы түсіндіреді.', 'Жеке тапсырма береді және жұпта салыстыруды ұйымдастырады.', 'Қате болған жағдайда жетелеуші сұрақ қояды.'],
        learnerActions: pe ? ['Қимылды үлгі бойынша орындайды.', 'Топта кезек пен арақашықтықты сақтайды.', 'Техникасын кері байланыс бойынша түзетеді.'] : ['Мысалды талдап, тапсырманы жеке орындайды.', 'Жауабын жұбымен салыстырады.', 'Қатесін түзетіп, шешімін дәлелдейді.'],
        descriptors: [{ text: pe ? 'қозғалыс техникасын ретімен орындайды' : 'негізгі ұғымды дұрыс қолданады', points: 1 }, { text: pe ? 'қауіпсіз арақашықтықты сақтайды' : 'тапсырманы берілген шартқа сай орындайды', points: 1 }, { text: 'нәтижесін дәлелмен түсіндіреді', points: 1 }], feedback: 'Дескрипторға сүйенген кері байланыс және қайта орындау', resources: pe ? ['Доптар немесе пәнге сай құрал', 'Белгі конустары', 'Алғашқы көмек қобдишасы'] : ['Оқулық', 'Тапсырма парағы'], support: 'Тірек алгоритм, үлгі жауап немесе жеңілдетілген бастапқы қадам'
      },
      {
        name: 'Сабақтың соңы', minutes: 7, method: '3–2–1 рефлексиясы', workForm: 'Жеке жұмыс',
        teacherActions: ['Оқу мақсатына қайта оралып, нәтижені қорытындылайды.', 'Рефлексия ұйымдастырып, келесі оқу қадамын белгілейді.'],
        learnerActions: ['Өз нәтижесін бағалайды.', '3 жаңа ақпарат, 2 маңызды ой және 1 сұрақ жазады немесе айтады.'],
        descriptors: [{ text: 'оқу нәтижесін нақты тұжырымдайды', points: 1 }, { text: 'келесі оқу қадамын атайды', points: 1 }], feedback: 'Қысқа қорытынды кері байланыс', resources: ['Рефлексия парағы'], support: 'Сөйлем бастамалары'
      }
    ],
    differentiation: 'Қолдауды қажет ететін оқушыға тірек алгоритм мен үлгі беріледі; жоғары дайындықтағы оқушыға дәлелдеуді немесе күрделендірілген қолдануды қажет ететін тапсырма ұсынылады.',
    safety: pe ? 'Жаттығу орны, құралдардың жарамдылығы, арақашықтық және жүктеме деңгейі сабаққа дейін тексеріледі.' : 'Сыныптағы және цифрлық құрылғылармен жұмыс істеу қауіпсіздігі сақталады.'
  };
}

function normalizePlan(raw, body, reference = null) {
  const fallback = planFromReference(reference, body);
  const rawStages = Array.isArray(raw?.stages) && raw.stages.length ? raw.stages.slice(0, 6) : fallback.stages;
  const stages = rawStages.map((stage, index) => ({
    name: String(stage?.name || fallback.stages[index]?.name || `Сабақ кезеңі ${index + 1}`).trim(),
    minutes: Math.max(1, Math.round(Number(stage?.minutes) || 1)),
    method: String(stage?.method || fallback.stages[index]?.method || 'Нақты тапсырма').trim(),
    workForm: String(stage?.workForm || fallback.stages[index]?.workForm || 'Жеке жұмыс').trim(),
    teacherActions: asList(stage?.teacherActions, fallback.stages[index]?.teacherActions || ['Тапсырманы ұйымдастырады.']),
    learnerActions: asList(stage?.learnerActions, fallback.stages[index]?.learnerActions || ['Тапсырманы орындайды.']),
    descriptors: (Array.isArray(stage?.descriptors) ? stage.descriptors : []).map(item => ({ text: String(item?.text || '').trim(), points: Math.max(1, Math.round(Number(item?.points) || 1)) })).filter(item => item.text),
    tasks: (Array.isArray(stage?.tasks) ? stage.tasks : []).map((item, taskIndex) => ({
      number: Math.max(1, Math.round(Number(item?.number) || taskIndex + 1)),
      exerciseNumber: String(item?.exerciseNumber || '').trim(),
      displayMode: item?.displayMode === 'image' ? 'image' : 'text',
      instruction: String(item?.instruction || '').trim(),
      descriptor: String(item?.descriptor || '').trim(),
      points: Math.max(1, Math.round(Number(item?.points) || 1)),
      visual: item?.visual && /^(?:\/visuals\/[a-z0-9-]+\.svg|\/(?:textbook|history)-excerpts\/task-[a-f0-9]{20}\.jpg)$/i.test(String(item.visual.src || '')) ? {
        src: String(item.visual.src),
        alt: String(item.visual.alt || 'Оқулықтағы есеп').trim(),
        caption: String(item.visual.caption || '').trim()
      } : null
    })).filter(item => item.instruction && item.descriptor),
    visuals: (Array.isArray(stage?.visuals) ? stage.visuals : []).map(item => ({
      src: /^(?:\/visuals\/[a-z0-9-]+\.svg|\/(?:textbook|history)-excerpts\/task-[a-f0-9]{20}\.jpg)$/i.test(String(item?.src || '')) ? String(item.src) : '',
      alt: String(item?.alt || 'Математикалық сызба').trim(),
      caption: String(item?.caption || '').trim()
    })).filter(item => item.src).slice(0, 2),
    feedback: String(stage?.feedback || 'Дескрипторға сай кері байланыс').trim(),
    resources: asList(stage?.resources, ['Оқулық']),
    support: String(stage?.support || '').trim()
  }));
  const total = stages.reduce((sum, stage) => sum + stage.minutes, 0);
  stages[stages.length - 1].minutes = Math.max(1, stages[stages.length - 1].minutes + (45 - total));
  if (stages.reduce((sum, stage) => sum + stage.minutes, 0) !== 45) return fallback;
  return {
    lessonObjectives: asList(raw?.lessonObjectives, fallback.lessonObjectives),
    stages,
    differentiation: String(raw?.differentiation || fallback.differentiation).trim(),
    safety: String(raw?.safety || fallback.safety).trim(),
    visuals: (Array.isArray(raw?.visuals) ? raw.visuals : []).map(item => ({
      src: /^(?:\/visuals\/[a-z0-9-]+\.svg|\/(?:textbook|history)-excerpts\/task-[a-f0-9]{20}\.jpg)$/i.test(String(item?.src || '')) ? String(item.src) : '',
      alt: String(item?.alt || 'Математикалық сызба').trim(),
      caption: String(item?.caption || '').trim()
    })).filter(item => item.src).slice(0, 2),
    answerKey: asList(raw?.answerKey, []),
    textbookSources: asList(raw?.textbookSources, []),
    sourceNote: String(raw?.sourceNote || '').trim()
  };
}

function renderPlan(body, plan, model, reference = null) {
  const list = items => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const valueName = String(reference?.values || 'Еңбекқорлық және кәсіби біліктілік').trim();
  const socialSubject = SOCIAL_SUBJECTS.has(body.subject);
  const valueExplanation = socialSubject
    ? `${valueName}. Дерек пен пікірді ажыратып, тапсырманы жауапкершілікпен орындайды; қорытындысын нақты дәлелмен негіздейді.`
    : `${valueName}. Тапсырмаларды мұқият орындап, шешу ретін сақтайды; дәл есептеп, жауабын математикалық тілде негіздейді.`;
  const taskValue = socialSubject
    ? `${valueName} — деректі жауапкершілікпен талдап, өз тұжырымын нақты дәлелмен негіздейді.`
    : `${valueName} — есепті жауапкершілікпен орындап, шешу қадамдарын ретімен жазады және нәтижесін тексереді.`;
  const organizationStage = {
    name: 'Ұйымдастыру кезеңі', minutes: 5, teacherActions: ['Сәлемдесу.', 'Сыныптағы оқушылардың көңіл күйлерін сұрап, жағымды ахуал туындату.', 'Оқушыларды түгелдеу.', 'Сабақтың мақсатымен таныстыру.'],
    learnerActions: ['Сабаққа дайындалады және оқу құралдарын реттейді.'], tasks: [], descriptors: [],
    feedback: 'Ауызша бағалау: «Өте жақсы», «Жарайсың».', resources: ['Оқу құралдары'], support: '', visuals: []
  };
  const sourceStages = plan.stages.length === 3 ? [organizationStage, ...plan.stages] : plan.stages;
  const stageContract = [
    ['Ұйымдастыру кезеңі', 5], ['Сабақтың басы', 10], ['Сабақтың ортасы', 25], ['Сабақтың соңы', 5]
  ];
  const displayStages = sourceStages.slice(0, 4).map((stage, index) => ({ ...stage, name: stageContract[index][0], minutes: stageContract[index][1] }));
  const rows = displayStages.map(stage => {
    const tasks = (stage.tasks || []).map(task => {
      const taskVisual = task.displayMode === 'image' && task.visual ? `<figure class="math-visual"><img src="${escapeHtml(task.visual.src)}" alt="${escapeHtml(task.visual.alt)}"><figcaption>${escapeHtml(task.visual.caption || `№${task.exerciseNumber} есеп`)}</figcaption></figure>` : '';
      const heading = task.exerciseNumber ? `№${escapeHtml(task.exerciseNumber)} есеп.` : `${task.number}-тапсырма.`;
      const instruction = task.displayMode === 'image' ? '' : ` ${escapeHtml(task.instruction)}`;
      return `<div class="lesson-task">${taskVisual}<p><strong>${heading}</strong>${instruction}</p><p class="task-descriptor"><strong>Дескриптор — ${task.points} балл:</strong><br>• ${escapeHtml(task.descriptor)} — ${task.points}</p><p class="task-values"><strong>Құндылықтар:</strong> ${escapeHtml(taskValue)}</p></div>`;
    }).join('');
    const visuals = (stage.visuals || []).map(item => `<figure class="math-visual"><img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt)}"><figcaption>${escapeHtml(item.caption)}</figcaption></figure>`).join('');
    const teacher = `${list(stage.teacherActions)}${visuals}${tasks}`;
    const bbuTable = stage.name === 'Сабақтың соңы' ? '<table class="bbu-table"><thead><tr><th>Білемін</th><th>Білгім келеді</th><th>Үйрендім</th></tr></thead><tbody><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table>' : '';
    const learner = `${list(stage.learnerActions)}${bbuTable}`;
    const stageDescriptors = (stage.descriptors || []).length ? `<p><strong>Дескриптор:</strong></p>${list(stage.descriptors.map(item => `${item.text} — ${item.points} балл`))}` : '';
    const assessment = `${stageDescriptors}<p><strong>Кері байланыс:</strong> ${escapeHtml(stage.feedback)}</p>${stage.support ? `<p><strong>Қолдау:</strong> ${escapeHtml(stage.support)}</p>` : ''}`;
    return `<tr><td><strong>${escapeHtml(stage.name)}</strong><br>${stage.minutes} минут</td><td>${teacher}</td><td>${learner}</td><td>${assessment}</td><td>${list(stage.resources)}</td></tr>`;
  }).join('');
  const valuesRow = `<tr><th>Құндылықтар</th><td>${escapeHtml(valueExplanation)}</td></tr>`;
  const html = `<article class="qmj-document"><h2>Қысқа мерзімді (сабақ) жоспары</h2><p class="legal-note">№130 бұйрық нысанының міндетті тармақтарына негізделген</p><table class="meta-table"><colgroup><col style="width:28.4%"><col style="width:71.6%"></colgroup><tr><th>Білім беру ұйымының атауы</th><td>${escapeHtml(body.organization || '____________________________')}</td></tr><tr><th>Бөлім</th><td>${escapeHtml(body.section)}</td></tr><tr><th>Педагогтің тегі, аты, әкесінің аты</th><td>${escapeHtml(body.teacher || '____________________________')}</td></tr><tr><th>Күні</th><td>${escapeHtml(body.date || '________________')}</td></tr><tr><th>Сынып</th><td>${escapeHtml(body.grade)} &nbsp; Қатысқандар саны: ${escapeHtml(body.present || '____')} &nbsp; Қатыспағандар саны: ${escapeHtml(body.absent || '____')}</td></tr><tr><th>Сабақтың тақырыбы</th><td>${escapeHtml(body.topic)}</td></tr><tr><th>Оқу бағдарламасына сәйкес оқыту мақсаттары</th><td>${escapeHtml(body.objective)}</td></tr><tr><th>Сабақтың мақсаты</th><td>${list(plan.lessonObjectives)}</td></tr>${valuesRow}</table><p class="flow-heading"><strong>Сабақ барысы: 45 минут</strong></p><table class="flow-table"><colgroup><col style="width:8.8%"><col style="width:32.7%"><col style="width:35.3%"><col style="width:11.8%"><col style="width:11.4%"></colgroup><thead><tr><th>Уақыты/кезеңдері</th><th>Педагогтің әрекеті</th><th>Оқушының әрекеті</th><th>Бағалау</th><th>Ресурстар</th></tr></thead><tbody>${rows}</tbody></table></article>`;
  const text = `Қысқа мерзімді (сабақ) жоспары\nПән: ${body.subject}\nСынып: ${body.grade}\nБөлім: ${body.section}\nТақырып: ${body.topic}\nОқу мақсаты: ${body.objective}`;
  const referenceDocx = reference?.term === 1 && fs.existsSync(path.join(REFERENCE_DOCX_DIR, `${reference.id}.docx`)) ? `/api/reference-docx/${reference.id}` : null;
  return { html, text, model, format: 'qmj-130', referenceDocx, reference: reference ? { id: reference.id, topic: reference.topic, term: reference.term, track: reference.track || '', source: reference.source.collection } : null };
}

function apiConfig() {
  if (AI_PROVIDER === 'openai') return { key: OPENAI_API_KEY, url: 'https://api.openai.com/v1/chat/completions' };
  return { key: OPENROUTER_API_KEY, url: 'https://openrouter.ai/api/v1/chat/completions' };
}

async function generatePlan(body) {
  const reference = selectReference(body);
  if (AI_FREE_SUBJECTS.has(body.subject)) {
    const model = SOCIAL_SUBJECTS.has(body.subject)
      ? 'КТЖ тарих/құқық базасы · ЖИ қолданылмады'
      : 'Атамұра ҚМЖ базасы · ЖИ қолданылмады';
    return renderPlan(body, planFromReference(reference, body), model, reference);
  }
  if (reference?.prepared_plan) return renderPlan(body, planFromReference(reference, body), 'Дайын ҚМЖ базасы · ЖИ қолданылмады', reference);
  if (reference?.stages?.length) return renderPlan(body, planFromReference(reference, body), 'Дайын ҚМЖ', reference);
  const config = apiConfig();
  if (!config.key) return renderPlan(body, planFromReference(reference, body), reference ? 'ҚМЖ базасы' : 'demo-template', reference);
  const system = `Сен Қазақстан мектебінің тәжірибелі әдіскерісің. Бір сабаққа арналған, мазмұны өзара үйлесімді 45 минуттық ҚМЖ құрастыр. Пайдаланушы берген оқу мақсатының коды мен тұжырымын ешқашан өзгертпе және ойдан жаңа оқу мақсатын қоспа. Тапсырмалар пәнге, сынып жасына, тақырыпқа және оқу мақсатына нақты сәйкес болсын; жалпылама немесе мағынасыз мәтін жазба. Әр тапсырма үшін өлшенетін дескриптор және кемінде 1 оң бүтін балл көрсет. Педагог әрекетінде нақты әдіс пен жұмыс формасын жаз. Кезең минуттарының қосындысы дәл 45 болсын. Қосылған мұғалімдік ҚМЖ үлгісін құрылым мен идея көзі ретінде пайдалан, бірақ ол нормативтік құжат емес: ішіндегі қате, 40 минуттық бөлу немесе тақырыпқа сәйкес емес тапсырманы қайталама. Дене шынықтыруда жүктеме, арақашықтық, құрал және қауіпсіздікті нақтыла. Тек JSON қайтар: {"lessonObjectives":["..."],"assessmentCriteria":["..."],"stages":[{"name":"...","minutes":8,"method":"...","workForm":"...","teacherActions":["..."],"learnerActions":["..."],"descriptors":[{"text":"...","points":1}],"feedback":"...","resources":["..."],"support":"..."}],"differentiation":"...","safety":"..."}.`;
  const user = `Оқыту тілі: ${body.language}\nПән: ${body.subject}\nСынып: ${body.grade}\nТоқсан: ${body.term}\nБөлім: ${body.section}\nТақырып: ${body.topic}\nӨЗГЕРТІЛМЕЙТІН оқу мақсаты: ${body.objective}\nСынып ерекшелігі: ${body.classProfile || 'көрсетілмеген'}\nҚолжетімді ресурстар: ${body.availableResources || 'көрсетілмеген'}\nҚосымша талап: ${body.extra || 'жоқ'}\n\nМҰҒАЛІМ БЕРГЕН АНЫҚТАМАЛЫҚ ДЕРЕК:\n${referenceContext(reference)}`;
  const headers = { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' };
  if (AI_PROVIDER !== 'openai') Object.assign(headers, { 'HTTP-Referer': process.env.PUBLIC_URL || `http://localhost:${PORT}`, 'X-Title': 'ernur-qmj' });
  try {
    const response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.25, max_tokens: 4500 }) });
    const result = await response.json();
    if (!response.ok) return renderPlan(body, planFromReference(reference, body), 'ЖИ қолжетімсіз · ҚМЖ базасы', reference);
    const content = result?.choices?.[0]?.message?.content;
    if (!content) return renderPlan(body, planFromReference(reference, body), 'ЖИ бос жауап берді · ҚМЖ базасы', reference);
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return renderPlan(body, normalizePlan(JSON.parse(cleaned), body, reference), result.model || AI_MODEL, reference);
  } catch (error) {
    console.error('ЖИ резервтік режимге ауысты:', error.message);
    return renderPlan(body, planFromReference(reference, body), 'ҚМЖ базасы · резервтік режим', reference);
  }
}

const TEXT_TOOL_MODES = new Set([
  'assistant', 'essay', 'article', 'report', 'author-program', 'worksheet', 'riddle', 'bjb', 'tjb',
  'ktj', 'presentation', 'quiz', 'game-builder', 'lesson-game', 'visual-aid', 'e-alem',
  'chemistry-lab', 'interactive-ppt', 'e-kids', 'course'
]);

async function generateTextTool(body) {
  const mode = String(body.mode || 'assistant');
  if (!TEXT_TOOL_MODES.has(mode)) throw Object.assign(new Error('Құрал түрі қате'), { status: 400 });
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 3 || prompt.length > 5000) throw Object.assign(new Error('Тапсырманы 3–5000 таңба аралығында жазыңыз'), { status: 400 });
  const config = apiConfig();
  if (!config.key) throw Object.assign(new Error('Е-Көмекші үшін ЖИ кілті серверде орнатылмаған'), { status: 503 });
  const labels = {
    assistant: 'мұғалімнің сұрағына нақты әдістемелік жауап',
    essay: 'құрылымды эссе',
    article: 'тақырыпшалары бар мақала',
    report: 'ресми баяндама',
    'author-program': 'авторлық бағдарламаның мазмұны мен құрылымы',
    worksheet: 'оқушыға арналған жұмыс парағы',
    riddle: 'оқу тақырыбына сай жұмбақтар мен қысқа тапсырмалар',
    bjb: 'бөлім бойынша жиынтық бағалау (БЖБ)',
    tjb: 'тоқсан бойынша жиынтық бағалау (ТЖБ)',
    ktj: 'күнтізбелік-тақырыптық жоспар (КТЖ)',
    presentation: 'сабақ презентациясының слайдтық жоспары мен дайын мәтіні',
    quiz: 'оқушыға арналған викторина, дұрыс жауаптар және бағалау жүйесі',
    'game-builder': 'сәйкестендіру, топтастыру немесе карточкалық оқу ойыны',
    'lesson-game': 'сабақ кезеңіне арналған қысқа оқу ойындары',
    'visual-aid': 'баспаға дайын көрнекілік мазмұны мен карточкалар',
    'e-alem': 'елдер, мемлекеттер, карталар және тарихи оқиғаларға арналған танымдық тапсырмалар',
    'chemistry-lab': 'қауіпсіздік ережелері бар химиялық зертханалық жұмыс',
    'interactive-ppt': 'интерактивті PowerPoint үшін слайд сценарийі, батырмалар және жауаптар',
    'e-kids': 'мектепалды даярлыққа арналған жас ерекшелігіне сай ойындар',
    course: 'мұғалімге арналған оқу курсының бағдарламасы, модульдері және тапсырмалары'
  };
  const assessmentRules = ['bjb', 'tjb'].includes(mode)
    ? ' Берілген оқу мақсаттарын өзгеріссіз сақта. Алдымен бағалау критерийлерін жаз. Әртүрлі деңгейдегі нақты тапсырмалар бер. Әр тапсырманың астына дескриптор мен балл қой. Соңында толық жауап кілтін және жалпы баллды көрсет. Тапсырмалар балдарының қосындысы пайдаланушы көрсеткен жалпы баллға дәл келсін. Ресми оқу мақсатын ойдан шығарма.'
    : '';
  const ktjRules = mode === 'ktj' ? ' Жоспарда бөлім, сабақ нөмірі, тақырып, сағат саны, нақты оқу мақсаты, мерзім және ескертпе болсын. Пайдаланушы берген жалпы сағат санын дәл сақта.' : '';
  const safetyRules = mode === 'chemistry-lab' ? ' Реактивтер, қорғаныс құралдары, қауіпсіздік, қалдықтарды жою және мұғалім бақылауын міндетті түрде көрсет.' : '';
  const system = `Сен Қазақстан мектебінің тәжірибелі әдіскерісің. ${labels[mode]} дайында. Мәтін қазақ тілінде, сауатты, түсінікті және мұғалім бірден қолданатындай болсын. Пайдаланушы бермеген оқу мақсатын немесе ресми деректі ойдан қоспа.${assessmentRules}${ktjRules}${safetyRules} Қажет болса тақырыпшалар мен нөмірленген тізім қолдан. Markdown кестесін қолданба. Тек дайын материалды қайтар.`;
  const user = `Құрал: ${labels[mode]}\nПән: ${String(body.subject || 'көрсетілмеген')}\nСынып: ${String(body.grade || 'көрсетілмеген')}\nТақырып/сұраныс: ${prompt}\nҚосымша талап: ${String(body.requirements || 'жоқ')}`;
  const headers = { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' };
  if (AI_PROVIDER !== 'openai') Object.assign(headers, { 'HTTP-Referer': process.env.PUBLIC_URL || `http://localhost:${PORT}`, 'X-Title': 'e-tarih' });
  const response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: mode === 'assistant' ? 0.25 : 0.55, max_tokens: 3500 }) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result?.error?.message || 'ЖИ қызметі уақытша қолжетімсіз'), { status: 502 });
  const content = String(result?.choices?.[0]?.message?.content || '').replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!content) throw Object.assign(new Error('ЖИ бос жауап берді'), { status: 502 });
  return { content, model: result.model || AI_MODEL, title: String(body.title || prompt).slice(0, 120) };
}

async function generateQuiz(body) {
  const config = apiConfig();
  if (!config.key) throw Object.assign(new Error('Викторина құрастыру үшін ЖИ кілті серверде орнатылмаған'), { status: 503 });
  const count = Math.min(30, Math.max(3, Number(body.questionCount) || 10));
  const system = `Сен Қазақстан мектебінің әдіскерісің. Берілген пән, сынып және тақырып бойынша дәл ${count} тест сұрағын дайында. Әр сұрақта 4 жауап нұсқасы және бір ғана дұрыс жауап болсын. Фактілерді тексер, жас ерекшелігін сақта. Тек JSON қайтар: {"questions":[{"text":"...","choices":["...","...","...","..."],"answer":0,"explanation":"..."}]}. answer — 0 мен 3 арасындағы индекс.`;
  const user = `Пән: ${String(body.subject || '')}\nСынып: ${String(body.grade || '')}\nТақырып: ${String(body.topic || '')}\nҚосымша талап: ${String(body.requirements || 'жоқ')}`;
  const headers = { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' };
  if (AI_PROVIDER !== 'openai') Object.assign(headers, { 'HTTP-Referer': process.env.PUBLIC_URL || `http://localhost:${PORT}`, 'X-Title': 'e-tarih' });
  const response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.35, max_tokens: 5000 }) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result?.error?.message || 'Викторина жасалмады'), { status: 502 });
  const cleaned = String(result?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { throw Object.assign(new Error('ЖИ викторинаны дұрыс форматта қайтармады. Қайта жасап көріңіз'), { status: 502 }); }
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : []).map(item => ({
    text: String(item?.text || '').trim().slice(0, 500),
    choices: (Array.isArray(item?.choices) ? item.choices : []).map(value => String(value || '').trim().slice(0, 240)).slice(0, 4),
    answer: Math.max(0, Math.min(3, Math.round(Number(item?.answer) || 0))),
    explanation: String(item?.explanation || '').trim().slice(0, 500)
  })).filter(item => item.text && item.choices.length === 4).slice(0, count);
  if (questions.length < 3) throw Object.assign(new Error('Жарамды сұрақтар жеткіліксіз. Қайта жасап көріңіз'), { status: 502 });
  return questions;
}

function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/$/, '');
  const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${protocol}://${host}`;
}

function safeFilename(value, fallback = 'e-tarih') {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 80);
}

function presentationSections(content) {
  const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const sections = [];
  let current = { title: 'Негізгі мазмұн', lines: [] };
  for (const line of lines) {
    const heading = line.match(/^(?:#{1,3}\s*|(?:Слайд|SLIDE)\s*\d+[.:\-]?\s*)(.+)$/i);
    if (heading && current.lines.length) {
      sections.push(current);
      current = { title: heading[1].replace(/[*_]/g, '').slice(0, 100), lines: [] };
    } else if (heading) current.title = heading[1].replace(/[*_]/g, '').slice(0, 100);
    else current.lines.push(line.replace(/^[-*•]\s*/, ''));
  }
  if (current.lines.length || current.title) sections.push(current);
  return sections.flatMap(section => {
    const chunks = [];
    for (let i = 0; i < section.lines.length; i += 7) chunks.push({ title: chunks.length ? `${section.title} (жалғасы)` : section.title, lines: section.lines.slice(i, i + 7) });
    return chunks.length ? chunks : [{ title: section.title, lines: [''] }];
  }).slice(0, 30);
}

async function createPresentationBuffer(title, content, subtitle = '') {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Е-Тарих';
  pptx.subject = title;
  pptx.title = title;
  pptx.company = 'Е-Тарих';
  pptx.lang = 'kk-KZ';
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'kk-KZ' };
  let slide = pptx.addSlide();
  slide.background = { color: 'F4F7FC' };
  slide.addText('Е-Тарих', { x: 0.7, y: 0.55, w: 2.2, h: 0.35, fontSize: 15, bold: true, color: '246BFD' });
  slide.addText(title, { x: 0.75, y: 2.15, w: 11.8, h: 1.25, fontSize: 30, bold: true, color: '14213D', align: 'center', breakLine: false, margin: 0.05 });
  if (subtitle) slide.addText(subtitle, { x: 1.25, y: 3.65, w: 10.8, h: 0.8, fontSize: 16, color: '667085', align: 'center', margin: 0.04 });
  slide.addText('Мұғалімге арналған білім беру платформасы', { x: 2.3, y: 6.75, w: 8.7, h: 0.3, fontSize: 11, color: '7B879D', align: 'center' });
  const sections = presentationSections(content);
  sections.forEach((section, index) => {
    slide = pptx.addSlide();
    slide.background = { color: index % 2 ? 'F7F9FD' : 'FFFFFF' };
    slide.addText(section.title || `Слайд ${index + 2}`, { x: 0.65, y: 0.45, w: 12.05, h: 0.65, fontSize: 24, bold: true, color: '14213D', margin: 0.03 });
    const bullets = section.lines.map(text => ({ text, options: { bullet: { indent: 16 }, hanging: 4, breakLine: true } }));
    slide.addText(bullets, { x: 0.85, y: 1.35, w: 11.5, h: 5.35, fontSize: 18, color: '334155', breakLine: true, valign: 'mid', margin: 0.08, paraSpaceAfterPt: 12, fit: 'shrink' });
    slide.addText(`${index + 2}`, { x: 12.1, y: 7.0, w: 0.5, h: 0.2, fontSize: 9, color: '94A3B8', align: 'right' });
  });
  return pptx.write({ outputType: 'nodebuffer' });
}

async function handleApi(req, res, pathname) {
  try {
    const referenceDocxMatch = pathname.match(/^\/api\/reference-docx\/([0-9a-f]{16})$/i);
    if (req.method === 'GET' && referenceDocxMatch) {
      const access = await verifyAccessCode(requestAccessCode(req, {}), false, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      const reference = referenceDatabase.records.find(item => item.id === referenceDocxMatch[1] && item.term === 1);
      if (!reference) return sendJson(res, 404, { error: 'Бастапқы ҚМЖ табылмады' });
      if (!codeAllowsSubject(access.record, reference.subject)) return sendJson(res, 403, { error: 'Бұл пәнге рұқсат жоқ' });
      const file = path.join(REFERENCE_DOCX_DIR, `${reference.id}.docx`);
      try {
        const data = await fs.promises.readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME['.docx'],
          'Content-Length': data.length,
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `attachment; filename="qmj-${reference.id}.docx"`
        });
        return res.end(data);
      } catch {
        return sendJson(res, 404, { error: 'Бастапқы ҚМЖ файлы табылмады' });
      }
    }
    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, provider: AI_PROVIDER, aiReady: Boolean(apiConfig().key), accessReady: Boolean(ADMIN_PASSWORD && ACCESS_CODE_SECRET && databaseReady()), referenceCount: referenceDatabase.records.length });
    if (req.method === 'GET' && pathname === '/api/references') {
      const access = await verifyAccessCode(requestAccessCode(req), false, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const grade = url.searchParams.get('grade') || '';
      const subject = url.searchParams.get('subject') || '';
      const term = Number(url.searchParams.get('term') || 0);
      if (!codeAllowsSubject(access.record, subject)) return sendJson(res, 403, { error: `Бұл код «${subject}» пәніне рұқсат бермейді`, allowedSubjects: normalizeAllowedSubjects(access.record.allowed_subjects) });
      return sendJson(res, 200, { scope: referenceDatabase.source_scope, references: referenceSummaries(grade, subject, term) });
    }
    if (req.method === 'POST' && pathname === '/api/access/verify') {
      const body = await readJson(req);
      const result = await verifyAccessCode(requestAccessCode(req, body), false, requestDeviceId(req));
      if (!result.ok) return sendJson(res, result.status, { error: result.error });
      return sendJson(res, 200, { ok: true, expiresAt: result.record.expires_at, days: result.record.duration_days, allowedSubjects: normalizeAllowedSubjects(result.record.allowed_subjects) });
    }
    if (req.method === 'POST' && pathname === '/api/tools/text') {
      const body = await readJson(req);
      const access = await verifyAccessCode(requestAccessCode(req, body), true, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      if (body.subject && !codeAllowsSubject(access.record, body.subject)) return sendJson(res, 403, { error: `Бұл код «${body.subject}» пәніне рұқсат бермейді`, allowedSubjects: normalizeAllowedSubjects(access.record.allowed_subjects) });
      return sendJson(res, 200, await generateTextTool(body));
    }
    if (req.method === 'POST' && pathname === '/api/tools/pptx') {
      const body = await readJson(req);
      const access = await verifyAccessCode(requestAccessCode(req, body), true, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      const title = String(body.title || 'Е-Тарих презентациясы').trim().slice(0, 140);
      const content = String(body.content || '').trim();
      if (content.length < 10 || content.length > 80000) return sendJson(res, 400, { error: 'Презентация мәтіні бос немесе тым үлкен' });
      const data = await createPresentationBuffer(title, content, String(body.subtitle || '').slice(0, 180));
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      res.writeHead(200, {
        'Content-Type': MIME['.pptx'],
        'Content-Length': buffer.length,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeFilename(title))}.pptx"`
      });
      return res.end(buffer);
    }
    if (req.method === 'POST' && pathname === '/api/quiz/create') {
      const body = await readJson(req);
      const access = await verifyAccessCode(requestAccessCode(req, body), true, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      if (body.subject && !codeAllowsSubject(access.record, body.subject)) return sendJson(res, 403, { error: `Бұл код «${body.subject}» пәніне рұқсат бермейді` });
      const questions = await generateQuiz(body);
      const teacher = await authenticatedTeacher(req);
      const rows = await dbRequest('quizzes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        access_code_id: access.record.id,
        teacher_id: teacher?.id || null,
        title: String(body.title || body.topic || 'Е-Тапқыр викторинасы').trim().slice(0, 180),
        subject: String(body.subject || '').slice(0, 100),
        grade: String(body.grade || '').slice(0, 30),
        questions
      }) });
      const quiz = rows?.[0];
      const url = `${publicOrigin(req)}/quiz.html?id=${encodeURIComponent(quiz.id)}`;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 420, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#14213D', light: '#FFFFFF' } });
      return sendJson(res, 201, { quiz: { id: quiz.id, title: quiz.title, questionCount: questions.length }, url, qrDataUrl });
    }
    const quizMatch = pathname.match(/^\/api\/quiz\/([0-9a-f-]+)$/i);
    if (quizMatch && req.method === 'GET') {
      const id = encodeURIComponent(quizMatch[1]);
      const rows = await dbRequest(`quizzes?id=eq.${id}&is_active=eq.true&select=id,title,subject,grade,questions&limit=1`);
      const quiz = rows?.[0];
      if (!quiz) return sendJson(res, 404, { error: 'Викторина табылмады немесе жабылған' });
      const questions = (quiz.questions || []).map((item, index) => ({ index, text: item.text, choices: item.choices }));
      return sendJson(res, 200, { quiz: { id: quiz.id, title: quiz.title, subject: quiz.subject, grade: quiz.grade, questions } });
    }
    const quizSubmitMatch = pathname.match(/^\/api\/quiz\/([0-9a-f-]+)\/submit$/i);
    if (quizSubmitMatch && req.method === 'POST') {
      const body = await readJson(req);
      const studentName = String(body.studentName || '').trim().slice(0, 100);
      if (studentName.length < 2) return sendJson(res, 400, { error: 'Оқушының аты-жөнін енгізіңіз' });
      const id = encodeURIComponent(quizSubmitMatch[1]);
      const rows = await dbRequest(`quizzes?id=eq.${id}&is_active=eq.true&select=id,questions&limit=1`);
      const quiz = rows?.[0];
      if (!quiz) return sendJson(res, 404, { error: 'Викторина жабылған' });
      const answers = Array.isArray(body.answers) ? body.answers.map(value => Number(value)) : [];
      const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
      const score = questions.reduce((sum, question, index) => sum + (answers[index] === Number(question.answer) ? 1 : 0), 0);
      await dbRequest('quiz_attempts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ quiz_id: quiz.id, student_name: studentName, answers, score, total: questions.length }) });
      const review = questions.map((question, index) => ({ correct: answers[index] === Number(question.answer), answer: Number(question.answer), explanation: question.explanation || '' }));
      return sendJson(res, 200, { score, total: questions.length, review });
    }
    const quizResultsMatch = pathname.match(/^\/api\/quiz\/([0-9a-f-]+)\/results$/i);
    if (quizResultsMatch && req.method === 'GET') {
      const access = await verifyAccessCode(requestAccessCode(req), false, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error });
      const id = encodeURIComponent(quizResultsMatch[1]);
      const quizzes = await dbRequest(`quizzes?id=eq.${id}&access_code_id=eq.${encodeURIComponent(access.record.id)}&select=id,title&limit=1`);
      if (!quizzes?.[0]) return sendJson(res, 403, { error: 'Бұл викторинаның нәтижелерін көруге рұқсат жоқ' });
      const attempts = await dbRequest(`quiz_attempts?quiz_id=eq.${id}&select=id,student_name,score,total,created_at&order=score.desc,created_at.asc&limit=500`);
      return sendJson(res, 200, { quiz: quizzes[0], attempts: attempts || [] });
    }
    if (req.method === 'POST' && pathname === '/api/account/register') {
      const body = await readJson(req);
      const fullName = String(body.fullName || '').trim().slice(0, 120);
      const email = validEmail(body.email);
      const password = String(body.password || '');
      if (fullName.length < 3 || !email || password.length < 8) return sendJson(res, 400, { error: 'Аты-жөніңізді, дұрыс e-mail және кемінде 8 таңбалы құпиясөз енгізіңіз' });
      const access = await verifyAccessCode(String(body.accessCode || ''), false, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error });
      const existing = await dbRequest(`teacher_accounts?or=(email.eq.${encodeURIComponent(email)},access_code_id.eq.${encodeURIComponent(access.record.id)})&select=id,email&limit=1`);
      if (existing?.length) return sendJson(res, 409, { error: 'Бұл e-mail немесе кіру коды бұрын тіркелген. «Кіру» бөлімін пайдаланыңыз' });
      const salt = crypto.randomBytes(16).toString('hex');
      const rows = await dbRequest('teacher_accounts', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          access_code_id: access.record.id,
          full_name: fullName,
          email,
          phone: String(body.phone || '').trim().slice(0, 30),
          school: String(body.school || '').trim().slice(0, 180),
          subject: String(body.subject || '').trim().slice(0, 100),
          password_salt: salt,
          password_hash: passwordDigest(password, salt)
        })
      });
      const account = rows?.[0];
      return sendJson(res, 201, { token: createTeacherSession(account), profile: teacherProfile(account), accessCode: access.record.code, expiresAt: access.record.expires_at, allowedSubjects: normalizeAllowedSubjects(access.record.allowed_subjects) });
    }
    if (req.method === 'POST' && pathname === '/api/account/login') {
      if (loginBlocked(req)) return sendJson(res, 429, { error: 'Кіру әрекеті тым көп. 15 минуттан кейін қайталаңыз' });
      const body = await readJson(req);
      const email = validEmail(body.email);
      const rows = email ? await dbRequest(`teacher_accounts?email=eq.${encodeURIComponent(email)}&select=id,access_code_id,full_name,email,phone,school,subject,password_salt,password_hash,created_at&limit=1`) : [];
      const account = rows?.[0];
      if (!account || !safeEqual(passwordDigest(String(body.password || ''), account.password_salt || ''), account.password_hash || '')) {
        recordLoginFailure(req);
        return sendJson(res, 401, { error: 'E-mail немесе құпиясөз қате' });
      }
      const codes = await dbRequest(`access_codes?id=eq.${encodeURIComponent(account.access_code_id)}&select=code&limit=1`);
      const access = await verifyAccessCode(codes?.[0]?.code || '', false, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error });
      loginAttempts.delete(loginAttemptKey(req));
      return sendJson(res, 200, { token: createTeacherSession(account), profile: teacherProfile(account), accessCode: access.record.code, expiresAt: access.record.expires_at, allowedSubjects: normalizeAllowedSubjects(access.record.allowed_subjects) });
    }
    if (pathname === '/api/account/me') {
      const account = await authenticatedTeacher(req);
      if (!account) return sendJson(res, 401, { error: 'Жеке кабинет сессиясы аяқталған' });
      if (req.method === 'GET') return sendJson(res, 200, { profile: teacherProfile(account) });
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const updates = {
          full_name: String(body.fullName || account.full_name).trim().slice(0, 120),
          phone: String(body.phone ?? account.phone ?? '').trim().slice(0, 30),
          school: String(body.school ?? account.school ?? '').trim().slice(0, 180),
          subject: String(body.subject ?? account.subject ?? '').trim().slice(0, 100),
          updated_at: new Date().toISOString()
        };
        if (updates.full_name.length < 3) return sendJson(res, 400, { error: 'Аты-жөніңізді толық енгізіңіз' });
        const rows = await dbRequest(`teacher_accounts?id=eq.${encodeURIComponent(account.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(updates) });
        return sendJson(res, 200, { profile: teacherProfile(rows?.[0]) });
      }
      return sendJson(res, 405, { error: 'Әдіске рұқсат жоқ' });
    }
    if (pathname === '/api/account/documents') {
      const account = await authenticatedTeacher(req);
      if (!account) return sendJson(res, 401, { error: 'Құжаттарды көру үшін жеке кабинетке кіріңіз' });
      if (req.method === 'GET') {
        const rows = await dbRequest(`teacher_documents?teacher_id=eq.${encodeURIComponent(account.id)}&select=id,title,subject,grade,term,topic,created_at,updated_at&order=created_at.desc&limit=100`);
        return sendJson(res, 200, { documents: rows || [] });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const html = String(body.html || '');
        if (!html || html.length > 220000) return sendJson(res, 400, { error: 'Құжат бос немесе көлемі тым үлкен' });
        const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
        const rows = await dbRequest('teacher_documents', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            teacher_id: account.id,
            title: String(body.title || fields.topic || 'ҚМЖ').trim().slice(0, 180),
            subject: String(fields.subject || '').slice(0, 100),
            grade: String(fields.grade || '').slice(0, 30),
            term: String(fields.term || '').slice(0, 10),
            topic: String(fields.topic || '').slice(0, 180),
            form_data: fields,
            generated_html: html,
            generated_text: String(body.text || '').slice(0, 20000)
          })
        });
        return sendJson(res, 201, { document: rows?.[0] });
      }
      return sendJson(res, 405, { error: 'Әдіске рұқсат жоқ' });
    }
    const teacherDocumentMatch = pathname.match(/^\/api\/account\/documents\/([0-9a-f-]+)$/i);
    if (teacherDocumentMatch) {
      const account = await authenticatedTeacher(req);
      if (!account) return sendJson(res, 401, { error: 'Жеке кабинетке кіріңіз' });
      const id = encodeURIComponent(teacherDocumentMatch[1]);
      if (req.method === 'GET') {
        const rows = await dbRequest(`teacher_documents?id=eq.${id}&teacher_id=eq.${encodeURIComponent(account.id)}&select=*&limit=1`);
        if (!rows?.[0]) return sendJson(res, 404, { error: 'Құжат табылмады' });
        return sendJson(res, 200, { document: rows[0] });
      }
      if (req.method === 'DELETE') {
        await dbRequest(`teacher_documents?id=eq.${id}&teacher_id=eq.${encodeURIComponent(account.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'Әдіске рұқсат жоқ' });
    }
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      if (!ADMIN_PASSWORD || !ACCESS_CODE_SECRET || !databaseReady()) return sendJson(res, 503, { error: 'Әкімші жүйесінің Environment айнымалылары толық орнатылмаған' });
      if (loginBlocked(req)) return sendJson(res, 429, { error: 'Кіру әрекеті тым көп. 15 минуттан кейін қайталаңыз' });
      const body = await readJson(req);
      if (!safeEqual(body.password || '', ADMIN_PASSWORD)) {
        recordLoginFailure(req);
        return sendJson(res, 401, { error: 'Әкімші құпиясөзі қате' });
      }
      loginAttempts.delete(loginAttemptKey(req));
      return sendJson(res, 200, { token: createAdminSession(), expiresIn: 28800 });
    }
    if (pathname.startsWith('/api/admin/codes')) {
      if (!verifyAdminSession(requestBearer(req))) return sendJson(res, 401, { error: 'Әкімші сессиясы аяқталған. Қайта кіріңіз' });
      if (req.method === 'GET' && pathname === '/api/admin/codes') {
        const rows = await dbRequest('access_codes?select=id,code,label,duration_days,created_at,expires_at,is_active,last_used_at,usage_count,allowed_subjects,bound_device_1,bound_device_2,bound_device_1_at,bound_device_2_at,device_reset_count&order=created_at.desc');
        return sendJson(res, 200, { codes: rows || [] });
      }
      if (req.method === 'POST' && pathname === '/api/admin/codes') {
        const body = await readJson(req);
        const days = Number(body.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) return sendJson(res, 400, { error: 'Мерзім 1–365 күн аралығында болуы керек' });
        const allowedSubjects = normalizeAllowedSubjects(body.allowedSubjects);
        if (allowedSubjects.length < 1 || allowedSubjects.length > 3) return sendJson(res, 400, { error: 'Кодқа 1–3 пән таңдаңыз' });
        const code = createAccessCode();
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        const rows = await dbRequest('access_codes', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ code, label: String(body.label || '').trim().slice(0, 100), duration_days: days, expires_at: expiresAt, allowed_subjects: allowedSubjects })
        });
        return sendJson(res, 201, { code: rows[0] });
      }
      const match = pathname.match(/^\/api\/admin\/codes\/([0-9a-f-]+)$/i);
      if (!match) return sendJson(res, 404, { error: 'Код табылмады' });
      const id = encodeURIComponent(match[1]);
      if (req.method === 'DELETE') {
        await dbRequest(`access_codes?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        let updates;
        if (body.action === 'toggle') updates = { is_active: Boolean(body.isActive) };
        else if (body.action === 'subjects') {
          const allowedSubjects = normalizeAllowedSubjects(body.allowedSubjects);
          if (allowedSubjects.length < 1 || allowedSubjects.length > 3) return sendJson(res, 400, { error: 'Кодқа 1–3 пән таңдаңыз' });
          updates = { allowed_subjects: allowedSubjects };
        }
        else if (body.action === 'reset_device') {
          const rows = await dbRequest(`access_codes?id=eq.${id}&select=device_reset_count&limit=1`);
          if (!rows?.[0]) return sendJson(res, 404, { error: 'Код табылмады' });
          updates = { bound_device_1: null, bound_device_2: null, bound_device_1_at: null, bound_device_2_at: null, device_reset_count: Number(rows[0].device_reset_count || 0) + 1 };
        }
        else if (body.action === 'extend') {
          const days = Number(body.days);
          if (!Number.isInteger(days) || days < 1 || days > 365) return sendJson(res, 400, { error: 'Ұзарту мерзімі 1–365 күн болуы керек' });
          const rows = await dbRequest(`access_codes?id=eq.${id}&select=expires_at&limit=1`);
          if (!rows?.[0]) return sendJson(res, 404, { error: 'Код табылмады' });
          updates = { expires_at: new Date(Math.max(Date.now(), new Date(rows[0].expires_at).getTime()) + days * 86400000).toISOString() };
        } else return sendJson(res, 400, { error: 'Әрекет қате' });
        const rows = await dbRequest(`access_codes?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(updates) });
        return sendJson(res, 200, { code: rows?.[0] });
      }
      return sendJson(res, 405, { error: 'Әдіске рұқсат жоқ' });
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      const body = await readJson(req);
      const access = await verifyAccessCode(requestAccessCode(req, body), true, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      const required = ['subject', 'grade', 'language', 'section', 'topic', 'objective'];
      if (required.some(key => !String(body[key] || '').trim())) return sendJson(res, 400, { error: 'Пән, сынып, тіл, бөлім, тақырып және нақты оқу мақсатын толтырыңыз' });
      if (!codeAllowsSubject(access.record, body.subject)) return sendJson(res, 403, { error: `Бұл код «${body.subject}» пәніне рұқсат бермейді`, allowedSubjects: normalizeAllowedSubjects(access.record.allowed_subjects) });
      return sendJson(res, 200, await generatePlan(body));
    }
    return sendJson(res, 404, { error: 'API жолы табылмады' });
  } catch (error) {
    console.error(error);
    return sendJson(res, Number(error.status) || 500, { error: error.message || 'Сервер қатесі' });
  }
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) return sendJson(res, 403, { error: 'Рұқсат жоқ' });
  fs.readFile(target, (error, data) => {
    if (error) return sendJson(res, 404, { error: 'Файл табылмады' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => console.log(`ernur-qmj: http://${HOST}:${PORT}`));

