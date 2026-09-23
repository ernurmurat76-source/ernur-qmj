'use strict';

const $ = selector => document.querySelector(selector);
let current = { html: '', text: '' };
const ACCESS_STORAGE_KEY = 'ernur-qmj-access-code';
const DEVICE_STORAGE_KEY = 'ernur-qmj-device-id';
let accessCode = localStorage.getItem(ACCESS_STORAGE_KEY) || '';
let deviceId = localStorage.getItem(DEVICE_STORAGE_KEY) || '';
if (!deviceId) {
  deviceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).map(value => value.toString(16)).join('')}`;
  localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
}

async function loadSubjects() {
  const subjects = await fetch('/subjects.json').then(response => response.json());
  subjects.forEach(subject => $('#subject').insertAdjacentHTML('beforeend', `<option value="${subject}">${subject}</option>`));
}

for (let grade = 1; grade <= 11; grade += 1) $('#grade').insertAdjacentHTML('beforeend', `<option value="${grade}-сынып">${grade}-сынып</option>`);

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.add('hidden'), 2500);
}

function formatExpiry(value) {
  return new Intl.DateTimeFormat('kk-KZ', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));
}

function lockBuilder(message = '') {
  accessCode = '';
  localStorage.removeItem(ACCESS_STORAGE_KEY);
  $('#accessGate').classList.remove('hidden');
  $('#accessStatus').classList.add('hidden');
  $('#builderLayout').classList.add('hidden');
  $('#accessError').textContent = message;
}

function unlockBuilder(code, expiresAt) {
  accessCode = code;
  localStorage.setItem(ACCESS_STORAGE_KEY, code);
  $('#accessGate').classList.add('hidden');
  $('#accessStatus').classList.remove('hidden');
  $('#builderLayout').classList.remove('hidden');
  $('#accessExpiry').textContent = `${formatExpiry(expiresAt)} дейін жарамды`;
}

async function verifyCode(code) {
  const response = await fetch('/api/access/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${code}`, 'X-Device-Id': deviceId },
    body: '{}'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Код тексерілмеді');
  return data;
}

async function enterWithCode(event) {
  event.preventDefault();
  const code = $('#accessCode').value.trim();
  const button = $('#accessForm button');
  $('#accessError').textContent = '';
  button.disabled = true;
  button.textContent = 'Тексеріліп жатыр...';
  try {
    const result = await verifyCode(code);
    unlockBuilder(code, result.expiresAt);
    toast('Код қабылданды');
  } catch (error) {
    lockBuilder(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Кіру';
  }
}

async function restoreAccess() {
  if (!accessCode) return lockBuilder();
  try {
    const result = await verifyCode(accessCode);
    unlockBuilder(accessCode, result.expiresAt);
  } catch (error) {
    lockBuilder(error.message);
  }
}

function payload() {
  return {
    subject: $('#subject').value,
    grade: $('#grade').value,
    language: $('#language').value,
    section: $('#section').value.trim(),
    topic: $('#topic').value.trim(),
    objective: $('#objective').value.trim(),
    organization: $('#organization').value.trim(),
    teacher: $('#teacher').value.trim(),
    date: $('#lessonDate').value,
    present: $('#present').value,
    absent: $('#absent').value,
    classProfile: $('#classProfile').value.trim(),
    availableResources: $('#availableResources').value.trim(),
    extra: $('#extra').value.trim()
  };
}

async function generate(event) {
  event.preventDefault();
  const button = $('#generateButton');
  const original = button.innerHTML;
  $('#formError').textContent = '';
  button.disabled = true;
  button.textContent = 'ҚМЖ құрастырылып жатыр...';
  try {
    const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessCode}`, 'X-Device-Id': deviceId }, body: JSON.stringify(payload()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ҚМЖ жасалмады');
    current = { html: data.html, text: data.text };
    $('#result').innerHTML = data.html;
    $('#modelLabel').textContent = data.model === 'demo-template' ? 'Дайын құрылым' : 'ҚМЖ дайын';
    $('#emptyResult').classList.add('hidden');
    $('#resultContent').classList.remove('hidden');
    if (window.innerWidth < 900) $('#resultCard').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    $('#formError').textContent = error.message;
    if (/код/i.test(error.message)) lockBuilder(error.message);
    toast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function copyPlan() {
  if (!current.text) return;
  await navigator.clipboard.writeText($('#result').innerText);
  toast('ҚМЖ мәтіні көшірілді');
}

function downloadWord() {
  if (!current.html) return;
  const topic = $('#topic').value.trim() || 'QMJ';
  const html = `<html><head><meta charset="utf-8"><style>@page{size:A4 portrait;margin:1cm 1.5cm 1cm 1.25cm}body{font-family:'Times New Roman',serif;font-size:12pt;line-height:1.15}h2,h3{text-align:center;font-size:12pt}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #000;padding:4px;vertical-align:top}.meta-table th{width:auto;text-align:left;background:#fff}.flow-table{font-size:10pt;margin-top:0}.flow-table th{font-size:10pt;text-align:center;background:#fff}.flow-table .flow-title th{font-size:12pt}.flow-table th:nth-child(1){width:8.8%}.flow-table th:nth-child(2){width:32.7%}.flow-table th:nth-child(3){width:35.3%}.flow-table th:nth-child(4){width:11.8%}.flow-table th:nth-child(5){width:11.4%}ul{margin:0;padding-left:16px}.legal-note{font-size:10pt;text-align:center}.method-notes{margin-top:12px;font-size:12pt}</style></head><body>${current.html}</body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ҚМЖ-${topic.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70)}.doc`;
  link.click();
  URL.revokeObjectURL(link.href);
}

$('#qmjForm').addEventListener('submit', generate);
$('#accessForm').addEventListener('submit', enterWithCode);
$('#changeCodeButton').addEventListener('click', () => lockBuilder());
$('#copyButton').addEventListener('click', copyPlan);
$('#printButton').addEventListener('click', () => window.print());
$('#wordButton').addEventListener('click', downloadWord);
$('#copyKaspi').addEventListener('click', async () => { await navigator.clipboard.writeText('4400430304147348'); toast('Kaspi карта нөмірі көшірілді'); });
loadSubjects().catch(() => { $('#formError').textContent = 'Пәндер тізімі жүктелмеді'; });
restoreAccess();
