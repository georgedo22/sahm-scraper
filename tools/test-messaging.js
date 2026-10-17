/* ------------------------------------------------------------------
 * صهم — tools/test-messaging.js
 * اختبارات طبقة الرسائل بين اللوحة والخلفية وسكربت المحتوى.
 * الحادثة التي وُلدت منها هذه الاختبارات: كان sendToTab يرسل رسالة بلا
 * from:'sw'، وسكربت المحتوى يرفض أي رسالة بلا هذا الحقل — فتفشل كل
 * الأوامر على كل الصفحات بصمت، وتظهر للمستخدم رسالة «تعذّر بدء الالتقاط».
 * التشغيل:  node tools/test-messaging.js
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const log = [];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    log.push('PASS  ' + name);
  } catch (error) {
    failures++;
    log.push('FAIL  ' + name + '\n        → ' + error.message);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    log.push('PASS  ' + name);
  } catch (error) {
    failures++;
    log.push('FAIL  ' + name + '\n        → ' + error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'شرط غير محقَّق');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'قيمة غير متوقّعة') + ' — متوقّع: ' + JSON.stringify(expected) + ' / فعلي: ' + JSON.stringify(actual));
  }
}

/** يجرّد التعليقات حتى لا يُحسب كود معلَّق عليه كأنه نافذ.
 *  نحمي "//" الواقعة داخل الروابط (https://) بالمطابقة على ما قبلها. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const backgroundSrc = stripComments(read('src/background.js'));
const contentSrc = stripComments(read('src/content/content.js'));
const panelSrc = stripComments(read('src/ui/panel.js'));

// ------------------------------------------------------------------
// 1) المغلف: sendToTab يجب أن يضع from:'sw' (وإلا يرفضه سكربت المحتوى)
// ------------------------------------------------------------------
check('sendToTab يضع from:\'sw\' في كل رسالة موجّهة إلى تبويب', () => {
  const match = backgroundSrc.match(/function sendToTab[\s\S]*?\n\}/);
  assert(match, 'لم أجد دالة sendToTab في background.js');
  assert(/from:\s*'sw'/.test(match[0]), 'sendToTab لا يضع from:\'sw\' — سكربت المحتوى سيتجاهل كل رسالة');
});

check('كل رسائل الخلفية إلى التبويب تحمل حقل type', () => {
  const types = [];
  const re = /\{\s*type:\s*'([A-Z_]+)',\s*payload:/g;
  let m;
  while ((m = re.exec(backgroundSrc))) types.push(m[1]);
  assert(types.length >= 8, 'عدد رسائل التبويب المكتشفة أقل من المتوقّع: ' + types.length);
  assert(types.indexOf('PING') !== -1, 'لا توجد رسالة PING');
  assert(types.indexOf('EXTRACT') !== -1, 'لا توجد رسالة EXTRACT');
});

// ------------------------------------------------------------------
// 2) تطابق الأنواع: ما ترسله الخلفية موجود في سكربت المحتوى، والعكس
// ------------------------------------------------------------------
function sentTypes(src) {
  const set = new Set();
  const re = /\{\s*type:\s*'([A-Z_]+)',\s*payload:/g;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}

function contentHandlerTypes(src) {
  const set = new Set();
  const re = /^\s{4}([A-Z_]+):\s*async function/gm;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}

check('كل رسالة ترسلها الخلفية لها مُعالِج في سكربت المحتوى', () => {
  const handled = contentHandlerTypes(contentSrc);
  const missing = [];
  for (const type of sentTypes(backgroundSrc)) {
    if (!handled.has(type)) missing.push(type);
  }
  assertEqual(missing.join(','), '', 'أنواع بلا مُعالِج في content.js');
});

check('كل رسالة ترسلها اللوحة لها مُعالِج في الخلفية', () => {
  const handled = new Set();
  const re = /^\s{2}'([^']+)':\s*async/gm;
  let m;
  while ((m = re.exec(backgroundSrc))) handled.add(m[1]);
  const sent = new Set();
  const re2 = /send\('([^']+)'/g;
  let m2;
  while ((m2 = re2.exec(panelSrc))) sent.add(m2[1]);
  const missing = [];
  for (const type of sent) {
    if (!handled.has(type)) missing.push(type);
  }
  assertEqual(missing.join(','), '', 'أنواع ترسلها اللوحة بلا مُعالِج في background.js');
});

// ------------------------------------------------------------------
// 3) تشغيل فعلي لسكربتات المحتوى في jsdom والتحاور معها
// ------------------------------------------------------------------
const PAGE = `<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"></head><body>
  <ul id="movies">
    <li class="movie"><a class="poster" href="/f/1"><img src="/img/1.jpg"></a>
      <div class="meta"><h3 class="title">فيلم أول</h3><span class="year">2021</span></div></li>
    <li class="movie"><a class="poster" href="/f/2"><img src="/img/2.jpg"></a>
      <div class="meta"><h3 class="title">فيلم ثانٍ</h3><span class="year">2022</span></div></li>
    <li class="movie"><a class="poster" href="/f/3"><img src="/img/3.jpg"></a>
      <div class="meta"><h3 class="title">فيلم ثالث</h3><span class="year">2023</span></div></li>
  </ul>
  <button class="next-page">التالي</button>
</body></html>`;

const CONTENT_FILES = [
  'src/lib/selector.js',
  'src/lib/extract.js',
  'src/content/popups.js',
  'src/content/picker.js',
  'src/content/paginator.js',
  'src/content/content.js'
];

function bootContentWorld() {
  const dom = new JSDOM(PAGE, { url: 'https://example.com/movies?page=1', runScripts: 'outside-only' });
  const win = dom.window;
  const captured = { listener: null, sent: [] };

  // jsdom لا يحسب التخطيط فتُرجع كل الأبعاد صفراً، وهذا يجعل كشف
  // «العنصر المرئي» في paginator يفشل دائماً. نُحاكي أبعاداً حقيقية.
  win.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
  };
  win.scrollTo = () => {};

  // بديل chrome: يكفي لتحميل السكربتات وتسجيل مستمع الرسائل
  win.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: (fn) => {
          captured.listener = fn;
        }
      },
      sendMessage: (message, callback) => {
        captured.sent.push(message);
        if (typeof callback === 'function') callback({ ok: true });
      }
    }
  };

  for (const file of CONTENT_FILES) win.eval(read(file));
  return { dom: dom, win: win, captured: captured };
}

function dispatch(captured, message) {
  return new Promise((resolve) => {
    const returned = captured.listener(message, { tab: { id: 1 } }, (response) => resolve(response));
    if (returned !== true) resolve(null);
  });
}

const world = bootContentWorld();

check('سكربتات المحتوى تُحمَّل كاملة وتُسجّل مستمع الرسائل', () => {
  const SC = world.win.SCX;
  assert(SC, 'SCX غير معرَّف');
  assert(SC.sel && SC.ex && SC.popups && SC.picker && SC.paginator, 'وحدة ناقصة: ' + Object.keys(SC).join(','));
  assertEqual(SC.contentReady, true, 'content.js لم يُكمل التحميل');
  assert(typeof world.captured.listener === 'function', 'لم يُسجَّل مستمع onMessage');
});

check('رسالة بلا from:\'sw\' تُتجاهل (هذا سبب الحادثة الأصلية)', () => {
  const returned = world.captured.listener({ type: 'PING', payload: {} }, {}, () => {});
  assertEqual(returned, false, 'يجب تجاهل الرسائل التي لا تحمل المفتاح from');
});

const JOB = {
  id: 'job_test',
  parentSelector: '#movies',
  itemSignature: { tag: 'li', classes: ['movie'] },
  fields: [
    { name: 'title', type: 'text', selector: 'div.meta > h3.title' },
    { name: 'year', type: 'text', selector: 'div.meta > span.year' },
    { name: 'poster', type: 'image', selector: 'a.poster > img' }
  ],
  pagination: { selector: 'button.next-page' },
  options: { blockAds: false, killPopups: false, clickClose: false, autoScroll: false, waitMs: 2000, delayMs: 0 }
};

(async function run() {
  await checkAsync('PING يستجيب ويُعيد رابط الصفحة', async () => {
    const res = await dispatch(world.captured, { from: 'sw', type: 'PING', payload: {} });
    assert(res, 'لا استجابة');
    assertEqual(res.ok, true, 'ok');
    assert(res.url.indexOf('example.com') !== -1, 'الرابط غير متوقّع: ' + res.url);
  });

  await checkAsync('OPTIONS يُطبَّق بلا خطأ', async () => {
    const res = await dispatch(world.captured, {
      from: 'sw',
      type: 'OPTIONS',
      payload: { options: { blockAds: false, killPopups: false, clickClose: false } }
    });
    assertEqual(res && res.ok, true, 'ok');
  });

  await checkAsync('EXTRACT يستخرج صفوف الصفحة فعلياً', async () => {
    const res = await dispatch(world.captured, { from: 'sw', type: 'EXTRACT', payload: { job: JOB } });
    assert(res, 'لا استجابة');
    assertEqual(res.ok, true, 'ok — خطأ: ' + (res && res.error));
    assertEqual(res.itemCount, 3, 'عدد العناصر');
    assertEqual(res.rows.length, 3, 'عدد الصفوف');
    assertEqual(res.rows[0].title, 'فيلم أول', 'العنوان الأول');
    assertEqual(res.rows[2].year, '2023', 'سنة الصف الثالث');
    assertEqual(res.rows[1].poster, 'https://example.com/img/2.jpg', 'غلاف الصف الثاني');
    assert(res.pagination && res.pagination.hasNext === true, 'يجب كشف زر «التالي»');
  });

  await checkAsync('CLICK_NEXT يستجيب بلا خطأ', async () => {
    const res = await dispatch(world.captured, { from: 'sw', type: 'CLICK_NEXT', payload: { job: JOB } });
    assert(res, 'لا استجابة');
    assertEqual(res.ok, true, 'ok — الاستجابة: ' + JSON.stringify(res));
  });

  await checkAsync('HILITE يستجيب', async () => {
    const res = await dispatch(world.captured, { from: 'sw', type: 'HILITE', payload: { selector: '#movies' } });
    assert(res && typeof res.ok === 'boolean', 'استجابة غير صالحة');
  });

  await checkAsync('PICK_START و PICK_STOP يعملان', async () => {
    const started = await dispatch(world.captured, { from: 'sw', type: 'PICK_START', payload: { mode: 'field', job: JOB } });
    assertEqual(started && started.ok, true, 'بدء الالتقاط');
    assertEqual(world.win.SCX.picker.isActive(), true, 'الالتقاط يجب أن يكون نشطاً');
    const stopped = await dispatch(world.captured, { from: 'sw', type: 'PICK_STOP', payload: {} });
    assertEqual(stopped && stopped.ok, true, 'إيقاف الالتقاط');
    assertEqual(world.win.SCX.picker.isActive(), false, 'الالتقاط يجب أن يتوقف');
  });

  await checkAsync('SCROLL_LOAD يعمل بلا خطأ', async () => {
    const res = await dispatch(world.captured, { from: 'sw', type: 'SCROLL_LOAD', payload: { steps: 2 } });
    assertEqual(res && res.ok, true, 'ok');
  });

  await checkAsync('RUN_STATUS يعمل بلا خطأ', async () => {
    const res = await dispatch(world.captured, { from: 'sw', type: 'RUN_STATUS', payload: { running: true, text: 'اختبار' } });
    assertEqual(res && res.ok, true, 'ok');
    await dispatch(world.captured, { from: 'sw', type: 'RUN_STATUS', payload: { running: false } });
  });

  console.log(log.join('\n'));
  if (failures) {
    console.log('\nفشل ' + failures + ' اختبار/اختبارات');
    process.exit(1);
  }
  console.log('\nكل اختبارات الرسائل نجحت (' + log.length + ')');
  process.exit(0);
})();
