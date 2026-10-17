/* ------------------------------------------------------------------
 * صهم — tools/test-detail.js
 * اختبار الزحف ذي المستويين: من صفحة القائمة يدخل صهم إلى صفحة كل عنصر،
 * يسحب حقول التفاصيل، ثم يعود إلى القائمة ويُكمل — مع تصفّح الصفحات.
 * الاختبار يشغّل background.js الحقيقي في كروم مُحاكى، وسكربتات المحتوى
 * الحقيقية في jsdom، فالمسار المُختبَر هو نفسه مسار الاستخدام الفعلي.
 * التشغيل:  node tools/test-detail.js
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
    throw new Error(
      (message || 'قيمة غير متوقّعة') +
        ' — متوقّع: ' + JSON.stringify(expected) + ' / فعلي: ' + JSON.stringify(actual)
    );
  }
}

// ------------------------------------------------------------------
// الصفحات المُحاكاة
// ------------------------------------------------------------------
const ORIGIN = 'https://example.com';
const PAGE1 = ORIGIN + '/movies?page=1';
const PAGE2 = ORIGIN + '/movies?page=2';

const MOVIES = [
  { id: 1, title: 'فيلم أول', year: 2021 },
  { id: 2, title: 'فيلم ثانٍ', year: 2022 },
  { id: 3, title: 'فيلم ثالث', year: 2023 },
  { id: 4, title: 'فيلم رابع', year: 2024 },
  { id: 5, title: 'فيلم خامس', year: 2025 },
  { id: 6, title: 'فيلم سادس', year: 2026 }
];

function listPage(movies, withNext) {
  const items = movies
    .map(
      (movie) =>
        '<li class="movie">' +
        '<a class="poster" href="/f/' + movie.id + '"><img src="/img/' + movie.id + '.jpg"></a>' +
        '<div class="meta"><h3 class="title">' + movie.title + '</h3>' +
        '<span class="year">' + movie.year + '</span></div>' +
        '</li>'
    )
    .join('');
  return (
    '<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"></head><body>' +
    '<ul id="movies">' + items + '</ul>' +
    (withNext ? '<button class="next-page">التالي</button>' : '') +
    '</body></html>'
  );
}

function detailPage(movie) {
  return (
    '<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"></head><body>' +
    '<article class="movie-page">' +
    '<h1 class="title">' + movie.title + '</h1>' +
    '<p class="plot">قصة ' + movie.title + '</p>' +
    '<span class="dur">' + (movie.year - 2000) + ' دقيقة</span>' +
    '</article></body></html>'
  );
}

const PAGES = {};
PAGES[PAGE1] = listPage(MOVIES.slice(0, 3), true);
PAGES[PAGE2] = listPage(MOVIES.slice(3, 6), false);
for (const movie of MOVIES) PAGES[ORIGIN + '/f/' + movie.id] = detailPage(movie);

/** الرابط الذي يقود إليه زر «التالي» — الكروم يتنقّل بعد النقر. */
const NEXT_URL = {};
NEXT_URL[PAGE1] = PAGE2;

const CONTENT_FILES = [
  'src/lib/selector.js',
  'src/lib/extract.js',
  'src/content/popups.js',
  'src/content/picker.js',
  'src/content/paginator.js',
  'src/content/content.js'
];

// ------------------------------------------------------------------
// عالم سكربت المحتوى لصفحة واحدة
// ------------------------------------------------------------------
function bootWorld(html, url, onCsMessage) {
  const dom = new JSDOM(html, { url: url, runScripts: 'outside-only' });
  const win = dom.window;
  const box = { listener: null, sent: [] };

  // jsdom لا يحسب التخطيط، فكشف «العنصر المرئي» يفشل بلا أبعاد حقيقية.
  win.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
  };
  win.scrollTo = () => {};

  win.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => (box.listener = fn) },
      sendMessage: (message, callback) => {
        box.sent.push(message);
        if (message && message.from === 'cs') onCsMessage(message);
        if (typeof callback === 'function') callback({ ok: true });
      }
    }
  };

  for (const file of CONTENT_FILES) win.eval(read(file));
  return { dom: dom, win: win, box: box };
}

// ------------------------------------------------------------------
// كروم مُحاكى للخلفية: تبويب واحد يتنقّل بين الصفحات المُحاكاة
// ------------------------------------------------------------------
const store = {};
const tab = { id: 7, url: PAGE1, active: true };
const events = { navigations: [], ready: [], dispatches: [] };
let bgOnMessage = null;
let world = null;

function dispatchToWorld(envelope) {
  if (!world || typeof world.box.listener !== 'function') {
    return Promise.resolve({ ok: false, error: 'no-content-script' });
  }
  events.dispatches.push(envelope.type + '@' + tab.url);
  return new Promise((resolve) => {
    const returned = world.box.listener(envelope, { tab: { id: tab.id } }, (response) => resolve(response));
    if (returned !== true) resolve(null);
  });
}

function mount(url) {
  tab.url = url;
  const html = PAGES[url] || '<!DOCTYPE html><html lang="ar"><body>صفحة غير معروفة</body></html>';
  world = bootWorld(html, url, (message) => {
    events.ready.push(url);
    // سكربت المحتوى يُعلن READY عند كل تحميل كامل — الخلفية تنتظره
    if (bgOnMessage) bgOnMessage(message, { tab: { id: tab.id } }, () => {});
  });
}

/** التنقّل يقع بعد أمر الكروم، لا قبله. */
function scheduleMount(url) {
  setTimeout(() => mount(url), 0);
}

function storageGet(keys, callback) {
  const out = {};
  if (keys == null) {
    Object.assign(out, store);
  } else {
    for (const key of [].concat(keys)) {
      if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
    }
  }
  callback(out);
}

const chromeStub = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => (bgOnMessage = fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: (message, callback) => {
      if (typeof callback === 'function') callback({ ok: true });
    }
  },
  storage: {
    local: {
      get: storageGet,
      set: (items, callback) => {
        Object.assign(store, items);
        if (typeof callback === 'function') callback();
      },
      remove: (keys, callback) => {
        for (const key of [].concat(keys)) delete store[key];
        if (typeof callback === 'function') callback();
      }
    }
  },
  tabs: {
    get: () => Promise.resolve({ id: tab.id, url: tab.url, active: true }),
    update: (tabId, props) => {
      if (props && props.url) {
        events.navigations.push(props.url);
        scheduleMount(props.url);
      }
      return Promise.resolve({ id: tab.id, url: (props && props.url) || tab.url });
    },
    sendMessage: (tabId, envelope, callback) => {
      // النقر على «التالي» في كروم حقيقي يُحمّل مستنداً جديداً؛ نُحاكي الأثر
      // نفسه بدل انتظار سلوك تنقّل لا يوفّره jsdom.
      if (envelope && envelope.type === 'CLICK_NEXT') {
        const next = NEXT_URL[tab.url];
        if (next) {
          events.navigations.push(next);
          scheduleMount(next);
          callback({ ok: true, clicked: true });
          return;
        }
        callback({ ok: true, clicked: false, reason: 'no-next-button' });
        return;
      }
      dispatchToWorld(envelope).then((response) => callback(response));
    },
    onRemoved: { addListener: () => {} },
    query: () => Promise.resolve([{ id: tab.id, url: tab.url, active: true }])
  },
  scripting: {
    executeScript: () => Promise.resolve([]),
    getRegisteredContentScripts: () => Promise.resolve([]),
    registerContentScripts: () => Promise.resolve(),
    unregisterContentScripts: () => Promise.resolve()
  },
  declarativeNetRequest: { updateEnabledRulesets: () => Promise.resolve() },
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  storage$onChanged: null
};

function sendToBackground(type, payload) {
  return new Promise((resolve) => {
    const returned = bgOnMessage({ from: 'panel', type: type, payload: payload || {} }, {}, (response) =>
      resolve(response)
    );
    if (returned !== true) resolve(null);
  });
}

// ------------------------------------------------------------------
// المهمة: حقول القائمة + حقول صفحة العنصر
// ------------------------------------------------------------------
const JOB = {
  id: 'job_detail',
  name: 'أفلام بتفاصيل',
  startUrl: PAGE1,
  parentSelector: '#movies',
  itemSignature: { tag: 'li', classes: ['movie'] },
  itemSelector: '#movies > li.movie',
  fields: [
    { name: 'title', type: 'text', selector: 'div.meta > h3.title' },
    { name: 'year', type: 'text', selector: 'div.meta > span.year' }
  ],
  detail: {
    enabled: true,
    linkSelector: 'a.poster',
    containerSelector: 'article.movie-page',
    fields: [
      { name: 'title', type: 'text', selector: 'h1.title' },
      { name: 'plot', type: 'text', selector: 'p.plot' },
      { name: 'dur', type: 'text', selector: 'span.dur' }
    ],
    waitMs: 2000,
    maxItems: 0
  },
  pagination: { selector: 'button.next-page', maxPages: 20 },
  options: {
    blockAds: false,
    killPopups: false,
    guardPopups: false,
    clickClose: false,
    autoScroll: false,
    delayMs: 0,
    waitMs: 2000,
    maxPages: 20
  }
};

function waitForRunEnd(limitMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const state = await sendToBackground('panel:getState', {});
      const run = (state && state.run) || null;
      if (run && run.status !== 'running') {
        resolve(run);
        return;
      }
      if (Date.now() - started > limitMs) {
        reject(new Error('لم ينتهِ السحب خلال ' + limitMs + 'ms — آخر حالة: ' + JSON.stringify(run)));
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

// ------------------------------------------------------------------
// التشغيل
// ------------------------------------------------------------------
(async function run() {
  // نحقن كروم المُحاكى ثم نُحمّل الخلفية الحقيقية في هذا السياق
  global.chrome = chromeStub;
  mount(PAGE1);
  new Function('chrome', read('src/background.js'))(chromeStub);

  check('الخلفية سجّلت مستمع الرسائل', () => assert(typeof bgOnMessage === 'function', 'لا مستمع'));
  check('عالم الصفحة الأولى جاهز', () => assert(world && world.win.SCX, 'لم تُحمَّل سكربتات المحتوى'));

  await checkAsync('EXTRACT يُعيد روابط الدخول بترتيب الصفوف نفسه', async () => {
    const res = await dispatchToWorld({ from: 'sw', type: 'EXTRACT', payload: { job: JOB } });
    assertEqual(res.ok, true, 'ok — خطأ: ' + (res && res.error));
    assert(Array.isArray(res.links), 'لا قائمة روابط');
    assertEqual(res.links.length, res.rows.length, 'عدد الروابط يجب أن يساوي عدد الصفوف');
    assertEqual(res.links[0].href, ORIGIN + '/f/1', 'رابط العنصر الأول');
    assertEqual(res.links[2].href, ORIGIN + '/f/3', 'رابط العنصر الثالث');
  });

  await checkAsync('DETAIL_EXTRACT يقرأ الحقول من صفحة العنصر', async () => {
    mount(ORIGIN + '/f/2');
    const res = await dispatchToWorld({ from: 'sw', type: 'DETAIL_EXTRACT', payload: { job: JOB } });
    assertEqual(res.ok, true, 'ok — خطأ: ' + (res && res.error));
    assertEqual(res.values.title, 'فيلم ثانٍ', 'العنوان من صفحة العنصر');
    assertEqual(res.values.plot, 'قصة فيلم ثانٍ', 'القصة');
    assertEqual(res.values.dur, '22 دقيقة', 'المدة');
    assertEqual(res.found, 3, 'يجب العثور على الحقول الثلاثة');
    assertEqual(res.total, 3, 'عدد الحقول المطلوبة');
  });

  await checkAsync('التقاط رابط الدخول يُنتج محدداً نسبياً إلى الصف', async () => {
    mount(PAGE1);
    world.box.sent.length = 0;
    const started = await dispatchToWorld({
      from: 'sw',
      type: 'PICK_START',
      payload: { mode: 'link', target: 'list', job: JOB }
    });
    assertEqual(started && started.ok, true, 'بدء الالتقاط');

    const anchor = world.win.document.querySelectorAll('#movies > li.movie a.poster')[1];
    assert(anchor, 'لم أجد رابط العنصر الثاني');
    anchor.dispatchEvent(new world.win.MouseEvent('click', { bubbles: true, cancelable: true }));

    const picked = world.box.sent.filter((message) => message.type === 'PICK_RESULT').pop();
    assert(picked, 'لم يصل PICK_RESULT');
    assertEqual(picked.payload.mode, 'link', 'وضع النتيجة');
    assert(
      picked.payload.link.selector.indexOf('a.poster') !== -1,
      'المحدد المُلتقط غير متوقّع: ' + picked.payload.link.selector
    );
    assertEqual(picked.payload.link.relativeToRow, true, 'يجب أن يكون المحدد نسبياً إلى الصف');
    assertEqual(picked.payload.link.href, '/f/2', 'رابط العنصر الثاني');
  });

  await checkAsync('التقاط حقل داخل صفحة العنصر يُنتج خطة تفاصيل صالحة', async () => {
    mount(ORIGIN + '/f/1');
    world.box.sent.length = 0;
    const started = await dispatchToWorld({
      from: 'sw',
      type: 'PICK_START',
      payload: { mode: 'field', target: 'detail', job: JOB }
    });
    assertEqual(started && started.ok, true, 'بدء الالتقاط');

    const doc = world.win.document;
    for (const selector of ['h1.title', 'p.plot', 'span.dur']) {
      const el = doc.querySelector(selector);
      assert(el, 'عنصر مفقود في صفحة الاختبار: ' + selector);
      el.dispatchEvent(new world.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    const picked = world.box.sent.filter((message) => message.type === 'PICK_RESULT').pop();
    assert(picked, 'لم يصل PICK_RESULT');
    assertEqual(picked.payload.target, 'detail', 'يجب أن تُوسم النتيجة بأنها من صفحة العنصر');
    const learned = picked.payload.learned;
    assert(learned && learned.containerSelector, 'لم تُستنتج حاوية للتفاصيل');
    assertEqual(learned.fields.length, 3, 'عدد حقول التفاصيل المُتعلَّمة');

    // الخطة المُتعلَّمة تُقرأ فعلاً من صفحة العنصر
    const values = world.win.SCX.ex.extractDetail({
      containerSelector: learned.containerSelector,
      fields: learned.fields
    });
    const all = Object.keys(values.values).map((key) => values.values[key]);
    for (const expected of ['فيلم أول', 'قصة فيلم أول', '21 دقيقة']) {
      assert(all.indexOf(expected) !== -1, 'قيمة مفقودة بعد التعلّم: ' + expected + ' — القيم: ' + JSON.stringify(values.values));
    }
    assertEqual(values.found, 3, 'عدد الحقول المقروءة');
  });

  await checkAsync('سحب كامل: دخول كل عنصر ودمج التفاصيل مع صف القائمة', async () => {
    mount(PAGE1);
    events.navigations.length = 0;

    const engaged = await sendToBackground('panel:engage', { tabId: tab.id });
    assert(engaged, 'لم تُسجَّل مشاركة التبويب');

    const started = await sendToBackground('panel:startRun', { job: JOB, tabId: tab.id });
    assertEqual(started && started.ok, true, 'بدء السحب — ' + JSON.stringify(started));

    const finished = await waitForRunEnd(30000);
    assertEqual(finished.status, 'done', 'حالة النهاية');
    assertEqual(finished.reason, 'no-next', 'سبب النهاية');
    assertEqual(finished.totalRows, 6, 'عدد الصفوف المسحوبة');
    assertEqual(finished.itemsFilled, 6, 'عدد العناصر التي سُحبت تفاصيلها');
    assertEqual(finished.itemsFailed, 0, 'عدد العناصر الفاشلة');

    // الصفوف المخزّنة: بيانات القائمة + بيانات التفاصيل في صف واحد
    const rowsOut = await sendToBackground('panel:readRows', { jobId: JOB.id, limit: 50 });
    const rows = rowsOut.rows || [];
    assertEqual(rows.length, 6, 'عدد الصفوف المخزّنة');

    const first = rows[0];
    assertEqual(first.title, 'فيلم أول', 'حقل القائمة في الصف الأول');
    assertEqual(first.year, '2021', 'سنة الصف الأول');
    assertEqual(first.detail_title, 'فيلم أول', 'عنوان التفاصيل مدموج بمفتاح مُسبَّق');
    assertEqual(first.detail_plot, 'قصة فيلم أول', 'قصة التفاصيل');
    assertEqual(first.detail_dur, '21 دقيقة', 'مدة التفاصيل');

    const last = rows[5];
    assertEqual(last.title, 'فيلم سادس', 'الصف السادس من الصفحة الثانية');
    assertEqual(last.detail_plot, 'قصة فيلم سادس', 'تفاصيل الصف السادس');

    // كل صف يجب أن يحمل تفاصيل العنصر نفسه — لا اختلاف في الترتيب
    for (const movie of MOVIES) {
      const row = rows.find((item) => item.title === movie.title);
      assert(row, 'صف مفقود: ' + movie.title);
      assertEqual(row.detail_title, movie.title, 'اختلط الاقتران بين الصف وصفحته عند ' + movie.title);
    }
  });

  await checkAsync('مسار التنقّل: قائمة ← عنصر ← قائمة ← … ← صفحة تالية', async () => {
    const expect = [
      ORIGIN + '/f/1', PAGE1, ORIGIN + '/f/2', PAGE1, ORIGIN + '/f/3', PAGE1,
      PAGE2,
      ORIGIN + '/f/4', PAGE2, ORIGIN + '/f/5', PAGE2, ORIGIN + '/f/6', PAGE2
    ];
    assertEqual(events.navigations.join(' → '), expect.join(' → '), 'ترتيب التنقّل');
  });

  await checkAsync('خطة تفاصيل لا تطابق الصفحة: تُحسب فشلاً ويبقى صف القائمة', async () => {
    const badJob = JSON.parse(JSON.stringify(JOB));
    badJob.id = 'job_detail_bad';
    badJob.name = 'خطة غير مطابقة';
    badJob.detail.fields = [{ name: 'ghost', type: 'text', selector: '.ghost-field' }];
    badJob.detail.waitMs = 1500;
    badJob.detail.maxItems = 2; // نُسرّع: عنصران فقط يدخل إليهما

    const started = await sendToBackground('panel:startRun', { job: badJob, tabId: tab.id });
    assertEqual(started && started.ok, true, 'بدء السحب — ' + JSON.stringify(started));
    const navTrace = events.navigations.length;

    const finished = await waitForRunEnd(30000);
    assertEqual(finished.status, 'done', 'حالة النهاية');
    assertEqual(finished.itemsFilled, 0, 'لا حقل تطابق');
    assertEqual(finished.itemsFailed, 2, 'عدد المحاولات الفاشلة (بحدّ maxItems)');
    assertEqual(
      finished.totalRows,
      6,
      'صفوف القائمة تُحفظ رغم فشل التفاصيل (السبب: ' +
        finished.reason +
        ' — السجل: ' +
        JSON.stringify((finished.log || []).slice(-6)) +
        ' — الصفحات: ' +
        JSON.stringify(finished.visitedUrls) +
        ' — التنقّل: ' +
        events.navigations.slice(navTrace).join(' → ') +
        ' — الرسائل: ' +
        events.dispatches.slice(-14).join(' , ') +
        ')'
    );

    const rowsOut = await sendToBackground('panel:readRows', { jobId: badJob.id, limit: 50 });
    const rows = rowsOut.rows || [];
    assertEqual(rows.length, 6, 'عدد الصفوف المخزّنة');
    assertEqual(rows[0].title, 'فيلم أول', 'بيانات القائمة محفوظة');
    assertEqual(rows[0].detail_ghost, '', 'المحاولة الفاشلة تُترك مفتاحاً فارغاً');
    assert(!('detail_ghost' in rows[5]), 'العناصر غير المحاوَلة لا تحمل مفاتيح تفاصيل');
  });

  console.log(log.join('\n'));
  if (failures) {
    console.log('\nفشل ' + failures + ' اختبار/اختبارات');
    process.exit(1);
  }
  console.log('\nكل اختبارات الصفحات المفصّلة نجحت (' + log.length + ')');
  process.exit(0);
})();
