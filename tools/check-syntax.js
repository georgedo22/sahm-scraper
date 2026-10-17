/* ------------------------------------------------------------------
 * أداة تطوير: فحص صياغة كل ملفات JS + صحة manifest.json
 *   node tools/check-syntax.js
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const files = [
  'src/background.js',
  'src/lib/selector.js',
  'src/lib/extract.js',
  'src/content/content.js',
  'src/content/picker.js',
  'src/content/paginator.js',
  'src/content/popups.js',
  'src/content/popup-guard.js',
  'src/ui/panel.js'
];

let failed = 0;

for (const rel of files) {
  const file = path.join(root, rel);
  try {
    const code = fs.readFileSync(file, 'utf8');
    new vm.Script(code, { filename: rel });
    console.log('OK   ' + rel);
  } catch (error) {
    failed++;
    console.error('FAIL ' + rel + ' → ' + error.message);
  }
}

// manifest
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  console.log('OK   manifest.json (v' + manifest.manifest_version + ', ' + manifest.name + ')');

  const referenced = []
    .concat(manifest.content_scripts[0].js)
    .concat([manifest.background.service_worker])
    .concat(Object.values(manifest.icons))
    .concat([manifest.side_panel.default_path])
    .concat(manifest.declarative_net_request.rule_resources.map((r) => r.path));

  for (const rel of referenced) {
    if (!fs.existsSync(path.join(root, rel))) {
      failed++;
      console.error('FAIL ملف مُشار إليه غير موجود: ' + rel);
    }
  }
  if (!failed) console.log('OK   كل الملفات المُشار إليها في manifest موجودة');
} catch (error) {
  failed++;
  console.error('FAIL manifest.json → ' + error.message);
}

// قواعد DNR
try {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules/ads.json'), 'utf8'));
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error('معرّف قاعدة مكرّر: ' + rule.id);
    ids.add(rule.id);
    if (!rule.action || !rule.condition || !rule.condition.urlFilter) {
      throw new Error('قاعدة غير مكتملة: ' + rule.id);
    }
  }
  console.log('OK   rules/ads.json (' + rules.length + ' قاعدة)');
} catch (error) {
  failed++;
  console.error('FAIL rules/ads.json → ' + error.message);
}

console.log(failed ? '\nفشل: ' + failed : '\nكل الفحوص نجحت.');
process.exit(failed ? 1 : 0);
