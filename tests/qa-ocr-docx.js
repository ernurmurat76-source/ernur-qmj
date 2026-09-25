'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
global.JSZip = require('../public/vendor/jszip.min.js');

function text(value) { return { nodeType: Node.TEXT_NODE, textContent: String(value || '') }; }
function element(tagName, value = '') {
  return { nodeType: Node.ELEMENT_NODE, tagName, textContent: String(value || ''), childNodes: value ? [text(value)] : [], children: [], classList: { contains: () => false }, querySelector: () => null };
}
function figure(captionValue) {
  const image = element('IMG');
  const caption = element('FIGCAPTION', captionValue);
  const value = element('FIGURE');
  value.childNodes = [image, caption]; value.children = [image, caption];
  value.querySelector = selector => selector === ':scope > img' ? image : selector === ':scope > figcaption' ? caption : null;
  return value;
}
function table(className, rows) {
  const value = element('TABLE');
  value.classList = { contains: name => name === className };
  value.rows = rows.map((values, rowIndex) => ({
    parentElement: { tagName: rowIndex === 0 ? 'THEAD' : 'TBODY' },
    cells: values.map(item => {
      const cell = element(rowIndex === 0 ? 'TH' : 'TD', typeof item === 'string' ? item : '');
      if (Array.isArray(item)) { cell.childNodes = item; cell.children = item; cell.textContent = item.map(node => node.textContent || '').join(' '); }
      return cell;
    })
  }));
  return value;
}

(async () => {
  const root = path.join(__dirname, '..');
  const database = JSON.parse(fs.readFileSync(path.join(root, 'data/qmj-reference-index.json'), 'utf8'));
  const record = database.records.find(item => item.prepared_plan?.textbookExercise?.mode === 'exact-scanned-ocr');
  if (!record) throw new Error('OCR QMJ record not found');
  const plan = record.prepared_plan;
  const middle = plan.stages.find(stage => stage.name === 'Сабақтың ортасы');
  const visual = plan.visuals[0];
  const imagePath = path.join(root, 'public', visual.src.replace(/^\//, ''));

  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  vm.runInThisContext(source.slice(source.indexOf('function xmlEscape'), source.indexOf('async function downloadWord()')), { filename: 'docx-builder.js' });

  const fig = figure(visual.caption);
  const task = middle.tasks[0];
  const taskNode = element('P', `1-тапсырма. ${task.instruction}`);
  const descriptorNode = element('P', `Дескриптор — ${task.points} балл: ${task.descriptor}.`);
  const valuesNode = element('P', `Құндылықтар: ${task.values || 'Еңбекқорлық және жауапкершілік — есепті ретімен орындап, нәтижесін тексереді.'}`);
  const rows = [
    ['Уақыты кезеңдері', 'Педагогтің әрекеті', 'Оқушының әрекеті', 'Бағалау', 'Ресурстар'],
    ['Ұйымдастыру кезеңі 5 минут', plan.stages[0].teacherActions.join(' '), plan.stages[0].learnerActions.join(' '), plan.stages[0].feedback, plan.stages[0].resources.join(', ')],
    ['Сабақтың басы 10 минут', plan.stages[1].teacherActions.join(' '), plan.stages[1].learnerActions.join(' '), plan.stages[1].feedback, plan.stages[1].resources.join(', ')],
    ['Сабақтың ортасы 25 минут', [fig, taskNode, descriptorNode, valuesNode], middle.learnerActions.join(' '), middle.feedback, middle.resources.join(', ')],
    ['Сабақтың соңы 5 минут', plan.stages[3].teacherActions.join(' '), plan.stages[3].learnerActions.join(' '), plan.stages[3].feedback, plan.stages[3].resources.join(', ')]
  ];
  const nodes = {
    ':scope > h2': element('H2', 'Қысқа мерзімді сабақ жоспары'),
    ':scope > .legal-note': element('P', '№130 бұйрық нысаны'),
    ':scope > .meta-table': table('meta-table', [['Сабақтың тақырыбы', record.topic], ['Сынып', String(record.grade)]]),
    ':scope > .flow-heading': element('P', 'Сабақ барысы: 45 минут'),
    ':scope > .flow-table': table('flow-table', rows)
  };
  const documentRoot = { matches: selector => selector === '.qmj-document', querySelector: selector => nodes[selector] || null, querySelectorAll: () => [] };
  const asset = { base64: fs.readFileSync(imagePath).toString('base64'), width: 1100, height: 620, relationshipId: 'rIdImage1', fileName: 'image1.jpg', drawingId: 1 };
  collectWordImages = async () => new Map([[fig.children[0], asset]]);
  const blob = await buildGeneratedDocx(documentRoot);
  const output = process.argv[2] || path.join(root, 'qa-v27-ocr.docx');
  fs.writeFileSync(output, Buffer.from(await blob.arrayBuffer()));
  console.log(output);
})().catch(error => { console.error(error); process.exit(1); });
