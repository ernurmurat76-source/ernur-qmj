'use strict';

const $ = selector => document.querySelector(selector);
const ACCESS_KEY = 'ernur-qmj-access-code';
const DEVICE_KEY = 'ernur-qmj-device-id';
const TEACHER_TOKEN_KEY = 'e-tarih-teacher-token';
let deviceId = localStorage.getItem(DEVICE_KEY) || '';
let activeMode = new URLSearchParams(location.search).get('mode') || 'assistant';
let currentResult = '';
let currentTitle = '';

if (!deviceId) {
  deviceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(DEVICE_KEY, deviceId);
}

const modeInfo = {
  assistant: ['Е-Көмекші', 'Мұғалім сұрағына жауап беріп, қолдануға дайын материал әзірлейді.', 'Сұрағыңыз немесе тақырып'],
  essay: ['Эссе құрастыру', 'Тақырыпқа сай құрылымды және сауатты эссе дайындайды.', 'Эссе тақырыбы'],
  article: ['Мақала құрастыру', 'Тақырыпшалары мен қорытындысы бар мақала дайындайды.', 'Мақала тақырыбы'],
  report: ['Баяндама құрастыру', 'Мектепте қолдануға болатын ресми баяндама әзірлейді.', 'Баяндама тақырыбы'],
  'author-program': ['Авторлық бағдарлама', 'Авторлық бағдарламаның құрылымы мен мазмұнын әзірлейді.', 'Бағдарлама тақырыбы'],
  worksheet: ['Жұмыс парағы', 'Оқушыға арналған тапсырмалар мен жұмыс парағын дайындайды.', 'Сабақ тақырыбы'],
  bjb: ['БЖБ құрастыру', 'Бөлім бойынша тапсырмалар, дескрипторлар, балл және жауап кілтін дайындайды.', 'Бөлім, оқу мақсаттары және тапсырма талаптары'],
  tjb: ['ТЖБ құрастыру', 'Тоқсан бойынша тапсырмалар, дескрипторлар, балл және жауап кілтін дайындайды.', 'Тоқсан, оқу мақсаттары және тапсырма талаптары'],
  ktj: ['КТЖ құрастыру', 'Жалпы сағат санына сай күнтізбелік-тақырыптық жоспар дайындайды.', 'Бөлімдер, тақырыптар, оқу мақсаттары және жалпы сағат'],
  presentation: ['Презентация', 'Слайдтардың реті, дайын мәтіні, визуал ұсынысы және мұғалім сөзі.', 'Сабақ тақырыбы және оқу мақсаты'],
  quiz: ['Е-Тапқыр викторинасы', 'Сұрақтар, жауап нұсқалары, дұрыс жауап және балл жүйесі.', 'Викторина тақырыбы мен сұрақ саны'],
  'game-builder': ['Ойын құрастыру', 'Сәйкестендіру, топтастыру және карточкалық ойын әзірлейді.', 'Ойын тақырыбы, түрі және ережесі'],
  'lesson-game': ['Сабақ ойындары', 'Сабақтың басы, ортасы немесе соңына арналған ойындар.', 'Тақырып, сабақ кезеңі және уақыт'],
  'visual-aid': ['Көрнекіліктер', 'Карточка, постер және инфографикаға дайын мазмұн жасайды.', 'Тақырып және көрнекілік түрі'],
  'e-alem': ['Е-Алем', 'Елдер, карталар және тарихи оқиғалар бойынша танымдық тапсырма.', 'Ел, аймақ немесе тарихи оқиға'],
  'chemistry-lab': ['Химия зертханасы', 'Қауіпсіз зертханалық жұмыс, құралдар, барысы және қорытынды.', 'Тақырып, реактивтер және оқу мақсаты'],
  'interactive-ppt': ['Интерактивті PowerPoint', 'Слайд сценарийі, батырмалар, ойын шарты және жауаптар.', 'Тақырып және интерактив түрі'],
  'e-kids': ['Е-KIDS', 'Мектепалды даярлыққа арналған әріп, сан және мінез-құлық ойындары.', 'Баланың жасы және тақырып'],
  course: ['Курстар', 'Модульдері, сабақтары және тапсырмалары бар курс бағдарламасы.', 'Курс тақырыбы, аудиториясы және ұзақтығы']
};

function toast(message) { $('#toast').textContent = message; $('#toast').classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.add('hidden'), 2500); }
function setMode(mode) { activeMode = modeInfo[mode] ? mode : 'assistant'; const info = modeInfo[activeMode]; $('#pageTitle').textContent = info[0]; $('#pageDescription').textContent = info[1]; $('#promptLabel').childNodes[0].nodeValue = info[2]; $('#toolPrompt').placeholder = ['bjb', 'tjb'].includes(activeMode) ? 'Мысалы: 2-тоқсан. Бөлім: ...\nОқу мақсаттары: ...\nТапсырма саны: 6\nЖалпы балл: 20\nУақыты: 40 минут' : 'Тақырыпты және қажетті талаптарды толық жазыңыз'; document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === activeMode)); history.replaceState(null, '', `?mode=${activeMode}`); }

async function loadOptions() {
  const subjects = await fetch('/subjects.json').then(response => response.json());
  $('#toolSubject').insertAdjacentHTML('beforeend', subjects.map(subject => `<option>${subject}</option>`).join(''));
  for (let grade = 1; grade <= 11; grade += 1) $('#toolGrade').insertAdjacentHTML('beforeend', `<option value="${grade}-сынып">${grade}-сынып</option>`);
}

async function generate(event) {
  event.preventDefault();
  const button = $('#toolGenerate');
  const accessCode = $('#toolAccessCode').value.trim().toUpperCase();
  $('#toolError').textContent = '';
  button.disabled = true; button.textContent = 'Материал дайындалып жатыр...';
  try {
    const response = await fetch('/api/tools/text', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessCode}`, 'X-Device-Id': deviceId }, body: JSON.stringify({ mode: activeMode, subject: $('#toolSubject').value, grade: $('#toolGrade').value, prompt: $('#toolPrompt').value, requirements: $('#toolRequirements').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Материал жасалмады');
    localStorage.setItem(ACCESS_KEY, accessCode);
    currentResult = data.content; currentTitle = data.title || modeInfo[activeMode][0];
    $('#toolOutput').textContent = currentResult; $('#toolOutput').classList.remove('hidden'); $('#toolPlaceholder').classList.add('hidden');
    if (innerWidth < 900) $('.tool-result').scrollIntoView({ behavior: 'smooth' });
  } catch (error) { $('#toolError').textContent = error.message; toast(error.message); }
  finally { button.disabled = false; button.textContent = '✦ Материал дайындау'; }
}

function xmlEscape(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char])); }
function htmlEscape(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

async function saveToCabinet() {
  if (!currentResult) return toast('Алдымен материал дайындаңыз');
  const token = localStorage.getItem(TEACHER_TOKEN_KEY);
  if (!token) return toast('Алдымен жеке кабинетке кіріңіз');
  const subject = $('#toolSubject').value;
  const grade = $('#toolGrade').value;
  const title = `${modeInfo[activeMode][0]} — ${$('#toolPrompt').value.trim().split('\n')[0].slice(0, 100)}`;
  const html = `<article class="qmj-document"><h2>${htmlEscape(title)}</h2>${currentResult.split(/\n/).map(line => `<p>${htmlEscape(line || ' ')}</p>`).join('')}</article>`;
  const response = await fetch('/api/account/documents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': token }, body: JSON.stringify({ title, html, text: currentResult, fields: { subject, grade, topic: title, toolMode: activeMode } }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Материал сақталмады');
  toast('Материал жеке кабинетке сақталды');
}
async function downloadWord() {
  if (!currentResult) return toast('Алдымен материал дайындаңыз');
  if (!window.JSZip) return toast('Word модулі жүктелмеді');
  const paragraphs = currentResult.split(/\n/).map(line => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line || ' ')}</w:t></w:r></w:p>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="32"/></w:rPr><w:t>${xmlEscape(currentTitle)}</w:t></w:r></w:p>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${currentTitle.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70)}.docx`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#useSavedCode').addEventListener('click', () => { $('#toolAccessCode').value = localStorage.getItem(ACCESS_KEY) || ''; toast($('#toolAccessCode').value ? 'Сақталған код қойылды' : 'Сақталған код табылмады'); });
$('#textToolForm').addEventListener('submit', generate);
$('#copyToolResult').addEventListener('click', async () => { if (!currentResult) return toast('Нәтиже жоқ'); await navigator.clipboard.writeText(currentResult); toast('Мәтін көшірілді'); });
$('#saveToolResult').addEventListener('click', () => saveToCabinet().catch(error => toast(error.message)));
$('#downloadToolWord').addEventListener('click', downloadWord);
$('#toolAccessCode').value = localStorage.getItem(ACCESS_KEY) || '';
setMode(activeMode); loadOptions().catch(() => { $('#toolError').textContent = 'Пәндер тізімі жүктелмеді'; });
