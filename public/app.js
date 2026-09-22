'use strict';

const $ = selector => document.querySelector(selector);
let current = { html: '', text: '' };

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
    const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ҚМЖ жасалмады');
    current = { html: data.html, text: data.text };
    $('#result').innerHTML = data.html;
    $('#modelLabel').textContent = data.model === 'demo-template' ? 'Демо құрылым' : 'ЖИ арқылы';
    $('#emptyResult').classList.add('hidden');
    $('#resultContent').classList.remove('hidden');
    if (window.innerWidth < 900) $('#resultCard').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    $('#formError').textContent = error.message;
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
  const html = `<html><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:1.2cm}body{font-family:'Times New Roman';font-size:12pt}h2,h3{text-align:center}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #000;padding:6px;vertical-align:top}ul{margin:0;padding-left:18px}.flow-table th:nth-child(1){width:13%}.flow-table th:nth-child(2){width:26%}.flow-table th:nth-child(3){width:21%}.flow-table th:nth-child(4){width:26%}.flow-table th:nth-child(5){width:14%}.legal-note{font-size:10pt;text-align:center}.method-notes{margin-top:16px}</style></head><body>${current.html}</body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ҚМЖ-${topic.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70)}.doc`;
  link.click();
  URL.revokeObjectURL(link.href);
}

$('#qmjForm').addEventListener('submit', generate);
$('#copyButton').addEventListener('click', copyPlan);
$('#printButton').addEventListener('click', () => window.print());
$('#wordButton').addEventListener('click', downloadWord);
loadSubjects().catch(() => { $('#formError').textContent = 'Пәндер тізімі жүктелмеді'; });
