'use strict';

const $ = selector => document.querySelector(selector);
let current = { html: '', text: '' };
const ACCESS_STORAGE_KEY = 'ernur-qmj-access-code';
const DEVICE_STORAGE_KEY = 'ernur-qmj-device-id';
let accessCode = localStorage.getItem(ACCESS_STORAGE_KEY) || '';
let deviceId = localStorage.getItem(DEVICE_STORAGE_KEY) || '';
let allSubjects = [];
let activeAllowedSubjects = [];
if (!deviceId) {
  deviceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).map(value => value.toString(16)).join('')}`;
  localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
}

async function loadSubjects() {
  allSubjects = await fetch('/subjects.json').then(response => response.json());
  renderAllowedSubjects(activeAllowedSubjects.length ? activeAllowedSubjects : allSubjects);
}

function renderAllowedSubjects(subjects) {
  const valid = allSubjects.filter(subject => subjects.includes(subject));
  $('#subject').innerHTML = '<option value="">Пәнді таңдаңыз</option>' + valid.map(subject => `<option value="${subject}">${subject}</option>`).join('');
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

function unlockBuilder(code, expiresAt, allowedSubjects = []) {
  accessCode = code;
  activeAllowedSubjects = allowedSubjects;
  localStorage.setItem(ACCESS_STORAGE_KEY, code);
  $('#accessGate').classList.add('hidden');
  $('#accessStatus').classList.remove('hidden');
  $('#builderLayout').classList.remove('hidden');
  if (allSubjects.length) renderAllowedSubjects(activeAllowedSubjects);
  $('#accessExpiry').textContent = `${formatExpiry(expiresAt)} дейін жарамды · Пәндер: ${activeAllowedSubjects.join(', ')}`;
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
    unlockBuilder(code, result.expiresAt, result.allowedSubjects || []);
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
    unlockBuilder(accessCode, result.expiresAt, result.allowedSubjects || []);
  } catch (error) {
    lockBuilder(error.message);
  }
}

function payload() {
  return {
    subject: $('#subject').value,
    grade: $('#grade').value,
    term: $('#term').value,
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

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') || '';
}

async function visualToPngBase64(src) {
  const response = await fetch(src);
  if (!response.ok) throw new Error('Сызба жүктелмеді');
  const svg = await response.text();
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Сызба өңделмеді'));
      image.src = objectUrl;
    });
    const sourceWidth = image.naturalWidth || 900;
    const sourceHeight = image.naturalHeight || 520;
    const width = 1200;
    const height = Math.max(240, Math.round(width * sourceHeight / sourceWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1];
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function downloadWord() {
  if (!current.html) return;
  const topic = $('#topic').value.trim() || 'QMJ';
  const wrapper = document.createElement('div');
  wrapper.innerHTML = current.html;
  const attachments = [];
  await Promise.all([...wrapper.querySelectorAll('img[src^="/visuals/"]')].map(async (img, index) => {
    try {
      const cid = `qmj-visual-${index + 1}.png`;
      const base64 = await visualToPngBase64(img.getAttribute('src'));
      attachments.push({ cid, base64 });
      img.src = `cid:${cid}`;
    } catch { /* ҚМЖ сурет жүктелмесе де мәтінмен сақталады. */ }
  }));
  const html = `<html><head><meta charset="utf-8"><style>@page{size:A4 portrait;margin:1cm 1.5cm 1cm 1.25cm}body{font-family:'Times New Roman',serif;font-size:12pt;line-height:1.15}h2,h3{text-align:center;font-size:12pt}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #000;padding:4px;vertical-align:top}.meta-table th{width:auto;text-align:left;background:#fff}.flow-table{font-size:10pt;margin-top:0}.flow-table th{font-size:10pt;text-align:center;background:#fff}.flow-table .flow-title th{font-size:12pt}.flow-table th:nth-child(1){width:8.8%}.flow-table th:nth-child(2){width:32.7%}.flow-table th:nth-child(3){width:35.3%}.flow-table th:nth-child(4){width:11.8%}.flow-table th:nth-child(5){width:11.4%}ul{margin:0;padding-left:16px}.legal-note{font-size:10pt;text-align:center}.math-visual{text-align:center;page-break-inside:avoid}.math-visual img{max-width:520px;width:100%;height:auto}.math-visual figcaption{font-size:10pt}.lesson-task{margin:8px 0;padding:6px;border:1px solid #777;page-break-inside:avoid}.task-descriptor{margin:4px 0;padding:5px;background:#f1f1f1;border-left:3px solid #333}</style></head><body>${wrapper.innerHTML}</body></html>`;
  const boundary = `----=_QMJ_${Date.now()}`;
  const parts = [
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    'Content-Location: file:///C:/qmj.html',
    '',
    wrapBase64(utf8ToBase64(html))
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      `Content-Location: ${attachment.cid}`,
      `Content-ID: <${attachment.cid}>`,
      '',
      wrapBase64(attachment.base64)
    );
  }
  parts.push(`--${boundary}--`, '');
  const blob = new Blob([parts.join('\r\n')], { type: 'application/msword' });
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
