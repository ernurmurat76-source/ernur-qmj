'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'openrouter').toLowerCase();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || (AI_PROVIDER === 'openai' ? 'gpt-4.1-mini' : 'openrouter/free');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

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

function normalizePlan(raw, body) {
  const fallback = demoPlan(body);
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

function renderPlan(body, plan, model) {
  const list = items => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const rows = plan.stages.map(stage => {
    const points = stage.descriptors.reduce((sum, item) => sum + item.points, 0);
    const teacher = `<p><strong><em>Тәсіл: ${escapeHtml(stage.method)}</em></strong></p><p><strong>${escapeHtml(stage.workForm)}</strong></p>${list(stage.teacherActions)}`;
    const assessment = `<strong>Дескрипторлар — ${points} балл:</strong>${list(stage.descriptors.map(item => `${item.text} — ${item.points}`))}<p><strong>Кері байланыс:</strong> ${escapeHtml(stage.feedback)}</p>${stage.support ? `<p><strong>Қолдау:</strong> ${escapeHtml(stage.support)}</p>` : ''}`;
    return `<tr><td><strong>${escapeHtml(stage.name)}</strong><br>${stage.minutes} минут</td><td>${teacher}</td><td>${list(stage.learnerActions)}</td><td>${assessment}</td><td>${list(stage.resources)}</td></tr>`;
  }).join('');
  const html = `<article class="qmj-document"><h2>Қысқа мерзімді (сабақ) жоспары</h2><p class="legal-note">№130 бұйрық нысанының міндетті тармақтарына негізделген</p><table class="meta-table"><tr><th>Білім беру ұйымының атауы</th><td>${escapeHtml(body.organization || '____________________________')}</td></tr><tr><th>Бөлім</th><td>${escapeHtml(body.section)}</td></tr><tr><th>Педагогтің тегі, аты, әкесінің аты</th><td>${escapeHtml(body.teacher || '____________________________')}</td></tr><tr><th>Күні</th><td>${escapeHtml(body.date || '________________')}</td></tr><tr><th>Сынып</th><td>${escapeHtml(body.grade)} &nbsp; Қатысушылар саны: ${escapeHtml(body.present || '____')} &nbsp; Қатыспағандар саны: ${escapeHtml(body.absent || '____')}</td></tr><tr><th>Сабақтың тақырыбы</th><td>${escapeHtml(body.topic)}</td></tr><tr><th>Оқу бағдарламасына сәйкес оқыту мақсаттары</th><td>${escapeHtml(body.objective)}</td></tr><tr><th>Сабақтың мақсаты</th><td>${list(plan.lessonObjectives)}</td></tr><tr><th>Бағалау критерийлері <small>(әдістемелік толықтыру)</small></th><td>${list(plan.assessmentCriteria)}</td></tr></table><h3>Сабақтың барысы — 45 минут</h3><table class="flow-table"><thead><tr><th>Сабақтың кезеңі/уақыт</th><th>Педагогтің әрекеті</th><th>Оқушының әрекеті</th><th>Бағалау</th><th>Ресурстар</th></tr></thead><tbody>${rows}</tbody></table><section class="method-notes"><h3>Әдістемелік толықтырулар</h3><p><strong>Саралау және қолдау:</strong> ${escapeHtml(plan.differentiation)}</p><p><strong>Қауіпсіздік:</strong> ${escapeHtml(plan.safety)}</p><p><em>Бағалау критерийлері, дескрипторлар, баллдар, саралау және қауіпсіздік түсіндірмелері — ҚМЖ сапасын күшейтетін әдістемелік толықтырулар.</em></p></section></article>`;
  const text = `Қысқа мерзімді (сабақ) жоспары\nПән: ${body.subject}\nСынып: ${body.grade}\nБөлім: ${body.section}\nТақырып: ${body.topic}\nОқу мақсаты: ${body.objective}`;
  return { html, text, model, format: 'qmj-130' };
}

function apiConfig() {
  if (AI_PROVIDER === 'openai') return { key: OPENAI_API_KEY, url: 'https://api.openai.com/v1/chat/completions' };
  return { key: OPENROUTER_API_KEY, url: 'https://openrouter.ai/api/v1/chat/completions' };
}

async function generatePlan(body) {
  const config = apiConfig();
  if (!config.key) return renderPlan(body, demoPlan(body), 'demo-template');
  const system = `Сен Қазақстан мектебінің тәжірибелі әдіскерісің. Берілген нақты оқу мақсатын өзгертпей, бір 45 минуттық ҚМЖ мазмұнын құрастыр. Пәнге, сынып жасына және тақырыпқа сай болсын. Әр оқу тапсырмасы үшін бақыланатын дескриптор мен оң бүтін балл бер. Педагог әрекетінде нақты практикалық тәсіл мен жұмыс формасын көрсет, бірақ теориялық модельдер мен автор атауларын қоспа. Дене шынықтыруда жүктеме, арақашықтық, құрал және қауіпсіздікті нақтыла. Тек JSON қайтар: {"lessonObjectives":["..."],"assessmentCriteria":["..."],"stages":[{"name":"...","minutes":8,"method":"...","workForm":"...","teacherActions":["..."],"learnerActions":["..."],"descriptors":[{"text":"...","points":1}],"feedback":"...","resources":["..."],"support":"..."}],"differentiation":"...","safety":"..."}. Кезең минуттарының қосындысы дәл 45 болсын.`;
  const user = `Оқыту тілі: ${body.language}\nПән: ${body.subject}\nСынып: ${body.grade}\nБөлім: ${body.section}\nТақырып: ${body.topic}\nОқу мақсаты: ${body.objective}\nСынып ерекшелігі: ${body.classProfile || 'көрсетілмеген'}\nҚолжетімді ресурстар: ${body.availableResources || 'көрсетілмеген'}\nҚосымша талап: ${body.extra || 'жоқ'}`;
  const headers = { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' };
  if (AI_PROVIDER !== 'openai') Object.assign(headers, { 'HTTP-Referer': process.env.PUBLIC_URL || `http://localhost:${PORT}`, 'X-Title': 'ernur-qmj' });
  const response = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.25, max_tokens: 4500 }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || 'ЖИ сервисі жауап бермеді');
  const content = result?.choices?.[0]?.message?.content;
  if (!content) throw new Error('ЖИ бос жауап қайтарды');
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return renderPlan(body, normalizePlan(JSON.parse(cleaned), body), result.model || AI_MODEL);
  } catch {
    return renderPlan(body, demoPlan(body), `${result.model || AI_MODEL} · құрылымдық резерв`);
  }
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, provider: AI_PROVIDER, aiReady: Boolean(apiConfig().key) });
    if (req.method === 'POST' && pathname === '/api/generate') {
      const body = await readJson(req);
      const required = ['subject', 'grade', 'language', 'section', 'topic', 'objective'];
      if (required.some(key => !String(body[key] || '').trim())) return sendJson(res, 400, { error: 'Пән, сынып, тіл, бөлім, тақырып және нақты оқу мақсатын толтырыңыз' });
      return sendJson(res, 200, await generatePlan(body));
    }
    return sendJson(res, 404, { error: 'API жолы табылмады' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || 'Сервер қатесі' });
  }
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) return sendJson(res, 403, { error: 'Рұқсат жоқ' });
  fs.readFile(target, (error, data) => {
    if (error) return sendJson(res, 404, { error: 'Файл табылмады' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => console.log(`ernur-qmj: http://${HOST}:${PORT}`));
