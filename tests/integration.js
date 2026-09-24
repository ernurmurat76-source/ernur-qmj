'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

const databasePort = 4329;
const appPort = 3219;
let records = [];
let counter = 1;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(value === null ? '' : JSON.stringify(value));
}

function read(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

const database = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${databasePort}`);
  if (url.pathname !== '/rest/v1/access_codes') return json(res, 404, { message: 'not found' });
  const id = String(url.searchParams.get('id') || '').replace(/^eq\./, '');
  const code = String(url.searchParams.get('code') || '').replace(/^eq\./, '');
  if (req.method === 'GET') return json(res, 200, records.filter(item => (!id || item.id === id) && (!code || item.code === code)));
  if (req.method === 'POST') {
    const body = await read(req);
    const record = { id: `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`, created_at: new Date().toISOString(), is_active: true, usage_count: 0, last_used_at: null, ...body };
    records.unshift(record);
    return json(res, 201, [record]);
  }
  if (req.method === 'PATCH') {
    const body = await read(req);
    const updated = records.filter(item => !id || item.id === id);
    updated.forEach(item => Object.assign(item, body));
    return json(res, 200, updated);
  }
  if (req.method === 'DELETE') {
    records = records.filter(item => item.id !== id);
    return json(res, 204, null);
  }
  return json(res, 405, { message: 'method' });
});

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, options);
  const data = await response.json();
  return { status: response.status, data };
}

async function main() {
  await new Promise(resolve => database.listen(databasePort, '127.0.0.1', resolve));
  const app = spawn(process.execPath, ['server.js'], { cwd: require('path').join(__dirname, '..'), env: { ...process.env, PORT: String(appPort), ADMIN_PASSWORD: 'test-password', ACCESS_CODE_SECRET: 'test-secret-123456789012345678901234567890', SUPABASE_URL: `http://127.0.0.1:${databasePort}`, SUPABASE_SECRET_KEY: 'sb_secret_test-key', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: '' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 30; i += 1) {
      try { if ((await request('/api/health')).status === 200) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await request('/api/admin/codes')).status, 401);
    assert.equal((await request('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
    const login = await request('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
    assert.equal(login.status, 200);
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.data.token}` };
    const tooManySubjects = await request('/api/admin/codes', { method: 'POST', headers: auth, body: JSON.stringify({ label: 'Қате код', days: 45, allowedSubjects: ['Математика', 'Алгебра', 'Геометрия', 'Информатика'] }) });
    assert.equal(tooManySubjects.status, 400);
    const created = await request('/api/admin/codes', { method: 'POST', headers: auth, body: JSON.stringify({ label: 'Тест мұғалім', days: 45, allowedSubjects: ['Математика', 'Алгебра', 'Геометрия'] }) });
    assert.equal(created.status, 201);
    assert.match(created.data.code.code, /^ERNUR-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const teacherAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${created.data.code.code}`, 'X-Device-Id': '11111111-1111-4111-8111-111111111111' };
    const verified = await request('/api/access/verify', { method: 'POST', headers: teacherAuth, body: '{}' });
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.data.allowedSubjects, ['Математика', 'Алгебра', 'Геометрия']);
    const secondDeviceAuth = { ...teacherAuth, 'X-Device-Id': '22222222-2222-4222-8222-222222222222' };
    const thirdDeviceAuth = { ...teacherAuth, 'X-Device-Id': '33333333-3333-4333-8333-333333333333' };
    assert.equal((await request('/api/access/verify', { method: 'POST', headers: secondDeviceAuth, body: '{}' })).status, 200);
    assert.equal((await request('/api/access/verify', { method: 'POST', headers: thirdDeviceAuth, body: '{}' })).status, 403);
    const references = await request('/api/references?grade=5-%D1%81%D1%8B%D0%BD%D1%8B%D0%BF&subject=%D0%9C%D0%B0%D1%82%D0%B5%D0%BC%D0%B0%D1%82%D0%B8%D0%BA%D0%B0&term=1', { headers: teacherAuth });
    assert.equal(references.status, 200);
    assert.equal(references.data.references.length, 39);
    assert.ok(references.data.references[0].topic);
    const selected = references.data.references[0];
    const generatedFromBase = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Математика', grade: '5-сынып', term: '1', language: 'Қазақ тілі', section: selected.section, topic: selected.topic, objective: selected.objectives }) });
    assert.equal(generatedFromBase.status, 200);
    assert.equal(generatedFromBase.data.reference.id, selected.id);
    assert.ok(generatedFromBase.data.html.includes('45 минут'));
    assert.ok(generatedFromBase.data.html.includes('width:32.7%'));
    assert.ok(generatedFromBase.data.html.includes('Ұйымдастыру кезеңі</strong><br>5 минут'));
    assert.ok(generatedFromBase.data.html.includes('Сабақтың басы</strong><br>10 минут'));
    assert.ok(generatedFromBase.data.html.includes('Сабақтың ортасы</strong><br>25 минут'));
    assert.ok(generatedFromBase.data.html.includes('Сабақтың соңы</strong><br>5 минут'));
    assert.ok(generatedFromBase.data.html.includes('ББҮ'));
    assert.ok(generatedFromBase.data.html.includes('<table class="bbu-table">'));
    assert.equal((generatedFromBase.data.html.match(/Сабақ барысы: 45 минут/g) || []).length, 1);
    assert.ok(!generatedFromBase.data.html.includes('flow-title'));
    assert.match(generatedFromBase.data.referenceDocx, /^\/api\/reference-docx\/[0-9a-f]{16}$/);
    const originalDocx = await fetch(`http://127.0.0.1:${appPort}${generatedFromBase.data.referenceDocx}`, { headers: teacherAuth });
    assert.equal(originalDocx.status, 200);
    assert.match(originalDocx.headers.get('content-type') || '', /wordprocessingml\.document/);
    assert.ok((await originalDocx.arrayBuffer()).byteLength > 10000);
    const termTwo = await request('/api/references?grade=5-%D1%81%D1%8B%D0%BD%D1%8B%D0%BF&subject=%D0%9C%D0%B0%D1%82%D0%B5%D0%BC%D0%B0%D1%82%D0%B8%D0%BA%D0%B0&term=2', { headers: teacherAuth });
    assert.equal(termTwo.data.references.length, 39);
    const termTwoLesson = termTwo.data.references[0];
    const generatedTermTwo = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Математика', grade: '5-сынып', term: '2', language: 'Қазақ тілі', section: termTwoLesson.section, topic: termTwoLesson.topic, objective: termTwoLesson.objectives }) });
    assert.equal(generatedTermTwo.status, 200);
    assert.equal(generatedTermTwo.data.reference.id, termTwoLesson.id);
    assert.ok(generatedTermTwo.data.html.includes('1-тапсырма.'));
    assert.ok(generatedTermTwo.data.html.includes('/textbook-excerpts/task-'));
    assert.ok(generatedTermTwo.data.html.includes('Оқулық үзіндісіндегі'));
    assert.ok(generatedTermTwo.data.html.includes('жазбаша орында'));
    const excerptPath = generatedTermTwo.data.html.match(/\/textbook-excerpts\/task-[a-f0-9]{20}\.jpg/)[0];
    const excerptResponse = await fetch(`http://127.0.0.1:${appPort}${excerptPath}`);
    assert.equal(excerptResponse.status, 200);
    assert.equal(excerptResponse.headers.get('content-type'), 'image/jpeg');
    assert.ok((await excerptResponse.arrayBuffer()).byteLength > 10000);
    assert.ok(!generatedTermTwo.data.html.includes('бағдарлық PDF беті'));
    assert.ok(!generatedTermTwo.data.html.includes('Атамұра оқулығы'));
    assert.ok(!generatedTermTwo.data.html.includes('КТЖ-да берілген оқу мақсатына сәйкес'));
    assert.ok(!generatedTermTwo.data.html.includes('Тәсіл:'));
    assert.ok(!generatedTermTwo.data.html.includes('Бүкіл сыныппен жұмыс'));
    assert.ok(generatedTermTwo.data.html.includes('Сыныптағы оқушылардың көңіл күйлерін сұрап'));
    assert.ok(generatedTermTwo.data.html.includes('Сабақтың ортасы</strong><br>25 минут'));
    assert.ok(!generatedTermTwo.data.html.includes('Бағалау критерийлері'));
    assert.equal((generatedTermTwo.data.html.match(/Дескриптор —/g) || []).length, 6);
    assert.equal((generatedTermTwo.data.html.match(/45 минут/g) || []).length, 1);
    assert.ok(generatedTermTwo.data.html.includes('ББҮ кестесін толтырады'));
    assert.ok(generatedTermTwo.data.html.includes('<table class="bbu-table">'));
    assert.equal(generatedTermTwo.data.referenceDocx, null);
    const clientScript = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(clientScript.includes("canvas.toDataURL('image/png')"));
    assert.ok(clientScript.includes('buildGeneratedDocx'));
    assert.ok(clientScript.includes('[933, 3467, 3743, 1251, 1208]'));
    assert.ok(clientScript.includes('<w:tblLayout w:type="fixed"/>'));
    assert.ok(clientScript.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    assert.ok(clientScript.includes(".docx`"));
    assert.ok(clientScript.includes('img[src^="/textbook-excerpts/"]'));
    assert.ok(clientScript.includes('JSZip.loadAsync'));
    assert.ok(clientScript.includes('updateReferenceDocumentXml'));
    assert.ok(clientScript.includes("String(fields.teacher || '').trim() || '____________________________'"));
    assert.ok(clientScript.includes('Умбетова\\s+Меруерт\\s+Мирзамидиновна'));
    assert.equal(generatedTermTwo.data.model, 'Атамұра ҚМЖ базасы · ЖИ қолданылмады');
    const crossTermMatch = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Математика', grade: '5-сынып', term: '4', language: 'Қазақ тілі', section: termTwoLesson.section, topic: termTwoLesson.topic, objective: termTwoLesson.objectives }) });
    assert.equal(crossTermMatch.status, 200);
    assert.equal(crossTermMatch.data.reference.id, termTwoLesson.id);
    assert.equal(crossTermMatch.data.reference.term, 2);
    assert.equal(crossTermMatch.data.model, 'Атамұра ҚМЖ базасы · ЖИ қолданылмады');
    const optionalTermMatch = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Математика', grade: '5-сынып', term: '', language: 'Қазақ тілі', section: termTwoLesson.section, topic: termTwoLesson.topic, objective: termTwoLesson.objectives }) });
    assert.equal(optionalTermMatch.status, 200);
    assert.equal(optionalTermMatch.data.reference.id, termTwoLesson.id);
    const pageHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(pageHtml.includes('Тоқсан (міндетті емес)'));
    assert.ok(pageHtml.includes('id="track"'));
    assert.ok(clientScript.includes("track: $('#track').value"));
    const blockedSubject = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Қазақстан тарихы', grade: '7-сынып', term: '2', language: 'Қазақ тілі', section: 'Бөлім', topic: 'Тақырып', objective: '7.1.1.1 — мақсат' }) });
    assert.equal(blockedSubject.status, 403);
    const id = created.data.code.id;
    const subjectsUpdated = await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'subjects', allowedSubjects: ['Математика', 'Қазақстан тарихы'] }) });
    assert.equal(subjectsUpdated.status, 200);
    const generated = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Қазақстан тарихы', grade: '7-сынып', term: '2', language: 'Қазақ тілі', section: 'Бөлім', topic: 'Тақырып', objective: '7.1.1.1 — мақсат' }) });
    assert.equal(generated.status, 200);
    assert.ok(generated.data.html.includes('45 минут'));
    assert.ok(generated.data.html.includes('Ұйымдастыру кезеңі</strong><br>5 минут'));
    assert.ok(generated.data.html.includes('Сабақтың басы</strong><br>10 минут'));
    assert.ok(generated.data.html.includes('Сабақтың ортасы</strong><br>25 минут'));
    assert.ok(generated.data.html.includes('Сабақтың соңы</strong><br>5 минут'));
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'toggle', isActive: false }) })).status, 200);
    assert.equal((await request('/api/access/verify', { method: 'POST', headers: teacherAuth, body: '{}' })).status, 401);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'toggle', isActive: true }) })).status, 200);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'extend', days: 30 }) })).status, 200);
    const list = await request('/api/admin/codes', { headers: auth });
    assert.equal(list.data.codes.length, 1);
    assert.ok(list.data.codes[0].bound_device_1);
    assert.ok(list.data.codes[0].bound_device_2);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'reset_device' }) })).status, 200);
    assert.equal((await request('/api/access/verify', { method: 'POST', headers: thirdDeviceAuth, body: '{}' })).status, 200);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal((await request('/api/admin/codes', { headers: auth })).data.codes.length, 0);
    console.log('Admin CRUD, 1-3 subject permissions, two-device access control, 1439-reference database and 1164 prepared no-AI plans: OK');
  } finally {
    app.kill();
    database.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
