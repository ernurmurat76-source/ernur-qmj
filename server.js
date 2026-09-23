'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFERENCE_PATH = path.join(__dirname, 'data', 'qmj-reference-index.json');
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'openrouter').toLowerCase();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || (AI_PROVIDER === 'openai' ? 'gpt-4.1-mini' : 'openrouter/free');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ACCESS_CODE_SECRET = process.env.ACCESS_CODE_SECRET || '';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
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
  const select = 'id,code,duration_days,expires_at,is_active,usage_count,bound_device_1,bound_device_2,bound_device_1_at,bound_device_2_at';
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
      if (raw.length > 250000) reject(new Error('Сұраныс көлемі тым үлкен'));
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

function referenceSummaries(grade, subject) {
  const gradeNumber = Number(String(grade || '').match(/\d+/)?.[0]);
  return referenceDatabase.records
    .filter(item => item.grade === gradeNumber && item.subject === subject)
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
  const candidates = referenceDatabase.records.filter(item => item.grade === gradeNumber && item.subject === body.subject);
  if (!candidates.length) return null;
  const exact = candidates.find(item => item.id === body.referenceId);
  if (exact) return exact;
  const topicWords = normalizedWords(body.topic);
  const objectiveCodes = String(body.objective || '').match(/\b\d{1,2}(?:\.\d+){2,}\b/g) || [];
  let best = null;
  let bestScore = 0;
  for (const item of candidates) {
    let score = 0;
    if (objectiveCodes.some(code => item.objective_codes?.includes(code))) score += 12;
    const words = normalizedWords(`${item.topic} ${item.section}`);
    for (const word of topicWords) if (words.has(word)) score += 1;
    if (String(item.section || '').toLocaleLowerCase('kk-KZ') === String(body.section || '').toLocaleLowerCase('kk-KZ')) score += 3;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 3 ? best : null;
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
  let usable = reference.stages.filter(stage => stage.teacher || stage.learner).slice(0, 6);
  if (!usable.length) return demoPlan(body);
  const minutes = distributeMinutes(usable);
  const stages = usable.map((stage, index) => {
    const beginning = /басы|ұйымдастыру|кіріспе/i.test(stage.stage || '');
    const ending = /соңы|қорытынды|рефлек/i.test(stage.stage || '');
    return {
      name: stage.stage?.replace(/\s*\d{1,2}\s*(минут|мин).*$/i, '').trim() || `Сабақ кезеңі ${index + 1}`,
      minutes: minutes[index],
      method: ending ? 'Қысқа рефлексия' : beginning ? 'Ой қозғау' : 'Түсіндір және орында',
      workForm: beginning ? 'Бүкіл сыныппен жұмыс' : ending ? 'Жеке жұмыс' : 'Жеке және жұптық жұмыс',
      teacherActions: splitText(stage.teacher, ['Тапсырманы түсіндіреді және орындалуын бақылайды.']),
      learnerActions: splitText(stage.learner, ['Берілген тапсырманы орындайды және нәтижесін түсіндіреді.']),
      descriptors: [{ text: ending ? 'өз нәтижесіне қысқа қорытынды жасайды' : 'тапсырманы берілген шартқа сай орындайды', points: 1 }],
      feedback: splitText(stage.assessment, ['Дескрипторға сай ауызша кері байланыс']).join(' '),
      resources: splitText(stage.resources, ['Оқулық', 'Тапсырма парағы']).slice(0, 5),
      support: 'Қажет оқушыға үлгі, тірек сөз немесе кезеңдік нұсқаулық беріледі.'
    };
  });
  return {
    lessonObjectives: splitText(reference.lesson_objectives, [`${body.topic} тақырыбы бойынша оқу мақсатына жету`]),
    assessmentCriteria: ['оқу мақсатына сәйкес тапсырманы орындайды', 'шешімін немесе жауабын негіздеп түсіндіреді'],
    stages,
    differentiation: 'Қолдауды қажет ететін оқушыға үлгі мен кезеңдік нұсқаулық беріледі; дайын оқушыға дәлелдеуді қажет ететін күрделендірілген тапсырма ұсынылады.',
    safety: 'Сыныптағы қауіпсіздік және цифрлық құралдарды дұрыс пайдалану талаптары сақталады.'
  };
}

function referenceContext(reference) {
  if (!reference) return 'Сәйкес мұғалімдік үлгі табылмады.';
  const stages = reference.stages.map(stage => ({
    stage: stage.stage, minutes: stage.minutes, teacher: stage.teacher,
    learner: stage.learner, assessment: stage.assessment, resources: stage.resources
  }));
  return JSON.stringify({
    sourceStatus: 'Мұғалім берген әдістемелік үлгі; нормативтік дерек емес',
    section: reference.section, topic: reference.topic, objectives: reference.objectives,
    lessonObjectives: reference.lesson_objectives, values: reference.values,
    stages, knownIssues: reference.quality_flags
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
    feedback: String(stage?.feedback || 'Дескрипторға сай кері байланыс').trim(),
    resources: asList(stage?.resources, ['Оқулық']),
    support: String(stage?.support || '').trim()
  }));
  stages.forEach(stage => { if (!stage.descriptors.length) stage.descriptors = [{ text: 'тапсырманы талапқа сай орындайды', points: 1 }]; });
  const total = stages.reduce((sum, stage) => sum + stage.minutes, 0);
  stages[stages.length - 1].minutes = Math.max(1, stages[stages.length - 1].minutes + (45 - total));
  if (stages.reduce((sum, stage) => sum + stage.minutes, 0) !== 45) return fallback;
  return {
    lessonObjectives: asList(raw?.lessonObjectives, fallback.lessonObjectives),
    assessmentCriteria: asList(raw?.assessmentCriteria, fallback.assessmentCriteria),
    stages,
    differentiation: String(raw?.differentiation || fallback.differentiation).trim(),
    safety: String(raw?.safety || fallback.safety).trim()
  };
}

function renderPlan(body, plan, model, reference = null) {
  const list = items => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const rows = plan.stages.map(stage => {
    const points = stage.descriptors.reduce((sum, item) => sum + item.points, 0);
    const teacher = `<p><strong><em>Тәсіл: ${escapeHtml(stage.method)}</em></strong></p><p><strong>${escapeHtml(stage.workForm)}</strong></p>${list(stage.teacherActions)}`;
    const assessment = `<strong>Дескрипторлар — ${points} балл:</strong>${list(stage.descriptors.map(item => `${item.text} — ${item.points}`))}<p><strong>Кері байланыс:</strong> ${escapeHtml(stage.feedback)}</p>${stage.support ? `<p><strong>Қолдау:</strong> ${escapeHtml(stage.support)}</p>` : ''}`;
    return `<tr><td><strong>${escapeHtml(stage.name)}</strong><br>${stage.minutes} минут</td><td>${teacher}</td><td>${list(stage.learnerActions)}</td><td>${assessment}</td><td>${list(stage.resources)}</td></tr>`;
  }).join('');
  const valuesRow = reference?.values ? `<tr><th>Құндылықтар</th><td>${escapeHtml(reference.values)}</td></tr>` : '';
  const html = `<article class="qmj-document"><h2>Қысқа мерзімді (сабақ) жоспары</h2><p class="legal-note">№130 бұйрық нысанының міндетті тармақтарына негізделген</p><table class="meta-table"><colgroup><col style="width:28.4%"><col style="width:71.6%"></colgroup><tr><th>Білім беру ұйымының атауы</th><td>${escapeHtml(body.organization || '____________________________')}</td></tr><tr><th>Бөлім</th><td>${escapeHtml(body.section)}</td></tr><tr><th>Педагогтің тегі, аты, әкесінің аты</th><td>${escapeHtml(body.teacher || '____________________________')}</td></tr><tr><th>Күні</th><td>${escapeHtml(body.date || '________________')}</td></tr><tr><th>Сынып</th><td>${escapeHtml(body.grade)} &nbsp; Қатысқандар саны: ${escapeHtml(body.present || '____')} &nbsp; Қатыспағандар саны: ${escapeHtml(body.absent || '____')}</td></tr><tr><th>Сабақтың тақырыбы</th><td>${escapeHtml(body.topic)}</td></tr><tr><th>Оқу бағдарламасына сәйкес оқыту мақсаттары</th><td>${escapeHtml(body.objective)}</td></tr><tr><th>Сабақтың мақсаты</th><td>${list(plan.lessonObjectives)}</td></tr><tr><th>Бағалау критерийлері <small>(әдістемелік толықтыру)</small></th><td>${list(plan.assessmentCriteria)}</td></tr>${valuesRow}</table><table class="flow-table"><colgroup><col style="width:8.8%"><col style="width:32.7%"><col style="width:35.3%"><col style="width:11.8%"><col style="width:11.4%"></colgroup><thead><tr class="flow-title"><th colspan="5">Сабақ барысы: 45 минут</th></tr><tr><th>Уақыты/кезеңдері</th><th>Педагогтің әрекеті</th><th>Оқушының әрекеті</th><th>Бағалау</th><th>Ресурстар</th></tr></thead><tbody>${rows}</tbody></table><section class="method-notes"><h3>Әдістемелік толықтырулар</h3><p><strong>Саралау және қолдау:</strong> ${escapeHtml(plan.differentiation)}</p><p><strong>Қауіпсіздік:</strong> ${escapeHtml(plan.safety)}</p><p><em>Бағалау критерийлері, дескрипторлар, баллдар, саралау және қауіпсіздік түсіндірмелері — ҚМЖ сапасын күшейтетін әдістемелік толықтырулар.</em></p></section></article>`;
  const text = `Қысқа мерзімді (сабақ) жоспары\nПән: ${body.subject}\nСынып: ${body.grade}\nБөлім: ${body.section}\nТақырып: ${body.topic}\nОқу мақсаты: ${body.objective}`;
  return { html, text, model, format: 'qmj-130', reference: reference ? { id: reference.id, topic: reference.topic, source: reference.source.collection } : null };
}

function apiConfig() {
  if (AI_PROVIDER === 'openai') return { key: OPENAI_API_KEY, url: 'https://api.openai.com/v1/chat/completions' };
  return { key: OPENROUTER_API_KEY, url: 'https://openrouter.ai/api/v1/chat/completions' };
}

async function generatePlan(body) {
  const reference = selectReference(body);
  if (reference) return renderPlan(body, planFromReference(reference, body), 'Дайын ҚМЖ', reference);
  const config = apiConfig();
  if (!config.key) return renderPlan(body, planFromReference(reference, body), reference ? 'ҚМЖ базасы' : 'demo-template', reference);
  const system = `Сен Қазақстан мектебінің тәжірибелі әдіскерісің. Бір сабаққа арналған, мазмұны өзара үйлесімді 45 минуттық ҚМЖ құрастыр. Пайдаланушы берген оқу мақсатының коды мен тұжырымын ешқашан өзгертпе және ойдан жаңа оқу мақсатын қоспа. Тапсырмалар пәнге, сынып жасына, тақырыпқа және оқу мақсатына нақты сәйкес болсын; жалпылама немесе мағынасыз мәтін жазба. Әр тапсырма үшін өлшенетін дескриптор және кемінде 1 оң бүтін балл көрсет. Педагог әрекетінде нақты әдіс пен жұмыс формасын жаз. Кезең минуттарының қосындысы дәл 45 болсын. Қосылған мұғалімдік ҚМЖ үлгісін құрылым мен идея көзі ретінде пайдалан, бірақ ол нормативтік құжат емес: ішіндегі қате, 40 минуттық бөлу немесе тақырыпқа сәйкес емес тапсырманы қайталама. Дене шынықтыруда жүктеме, арақашықтық, құрал және қауіпсіздікті нақтыла. Тек JSON қайтар: {"lessonObjectives":["..."],"assessmentCriteria":["..."],"stages":[{"name":"...","minutes":8,"method":"...","workForm":"...","teacherActions":["..."],"learnerActions":["..."],"descriptors":[{"text":"...","points":1}],"feedback":"...","resources":["..."],"support":"..."}],"differentiation":"...","safety":"..."}.`;
  const user = `Оқыту тілі: ${body.language}\nПән: ${body.subject}\nСынып: ${body.grade}\nБөлім: ${body.section}\nТақырып: ${body.topic}\nӨЗГЕРТІЛМЕЙТІН оқу мақсаты: ${body.objective}\nСынып ерекшелігі: ${body.classProfile || 'көрсетілмеген'}\nҚолжетімді ресурстар: ${body.availableResources || 'көрсетілмеген'}\nҚосымша талап: ${body.extra || 'жоқ'}\n\nМҰҒАЛІМ БЕРГЕН АНЫҚТАМАЛЫҚ ҮЛГІ:\n${referenceContext(reference)}`;
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

async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, provider: AI_PROVIDER, aiReady: Boolean(apiConfig().key), accessReady: Boolean(ADMIN_PASSWORD && ACCESS_CODE_SECRET && databaseReady()), referenceCount: referenceDatabase.records.length });
    if (req.method === 'GET' && pathname === '/api/references') {
      const access = await verifyAccessCode(requestAccessCode(req), false, requestDeviceId(req));
      if (!access.ok) return sendJson(res, access.status, { error: access.error, codeRequired: true });
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const grade = url.searchParams.get('grade') || '';
      const subject = url.searchParams.get('subject') || '';
      return sendJson(res, 200, { scope: referenceDatabase.source_scope, references: referenceSummaries(grade, subject) });
    }
    if (req.method === 'POST' && pathname === '/api/access/verify') {
      const body = await readJson(req);
      const result = await verifyAccessCode(requestAccessCode(req, body), false, requestDeviceId(req));
      if (!result.ok) return sendJson(res, result.status, { error: result.error });
      return sendJson(res, 200, { ok: true, expiresAt: result.record.expires_at, days: result.record.duration_days });
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
        const rows = await dbRequest('access_codes?select=id,code,label,duration_days,created_at,expires_at,is_active,last_used_at,usage_count,bound_device_1,bound_device_2,bound_device_1_at,bound_device_2_at,device_reset_count&order=created_at.desc');
        return sendJson(res, 200, { codes: rows || [] });
      }
      if (req.method === 'POST' && pathname === '/api/admin/codes') {
        const body = await readJson(req);
        const days = Number(body.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) return sendJson(res, 400, { error: 'Мерзім 1–365 күн аралығында болуы керек' });
        const code = createAccessCode();
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        const rows = await dbRequest('access_codes', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ code, label: String(body.label || '').trim().slice(0, 100), duration_days: days, expires_at: expiresAt })
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
