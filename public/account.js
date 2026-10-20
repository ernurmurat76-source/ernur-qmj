'use strict';

const $ = selector => document.querySelector(selector);
const TOKEN_KEY = 'e-tarih-teacher-token';
const ACCESS_KEY = 'ernur-qmj-access-code';
const DEVICE_KEY = 'ernur-qmj-device-id';
let teacherToken = localStorage.getItem(TOKEN_KEY) || '';
let deviceId = localStorage.getItem(DEVICE_KEY) || '';
let accountMeta = JSON.parse(localStorage.getItem('e-tarih-account-meta') || '{}');

if (!deviceId) {
  deviceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(DEVICE_KEY, deviceId);
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.add('hidden'), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      ...(teacherToken ? { 'X-Teacher-Token': teacherToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Сұраныс орындалмады');
  return data;
}

function showAuth(mode = 'login') {
  $('#authPanel').classList.remove('hidden');
  $('#dashboard').classList.add('hidden');
  const login = mode === 'login';
  $('#loginForm').classList.toggle('hidden', !login);
  $('#registerForm').classList.toggle('hidden', login);
  $('#loginTab').classList.toggle('active', login);
  $('#registerTab').classList.toggle('active', !login);
}

function storeSession(data) {
  teacherToken = data.token;
  accountMeta = { expiresAt: data.expiresAt, allowedSubjects: data.allowedSubjects || [] };
  localStorage.setItem(TOKEN_KEY, teacherToken);
  localStorage.setItem(ACCESS_KEY, data.accessCode);
  localStorage.setItem('e-tarih-account-meta', JSON.stringify(accountMeta));
}

function formatDate(value) {
  if (!value) return 'Көрсетілмеген';
  return new Intl.DateTimeFormat('kk-KZ', { dateStyle: 'long' }).format(new Date(value));
}

function fillProfile(profile) {
  $('#welcomeName').textContent = `${profile.fullName}, қош келдіңіз!`;
  $('#profileSummary').textContent = [profile.school, profile.subject].filter(Boolean).join(' · ') || profile.email;
  $('#profileName').value = profile.fullName || '';
  $('#profileSchool').value = profile.school || '';
  $('#profileSubject').value = profile.subject || '';
  $('#profilePhone').value = profile.phone || '';
  $('#subjectCount').textContent = String((accountMeta.allowedSubjects || []).length);
  $('#accountExpiry').textContent = formatDate(accountMeta.expiresAt);
}

function documentCard(item) {
  const meta = [item.subject, item.grade, item.term ? `${item.term}-тоқсан` : ''].filter(Boolean).join(' · ');
  return `<article class="document-item"><div><span>${meta || 'ҚМЖ'}</span><h3>${escapeHtml(item.title || item.topic || 'ҚМЖ')}</h3><small>${formatDate(item.created_at)}</small></div><div class="document-actions"><button data-open="${item.id}" type="button">Ашу</button><button class="danger" data-delete="${item.id}" type="button">Өшіру</button></div></article>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function loadDocuments() {
  const data = await api('/api/account/documents');
  $('#documentCount').textContent = String(data.documents.length);
  $('#documentsList').innerHTML = data.documents.length ? data.documents.map(documentCard).join('') : '<p class="documents-empty">Әзірге сақталған ҚМЖ жоқ. Алғашқы жоспарыңызды құрастырыңыз.</p>';
}

async function openDashboard(profile) {
  $('#authPanel').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  fillProfile(profile);
  await loadDocuments();
}

async function restoreSession() {
  if (!teacherToken) return showAuth();
  try {
    const data = await api('/api/account/me');
    await openDashboard(data.profile);
  } catch {
    teacherToken = '';
    localStorage.removeItem(TOKEN_KEY);
    showAuth();
  }
}

$('#loginTab').addEventListener('click', () => showAuth('login'));
$('#registerTab').addEventListener('click', () => showAuth('register'));

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  $('#loginError').textContent = '';
  button.disabled = true;
  try {
    const data = await api('/api/account/login', { method: 'POST', body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value }) });
    storeSession(data);
    await openDashboard(data.profile);
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  $('#registerError').textContent = '';
  button.disabled = true;
  try {
    const data = await api('/api/account/register', { method: 'POST', body: JSON.stringify({
      fullName: $('#registerName').value,
      email: $('#registerEmail').value,
      school: $('#registerSchool').value,
      subject: $('#registerSubject').value,
      accessCode: $('#registerCode').value,
      password: $('#registerPassword').value
    }) });
    storeSession(data);
    await openDashboard(data.profile);
    toast('Жеке кабинет ашылды');
  } catch (error) { $('#registerError').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#profileError').textContent = '';
  try {
    const data = await api('/api/account/me', { method: 'PATCH', body: JSON.stringify({ fullName: $('#profileName').value, school: $('#profileSchool').value, subject: $('#profileSubject').value, phone: $('#profilePhone').value }) });
    fillProfile(data.profile);
    toast('Профиль сақталды');
  } catch (error) { $('#profileError').textContent = error.message; }
});

$('#documentsList').addEventListener('click', async event => {
  const openId = event.target.dataset.open;
  const deleteId = event.target.dataset.delete;
  if (openId) {
    try {
      const data = await api(`/api/account/documents/${openId}`);
      const popup = window.open('', '_blank');
      if (!popup) return toast('Құжатты ашу үшін браузердегі қалқымалы терезеге рұқсат беріңіз');
      popup.document.write(`<!doctype html><html lang="kk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(data.document.title)}</title><link rel="stylesheet" href="/styles.css"></head><body><main style="max-width:1100px;margin:auto;padding:20px">${data.document.generated_html}</main></body></html>`);
      popup.document.close();
    } catch (error) { toast(error.message); }
  }
  if (deleteId && confirm('Бұл құжатты өшіресіз бе?')) {
    try { await api(`/api/account/documents/${deleteId}`, { method: 'DELETE' }); await loadDocuments(); toast('Құжат өшірілді'); }
    catch (error) { toast(error.message); }
  }
});

$('#refreshDocuments').addEventListener('click', () => loadDocuments().catch(error => toast(error.message)));
$('#logoutButton').addEventListener('click', () => {
  teacherToken = '';
  localStorage.removeItem(TOKEN_KEY);
  showAuth();
});

restoreSession();
