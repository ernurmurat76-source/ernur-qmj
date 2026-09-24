'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
global.JSZip = require('../public/vendor/jszip.min.js');

function text(value) {
  return { nodeType: Node.TEXT_NODE, textContent: value };
}

function element(tagName, value = '') {
  return {
    nodeType: Node.ELEMENT_NODE,
    tagName,
    textContent: value,
    childNodes: value ? [text(value)] : [],
    children: [],
    classList: { contains: () => false },
    querySelector: () => null
  };
}

function table(className, rows) {
  const value = element('TABLE');
  value.classList = { contains: name => name === className };
  value.rows = rows.map((values, rowIndex) => ({
    parentElement: { tagName: rowIndex === 0 ? 'THEAD' : 'TBODY' },
    cells: values.map(item => {
      const cell = element(rowIndex === 0 ? 'TH' : 'TD', item);
      cell.children = [];
      return cell;
    })
  }));
  return value;
}

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('function xmlEscape');
  const end = source.indexOf('async function downloadWord()');
  assert.ok(start >= 0 && end > start);
  vm.runInThisContext(source.slice(start, end), { filename: 'docx-builder.js' });

  const nodes = {
    ':scope > h2': element('H2', 'Қысқа мерзімді сабақ жоспары'),
    ':scope > .legal-note': element('P', '№130 бұйрық нысаны'),
    ':scope > .meta-table': table('meta-table', [['Бөлім', 'Жай бөлшектер'], ['Сабақтың тақырыбы', 'Бөлшектерді салыстыру']]),
    ':scope > .flow-heading': element('P', 'Сабақ барысы: 45 минут'),
    ':scope > .flow-table': table('flow-table', [
      ['Уақыты кезеңдері', 'Педагогтің әрекеті', 'Оқушының әрекеті', 'Бағалау', 'Ресурстар'],
      ['Сабақтың ортасы 25 минут', 'Оқулық есебін жазбаша орында', 'Толық шешу жолын жазады', 'Дескриптор бойынша', 'Оқулық']
    ])
  };
  const documentRoot = {
    matches: selector => selector === '.qmj-document',
    querySelector: selector => nodes[selector] || null,
    querySelectorAll: () => []
  };
  const wrapper = {
    matches: () => false,
    querySelector: selector => selector === '.qmj-document' ? documentRoot : null
  };

  const blob = await buildGeneratedDocx(wrapper);
  const buffer = Buffer.from(await blob.arrayBuffer());
  assert.ok(buffer.length > 2000);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Қысқа мерзімді сабақ жоспары/);
  assert.match(xml, /Оқулық есебін жазбаша орында/);
  assert.match(xml, /<w:gridCol w:w="933"\/>/);
  assert.match(xml, /<w:gridCol w:w="3467"\/>/);
  assert.match(xml, /<w:gridCol w:w="3743"\/>/);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], buffer);
  console.log('Generated DOCX contains QMJ text and fixed five-column grid: OK');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
