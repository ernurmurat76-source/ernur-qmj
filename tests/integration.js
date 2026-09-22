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
    const created = await request('/api/admin/codes', { method: 'POST', headers: auth, body: JSON.stringify({ label: 'Тест мұғалім', days: 45 }) });
    assert.equal(created.status, 201);
    assert.match(created.data.code.code, /^ERNUR-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const teacherAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${created.data.code.code}` };
    assert.equal((await request('/api/access/verify', { method: 'POST', headers: teacherAuth, body: '{}' })).status, 200);
    const generated = await request('/api/generate', { method: 'POST', headers: teacherAuth, body: JSON.stringify({ subject: 'Қазақстан тарихы', grade: '7-сынып', language: 'Қазақ тілі', section: 'Бөлім', topic: 'Тақырып', objective: '7.1.1.1 — мақсат' }) });
    assert.equal(generated.status, 200);
    assert.ok(generated.data.html.includes('45 минут'));
    const id = created.data.code.id;
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'toggle', isActive: false }) })).status, 200);
    assert.equal((await request('/api/access/verify', { method: 'POST', headers: teacherAuth, body: '{}' })).status, 401);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'toggle', isActive: true }) })).status, 200);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ action: 'extend', days: 30 }) })).status, 200);
    const list = await request('/api/admin/codes', { headers: auth });
    assert.equal(list.data.codes.length, 1);
    assert.equal((await request(`/api/admin/codes/${id}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal((await request('/api/admin/codes', { headers: auth })).data.codes.length, 0);
    console.log('Admin CRUD, access control and 45-minute QMJ: OK');
  } finally {
    app.kill();
    database.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
