/* ------------------------------------------------------------------
 * صهم — tools/test-panel.js
 * اختبارات اللوحة الجانبية: يُحمِّل panel.html الحقيقي ويشغّل panel.js
 * في jsdom مع خلفية وهمية، ثم يحاكي مسار المستخدم:
 *   فتح اللوحة → التقاط حقلين → تصبح أزرار التشغيل مفعّلة → بدء السحب.
 * الحادثة التي وُلدت منها: زر «بدء السحب» بقي معطّلاً بعد الالتقاط لأن
 * renderRun() لم تكن تُنادى في مسار تعديل الحقول.
 * التشغيل:  node tools/test-panel.js
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const log = [];
let failures = 0;

async function check(name, fn) {
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
    throw new Error(
      (message || 'قيمة غير متوقّعة') + ' — متوقّع: ' + JSON.stringify(expected) + ' / فعلي: ' + JSON.stringify(actual)
    );
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LEARNED = {
  parentSelector: '#movies',
  itemSignature: { tag: 'li', classes: ['movie'] },
  itemSelector: '#movies > li.movie',
  itemCount: 3,
  rowCount: 3,
  fields: [
    { name: 'title', type: 'text', selector: 'div.meta > h3.title', path: '#movies > li.movie > div.meta > h3.title', missing: 0 },
    { name: 'year', type: 'text', selector: 'div.meta > span.year', path: '#movies > li.movie > div.meta > span.year', missing: 0 }
  ],
  preview: [
    { title: 'فيلم أول', year: '2021' },
    { title: 'فيلم ثانٍ', year: '2022' }
  ]
};

/** خلفية وهمية: تُعيد ردوداً صالحة لكل نوع رسالة تستخدمه اللوحة. */
function fakeBackground(calls) {
  return {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: (fn) => {
          calls.listener = fn;
        }
      },
      sendMessage: (message, callback) => {
        calls.sent.push(message.type);
        const respond = (payload) => {
          if (typeof callback === 'function') callback(payload);
        };
        switch (message.type) {
          case 'panel:getState':
            respond({ ok: true, jobs: [], currentJobId: null, options: {}, run: null, log: [] });
            break;
          case 'panel:rowCount':
            respond({ ok: true, total: 0 });
            break;
          case 'panel:readRows':
            respond({ ok: true, rows: [] });
            break;
          case 'panel:engage':
          case 'panel:options':
          case 'panel:saveJob':
          case 'panel:clearRows':
            respond({ ok: true });
            break;
          case 'panel:startRun':
            calls.startRun = message.payload;
            respond({ ok: true });
            break;
          case 'panel:pick':
            calls.pick = message.payload;
            respond({ ok: true });
            break;
          case 'panel:gotoFirstItem':
            calls.goto = message.payload;
            respond({ ok: true, href: 'https://example.com/f/1', total: 3 });
            break;
          default:
            respond({ ok: true });
        }
      }
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://example.com/movies', title: 'أفلام' }],
      onActivated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    }
  };
}

async function bootPanel() {
  const html = read('src/ui/panel.html');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html', runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { sent: [], listener: null, startRun: null, pick: null, goto: null };

  win.chrome = fakeBackground(calls);
  // اللوحة تستخدم تنزيل الملفات والنسخ؛ نُبدّلها بدوال صامتة
  win.URL.createObjectURL = () => 'blob:test';
  win.URL.revokeObjectURL = () => {};
  if (win.navigator.clipboard) win.navigator.clipboard.writeText = async () => {};

  win.eval(read('src/ui/panel.js'));
  await sleep(30); // ننتظر انتهاء init() غير المتزامنة
  return { win: win, calls: calls, $: (id) => win.document.getElementById(id) };
}

function pickResult(payload) {
  return { from: 'sw', type: 'pick:result', payload: payload };
}

(async function run() {
  const panel = await bootPanel();
  const $ = panel.$;

  await check('اللوحة تُحمَّل وتُسجّل مستمع الخلفية', () => {
    assert($('runBtn'), 'زر بدء السحب غير موجود');
    assert(typeof panel.calls.listener === 'function', 'لم تُسجَّل مستمع الرسائل');
    assert(panel.calls.sent.indexOf('panel:getState') !== -1, 'اللوحة لم تطلب الحالة الابتدائية');
  });

  await check('قبل الالتقاط: زر «بدء السحب» معطّل (لا حقول)', () => {
    assertEqual($('runBtn').disabled, true, 'حالة الزر');
    assertEqual($('probeBtn').disabled, true, 'حالة زر الاختبار');
  });

  await check('بعد التقاط الحقلين: أزرار التشغيل تُفعَّل تلقائياً', () => {
    // نحاكي ما ترسله الخلفية فعلاً عند انتهاء الالتقاط
    panel.calls.listener(pickResult({ mode: 'field', learned: LEARNED }));
    assertEqual($('runBtn').disabled, false, 'زر بدء السحب بقي معطّلاً بعد الالتقاط');
    assertEqual($('probeBtn').disabled, false, 'زر الاختبار بقي معطّلاً بعد الالتقاط');
  });

  await check('الحقول الملتقطة تُعرض في اللوحة', () => {
    const names = Array.from($('fieldsList').querySelectorAll('.f-name')).map((el) => el.value);
    assertEqual(names.join(','), 'title,year', 'أسماء الحقول المعروضة');
    assertEqual($('learnedSelector').textContent, '#movies > li.movie', 'محدد الصف');
    assertEqual($('learnedCount').textContent, '3 صف متشابه', 'عدد الصفوف');
  });

  await check('حذف حقل يُعيد تعطيل الزر (الاكتمال شرط)', () => {
    // الحذف يمرّ من نفس مسار إعادة الرسم، فالزر يجب أن يتبع الحالة
    const del = $('fieldsList').querySelector('.f-del');
    del.dispatchEvent(new panel.win.MouseEvent('click', { bubbles: true }));
    const names = Array.from($('fieldsList').querySelectorAll('.f-name')).map((el) => el.value);
    assertEqual(names.join(','), 'year', 'الباقي بعد حذف الحقل الأول');
    // حقل واحد وقاعدة صفوف موجودة ⇒ ما زال صالحاً للتشغيل
    assertEqual($('runBtn').disabled, false, 'الزر تعطّل رغم بقاء قاعدة الصفوف');
  });

  await check('نقر «بدء السحب» يرسل الأمر إلى الخلفية بالمهمة كاملة', () => {
    panel.calls.startRun = null;
    // ملاحظة: dispatchEvent يتجاوز حالة disabled، فهذا السطر هو ما يُثبت
    // أن الزر قابل للنقر فعلاً في المتصفح.
    assertEqual($('runBtn').disabled, false, 'الزر معطّل فلا يمكن للمستخدم نقرُه');
    $('runBtn').dispatchEvent(new panel.win.MouseEvent('click', { bubbles: true }));
    return sleep(20).then(() => {
      assert(panel.calls.startRun, 'لم يُرسل panel:startRun');
      assertEqual(panel.calls.startRun.tabId, 7, 'معرّف التبويب');
      assertEqual(panel.calls.startRun.job.parentSelector, '#movies', 'قاعدة الصفوف في المهمة');
      assert(panel.calls.startRun.job.fields.length >= 1, 'المهمة بلا حقول');
      assert(panel.calls.startRun.job.startUrl, 'لم يُضبط رابط البداية');
      assertEqual($('runBtn').disabled, true, 'يجب تعطيل الزر أثناء السحب');
    });
  });

  await check('حالة «جارٍ السحب» تُقفل الزر وتُظهر زر الإيقاف', () => {
    panel.calls.listener({
      from: 'sw',
      type: 'run:update',
      payload: { status: 'running', page: 2, totalRows: 40, reason: '', error: '' }
    });
    assertEqual($('runBtn').disabled, true, 'زر بدء السحب');
    assertEqual($('stopRunBtn').hidden, false, 'زر الإيقاف يجب أن يظهر');
    assert($('progressText').textContent.indexOf('صفحة 2') !== -1, 'نص التقدّم: ' + $('progressText').textContent);
  });

  await check('انتهاء السحب يُعيد تفعيل الزر', () => {
    panel.calls.listener({
      from: 'sw',
      type: 'run:update',
      payload: { status: 'done', page: 5, totalRows: 100, reason: 'no-next', error: '' }
    });
    assertEqual($('runBtn').disabled, false, 'زر بدء السحب');
    assertEqual($('stopRunBtn').hidden, true, 'زر الإيقاف يجب أن يختفي');
  });

  // ------------------------------------------------------------------
  // الصفحات المفصّلة (المستوى الثاني)
  // ------------------------------------------------------------------
  await check('تفعيل «صفحة العنصر» يكشف حقولها ويشترط التقاطها', () => {
    assertEqual($('detailBody').hidden, true, 'كتلة التفاصيل يجب أن تبدأ مخفية');
    $('detailEnabled').checked = true;
    $('detailEnabled').dispatchEvent(new panel.win.Event('change', { bubbles: true }));
    assertEqual($('detailBody').hidden, false, 'كتلة التفاصيل لم تظهر');
    assertEqual($('runBtn').disabled, true, 'يجب تعطيل البدء قبل التقاط حقول التفاصيل');
  });

  await check('التقاط رابط الدخول يُحفظ في المهمة', () => {
    panel.calls.listener(
      pickResult({
        mode: 'link',
        link: { selector: 'a.poster', label: 'الغلاف', relativeToRow: true, href: '/f/1' }
      })
    );
    assertEqual($('detailLinkSelector').value, 'a.poster', 'محدد رابط الدخول');
  });

  await check('«التقاط حقول التفاصيل» يطلب الالتقاط بهدف صفحة العنصر', () => {
    panel.calls.pick = null;
    $('pickDetailBtn').dispatchEvent(new panel.win.MouseEvent('click', { bubbles: true }));
    return sleep(20).then(() => {
      assert(panel.calls.pick, 'لم يُرسل panel:pick');
      assertEqual(panel.calls.pick.mode, 'field', 'وضع الالتقاط');
      assertEqual(panel.calls.pick.target, 'detail', 'هدف الالتقاط');
    });
  });

  await check('تعلّم حقول التفاصيل يُفعّل البدء ويُحصي الأعمدة', () => {
    panel.calls.listener(
      pickResult({
        mode: 'field',
        target: 'detail',
        learned: {
          containerSelector: 'article.movie-page',
          fields: [
            { name: 'plot', type: 'text', selector: 'p.plot', path: 'body > article > p' },
            { name: 'dur', type: 'text', selector: 'span.dur', path: 'body > article > span' }
          ],
          preview: [{ plot: 'قصة فيلم أول', dur: '21 دقيقة' }]
        }
      })
    );
    const names = Array.from($('detailFieldsList').querySelectorAll('.f-name')).map((el) => el.value);
    assertEqual(names.join(','), 'plot,dur', 'أسماء حقول التفاصيل المعروضة');
    assertEqual($('runBtn').disabled, false, 'يجب تفعيل البدء بعد اكتمال حقول التفاصيل');
    assert($('stats').textContent.indexOf('حقول التفاصيل') !== -1, 'إحصاء حقول التفاصيل');
  });

  await check('«اذهب لأول عنصر» يطلب فتح صفحة العنصر', () => {
    panel.calls.goto = null;
    $('gotoFirstBtn').dispatchEvent(new panel.win.MouseEvent('click', { bubbles: true }));
    return sleep(20).then(() => {
      assert(panel.calls.goto, 'لم يُرسل panel:gotoFirstItem');
      assertEqual(panel.calls.goto.tabId, 7, 'معرّف التبويب');
    });
  });

  await check('بدء السحب يرسل المهمة مع كتلة التفاصيل كاملة', () => {
    panel.calls.startRun = null;
    $('runBtn').dispatchEvent(new panel.win.MouseEvent('click', { bubbles: true }));
    return sleep(20).then(() => {
      const job = panel.calls.startRun && panel.calls.startRun.job;
      assert(job, 'لم تُرسل المهمة');
      assertEqual(job.detail.enabled, true, 'حقل enabled في كتلة التفاصيل');
      assertEqual(job.detail.linkSelector, 'a.poster', 'رابط الدخول في المهمة المُرسلة');
      assertEqual(
        (job.detail.fields || []).map((field) => field.name).join(','),
        'plot,dur',
        'حقول التفاصيل في المهمة المُرسلة'
      );
    });
  });

  console.log(log.join('\n'));
  if (failures) {
    console.log('\nفشل ' + failures + ' اختبار/اختبارات');
    process.exit(1);
  }
  console.log('\nكل اختبارات اللوحة نجحت (' + log.length + ')');
  process.exit(0);
})();
