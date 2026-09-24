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
    track: $('#track').value,
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
    const formValues = payload();
    const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessCode}`, 'X-Device-Id': deviceId }, body: JSON.stringify(formValues) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ҚМЖ жасалмады');
    current = { html: data.html, text: data.text, referenceDocx: data.referenceDocx || '', fields: formValues };
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
  const objectUrl = URL.createObjectURL(await response.blob());
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

function setDocxCellText(xml, cell, value) {
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  let texts = [...cell.getElementsByTagNameNS(namespace, 't')];
  if (!texts.length) {
    let paragraph = cell.getElementsByTagNameNS(namespace, 'p')[0];
    if (!paragraph) {
      paragraph = xml.createElementNS(namespace, 'w:p');
      cell.appendChild(paragraph);
    }
    let run = paragraph.getElementsByTagNameNS(namespace, 'r')[0];
    if (!run) {
      run = xml.createElementNS(namespace, 'w:r');
      paragraph.appendChild(run);
    }
    const text = xml.createElementNS(namespace, 'w:t');
    run.appendChild(text);
    texts = [text];
  }
  texts[0].textContent = value;
  texts.slice(1).forEach(text => { text.textContent = ''; });
}

function updateReferenceDocumentXml(source, fields) {
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const xml = new DOMParser().parseFromString(source, 'application/xml');
  const teacherValue = String(fields.teacher || '').trim() || '____________________________';
  const rows = [...xml.getElementsByTagNameNS(namespace, 'tr')];
  for (const row of rows) {
    const cells = [...row.children].filter(item => item.localName === 'tc');
    if (!cells.length) continue;
    const cellText = cell => [...cell.getElementsByTagNameNS(namespace, 't')].map(item => item.textContent || '').join('');
    const label = cellText(cells[0]).replace(/\s+/g, ' ').trim();
    if (/Педагогтің.*аты-жөні/i.test(label) && cells[1]) setDocxCellText(xml, cells[cells.length - 1], teacherValue);
    else if (/^Күні/i.test(label) && fields.date && cells[1]) setDocxCellText(xml, cells[cells.length - 1], fields.date);
    else if (/^Сынып/i.test(label)) {
      setDocxCellText(xml, cells[0], `Сынып: ${fields.grade || ''}`);
      if (cells[1]) setDocxCellText(xml, cells[cells.length - 1], `Қатысқандар саны: ${fields.present || '____'}    Қатыспағандар саны: ${fields.absent || '____'}`);
    }
    else if (/^Сабақ барысы/i.test(label)) setDocxCellText(xml, cells[0], 'Сабақ барысы: 45 минут');
  }
  for (const text of xml.getElementsByTagNameNS(namespace, 't')) {
    if (/Умбетова\s+Меруерт\s+Мирзамидиновна/i.test(text.textContent || '')) {
      text.textContent = (text.textContent || '').replace(/Умбетова\s+Меруерт\s+Мирзамидиновна/gi, teacherValue);
    }
  }
  return new XMLSerializer().serializeToString(xml);
}

async function downloadReferenceWord(topic) {
  const response = await fetch(current.referenceDocx, { headers: { Authorization: `Bearer ${accessCode}`, 'X-Device-Id': deviceId } });
  if (!response.ok) throw new Error('Бастапқы ҚМЖ файлы жүктелмеді');
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('Word құжатының құрылымы оқылмады');
  const xml = await documentFile.async('string');
  zip.file('word/document.xml', updateReferenceDocumentXml(xml, current.fields || {}));
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ҚМЖ-${topic.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70)}.docx`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function wordRun(text, options = {}) {
  const properties = `${options.bold ? '<w:b/>' : ''}<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="${options.size || 20}"/><w:szCs w:val="${options.size || 20}"/>`;
  return `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function inlineWordRuns(node, options = {}) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ? wordRun(node.textContent, options) : '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (node.tagName === 'BR') return '<w:r><w:br/></w:r>';
  const next = { ...options, bold: options.bold || ['STRONG', 'B'].includes(node.tagName) };
  return [...node.childNodes].map(child => inlineWordRuns(child, next)).join('');
}

function wordParagraph(content, options = {}) {
  const runs = typeof content === 'string' ? wordRun(content, options) : inlineWordRuns(content, options);
  const align = options.align ? `<w:jc w:val="${options.align}"/>` : '';
  const spacing = `<w:spacing w:before="${options.before || 0}" w:after="${options.after ?? 20}" w:line="${options.line || 220}" w:lineRule="auto"/>`;
  return `<w:p><w:pPr>${align}${spacing}</w:pPr>${runs || wordRun(' ', options)}</w:p>`;
}

function imageDrawing(asset, relationshipId, drawingId) {
  const maxWidth = 1965960;
  const maxHeight = 2011680;
  const scale = Math.min(maxWidth / asset.width, maxHeight / asset.height);
  const cx = Math.max(1, Math.round(asset.width * scale));
  const cy = Math.max(1, Math.round(asset.height * scale));
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="20" w:after="20"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="ҚМЖ суреті ${drawingId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="image${drawingId}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function collectWordImages(wrapper) {
  const assets = new Map();
  const images = [...wrapper.querySelectorAll('img[src^="/visuals/"], img[src^="/textbook-excerpts/"]')];
  await Promise.all(images.map(async (img, index) => {
    try {
      const response = await fetch(img.getAttribute('src'));
      if (!response.ok) return;
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const source = new Image();
        await new Promise((resolve, reject) => {
          source.onload = resolve;
          source.onerror = reject;
          source.src = objectUrl;
        });
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = Math.max(240, Math.round(1200 * (source.naturalHeight || 520) / (source.naturalWidth || 900)));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        assets.set(img, { base64: canvas.toDataURL('image/png').split(',')[1], width: canvas.width, height: canvas.height, relationshipId: `rIdImage${index + 1}`, fileName: `image${index + 1}.png`, drawingId: index + 1 });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch { /* Сурет болмаса, қалған ҚМЖ Word-қа сақталады. */ }
  }));
  return assets;
}

function elementBlocks(element, context) {
  if (element.nodeType === Node.TEXT_NODE) {
    const text = element.textContent.trim();
    return text ? wordParagraph(text, { size: context.size }) : '';
  }
  if (element.nodeType !== Node.ELEMENT_NODE) return '';
  if (element.tagName === 'P') return wordParagraph(element, { size: context.size, after: 20 });
  if (element.tagName === 'UL' || element.tagName === 'OL') {
    return [...element.children].map((item, index) => wordParagraph(`${element.tagName === 'OL' ? `${index + 1}.` : '•'} ${item.textContent.trim()}`, { size: context.size, after: 0 })).join('');
  }
  if (element.tagName === 'FIGURE') {
    const image = element.querySelector(':scope > img');
    const caption = element.querySelector(':scope > figcaption');
    const asset = image ? context.assets.get(image) : null;
    return `${asset ? imageDrawing(asset, asset.relationshipId, asset.drawingId) : ''}${caption?.textContent.trim() ? wordParagraph(caption.textContent.trim(), { size: 18, align: 'center', after: 20 }) : ''}`;
  }
  if (element.tagName === 'TABLE') return wordTable(element, context);
  if (element.tagName === 'BR') return wordParagraph(' ', { size: context.size, after: 0 });
  return [...element.childNodes].map(child => elementBlocks(child, context)).join('');
}

function wordTable(table, context) {
  const isFlow = table.classList.contains('flow-table');
  const isMeta = table.classList.contains('meta-table');
  const isBbu = table.classList.contains('bbu-table');
  const columnCount = table.rows[0]?.cells.length || 1;
  const widths = isFlow ? [933, 3467, 3743, 1251, 1208] : isMeta ? [3011, 7591] : isBbu ? [1200, 1200, 1200] : Array.from({ length: columnCount }, () => Math.floor(10602 / columnCount));
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const grid = widths.map(width => `<w:gridCol w:w="${width}"/>`).join('');
  const rows = [...table.rows].map((row, rowIndex) => {
    const header = row.parentElement?.tagName === 'THEAD' || [...row.cells].every(cell => cell.tagName === 'TH');
    const cells = [...row.cells].map((cell, cellIndex) => {
      const width = widths[cellIndex] || widths[widths.length - 1];
      let contents = [...cell.childNodes].map(child => elementBlocks(child, { ...context, size: isFlow || isBbu ? 20 : 24 })).join('');
      if (!contents) contents = wordParagraph(' ', { size: isFlow || isBbu ? 20 : 24 });
      if (!contents.endsWith('</w:p>')) contents += '<w:p/>';
      const align = header && (isFlow || isBbu) ? '<w:jc w:val="center"/>' : '';
      const boldFallback = header && !cell.children.length ? wordParagraph(cell.textContent.trim(), { size: isFlow || isBbu ? 20 : 24, bold: true, align: isFlow || isBbu ? 'center' : undefined }) : '';
      if (boldFallback) contents = boldFallback;
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="top"/>${align}<w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="55" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="55" w:type="dxa"/></w:tcMar></w:tcPr>${contents}</w:tc>`;
    }).join('');
    return `<w:tr><w:trPr>${header ? '<w:tblHeader/>' : ''}</w:trPr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="6" w:color="000000"/><w:left w:val="single" w:sz="6" w:color="000000"/><w:bottom w:val="single" w:sz="6" w:color="000000"/><w:right w:val="single" w:sz="6" w:color="000000"/><w:insideH w:val="single" w:sz="6" w:color="000000"/><w:insideV w:val="single" w:sz="6" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

async function buildGeneratedDocx(wrapper) {
  const assets = await collectWordImages(wrapper);
  const title = wrapper.querySelector(':scope > h2');
  const legal = wrapper.querySelector(':scope > .legal-note');
  const meta = wrapper.querySelector(':scope > .meta-table');
  const heading = wrapper.querySelector(':scope > .flow-heading');
  const flow = wrapper.querySelector(':scope > .flow-table');
  const context = { assets, size: 20 };
  const body = `${title ? wordParagraph(title, { size: 24, bold: true, align: 'center', after: 20 }) : ''}${legal ? wordParagraph(legal, { size: 18, align: 'center', after: 40 }) : ''}${meta ? wordTable(meta, context) : ''}${heading ? wordParagraph(heading, { size: 22, bold: true, align: 'center', before: 40, after: 20 }) : ''}${flow ? wordTable(flow, context) : ''}`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="425" w:right="652" w:bottom="425" w:left="652" w:header="0" w:footer="0" w:gutter="0"/><w:cols w:space="0"/><w:docGrid w:linePitch="240"/></w:sectPr></w:body></w:document>`;
  const imageRelationships = [...assets.values()].map(asset => `<Relationship Id="${asset.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${asset.fileName}"/>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="20" w:line="220" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${imageRelationships}</Relationships>`);
  for (const asset of assets.values()) zip.file(`word/media/${asset.fileName}`, asset.base64, { base64: true });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}

async function downloadWord() {
  if (!current.html) return;
  const topic = $('#topic').value.trim() || 'QMJ';
  if (current.referenceDocx && window.JSZip) {
    try {
      await downloadReferenceWord(topic);
      return;
    } catch (error) {
      toast(error.message);
    }
  }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = current.html;
  if (!window.JSZip) throw new Error('Word модулі жүктелмеді. Бетті жаңартып көріңіз');
  const blob = await buildGeneratedDocx(wrapper);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ҚМЖ-${topic.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70)}.docx`;
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
