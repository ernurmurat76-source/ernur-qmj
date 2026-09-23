'use strict';

const $ = selector => document.querySelector(selector);
const SESSION_KEY = 'ernur-qmj-admin-session';
let adminToken = sessionStorage.getItem(SESSION_KEY) || '';
let codes = [];

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.add('hidden'), 2500);
}

function formatDate(value) {
  if (!value) return 'Қолданылмаған';
  return new Intl.DateTimeFormat('kk-KZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function remainingDays(value) {
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400000));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/admin/login') logout(false);
    throw new Error(data.error || 'Сұраныс орындалмады');
  }
  return data;
}

function showDashboard() {
  $('#loginPanel').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
}

function logout(showMessage = true) {
  adminToken = '';
  sessionStorage.removeItem(SESSION_KEY);
  $('#dashboard').classList.add('hidden');
  $('#loginPanel').classList.remove('hidden');
  if (showMessage) toast('Әкімші бөлімінен шықтыңыз');
}

function statusOf(item) {
  if (!item.is_active) return { key: 'off', text: 'Тоқтатылған' };
  if (new Date(item.expires_at).getTime() <= Date.now()) return { key: 'expired', text: 'Мерзімі біткен' };
  return { key: 'active', text: 'Белсенді' };
}

function updateStats() {
  const statuses = codes.map(statusOf);
  $('#totalCount').textContent = codes.length;
  $('#activeCount').textContent = statuses.filter(item => item.key === 'active').length;
  $('#expiredCount').textContent = statuses.filter(item => item.key === 'expired').length;
  $('#usageCount').textContent = codes.reduce((sum, item) => sum + Number(item.usage_count || 0), 0);
}

function renderCodes() {
  updateStats();
  $('#codesEmpty').classList.toggle('hidden', codes.length > 0);
  $('#codesBody').innerHTML = codes.map(item => {
    const status = statusOf(item);
    const days = remainingDays(item.expires_at);
    const deviceCount = Number(Boolean(item.bound_device_1)) + Number(Boolean(item.bound_device_2));
    return `<tr>
      <td><strong>${escapeHtml(item.label || 'Атаусыз мұғалім')}</strong><code>${escapeHtml(item.code)}</code><button class="mini-copy" data-copy="${escapeHtml(item.code)}">Көшіру</button></td>
      <td><span class="code-status ${status.key}">${status.text}</span></td>
      <td><strong>${days} күн қалды</strong><small>${formatDate(item.expires_at)}</small></td>
      <td><strong>${Number(item.usage_count || 0)} рет</strong><small>${formatDate(item.last_used_at)}</small><small>Құрылғы: ${deviceCount}/2</small></td>
      <td><div class="row-actions"><button data-action="extend" data-id="${item.id}">Ұзарту</button><button data-action="toggle" data-active="${!item.is_active}" data-id="${item.id}">${item.is_active ? 'Тоқтату' : 'Қосу'}</button>${deviceCount ? `<button data-action="reset_device" data-id="${item.id}">Құрылғыларды босату</button>` : ''}<button class="danger" data-action="delete" data-id="${item.id}">Жою</button></div></td>
    </tr>`;
  }).join('');
}

async function loadCodes() {
  $('#listError').textContent = '';
  try {
    const data = await api('/api/admin/codes');
    codes = data.codes;
    renderCodes();
  } catch (error) { $('#listError').textContent = error.message; }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#loginButton');
  $('#loginError').textContent = '';
  button.disabled = true;
  button.textContent = 'Кіріп жатыр...';
  try {
    const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#adminPassword').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Кіру орындалмады');
    adminToken = data.token;
    sessionStorage.setItem(SESSION_KEY, adminToken);
    $('#adminPassword').value = '';
    showDashboard();
    await loadCodes();
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Кіру'; }
});

document.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => { $('#durationDays').value = button.dataset.days; }));

$('#createCodeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const days = Number($('#durationDays').value);
  const button = $('#createCodeButton');
  $('#createError').textContent = '';
  $('#createdCode').classList.add('hidden');
  if (!Number.isInteger(days) || days < 1 || days > 365) return void ($('#createError').textContent = '1 мен 365 аралығындағы толық күн санын енгізіңіз');
  button.disabled = true;
  button.textContent = 'Жасалып жатыр...';
  try {
    const data = await api('/api/admin/codes', { method: 'POST', body: JSON.stringify({ label: $('#codeLabel').value, days }) });
    $('#codeValue').textContent = data.code.code;
    $('#codeExpiry').textContent = `${days} күнге берілді. ${formatDate(data.code.expires_at)} дейін жарамды.`;
    $('#createdCode').classList.remove('hidden');
    $('#codeLabel').value = '';
    await loadCodes();
    toast('Жаңа код дайын');
  } catch (error) { $('#createError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Жаңа код жасау'; }
});

$('#codesBody').addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy]');
  if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); return toast('Код көшірілді'); }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const item = codes.find(code => code.id === button.dataset.id);
  if (!item) return;
  try {
    if (button.dataset.action === 'delete') {
      if (!confirm(`«${item.label || item.code}» кодын біржола жоясыз ба?`)) return;
      await api(`/api/admin/codes/${item.id}`, { method: 'DELETE' });
      toast('Код жойылды');
    } else if (button.dataset.action === 'toggle') {
      await api(`/api/admin/codes/${item.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'toggle', isActive: button.dataset.active === 'true' }) });
      toast(button.dataset.active === 'true' ? 'Код қайта қосылды' : 'Код тоқтатылды');
    } else if (button.dataset.action === 'extend') {
      const days = Number(prompt('Неше күнге ұзартамыз? (1–365)', '30'));
      if (!Number.isInteger(days) || days < 1 || days > 365) return days ? toast('1–365 аралығындағы күн санын енгізіңіз') : undefined;
      await api(`/api/admin/codes/${item.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'extend', days }) });
      toast(`Код ${days} күнге ұзартылды`);
    } else if (button.dataset.action === 'reset_device') {
      if (!confirm('Осы кодқа байланысқан екі құрылғыны босатасыз ба?')) return;
      await api(`/api/admin/codes/${item.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'reset_device' }) });
      toast('Құрылғылар босатылды');
    }
    await loadCodes();
  } catch (error) { toast(error.message); }
});

$('#copyCodeButton').addEventListener('click', async () => { await navigator.clipboard.writeText($('#codeValue').textContent); toast('Код көшірілді'); });
$('#refreshButton').addEventListener('click', loadCodes);
$('#logoutButton').addEventListener('click', () => logout());

if (adminToken) { showDashboard(); loadCodes(); }
