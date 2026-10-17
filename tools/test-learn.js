/* ------------------------------------------------------------------
 * أداة تطوير: اختبار نواة التعلّم والاستخراج على صفحة HTML حقيقية (jsdom).
 *
 *   npm install --no-save jsdom
 *   node tools/test-learn.js
 *
 * تغطّي: اكتشاف الصف المتكرّر، اشتقاق المحددات النسبية، تجمّد الأصناف،
 * إزالة التكرار، استخراج النص/الرابط/الصورة/القوائم، واستبعاد الإعلانات.
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  console.error('مطلوب تثبيت jsdom:  npm install --no-save jsdom');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');

// ------------------------------------------------------------------
// صفحة اختبار: قائمة أفلام + إعلان داخل القائمة + نافذة منبثقة
// ------------------------------------------------------------------
const PAGE = `<!DOCTYPE html>
<html lang="ar"><head><meta charset="utf-8"><title>قائمة الأفلام</title></head>
<body>
  <header class="site-header"><nav><a href="/">الرئيسية</a></nav></header>

  <div class="ad-slot" data-ad-slot="top">
    <iframe src="https://ads.example.net/banner"></iframe>
  </div>

  <h1>أفلام</h1>
  <ul id="movies" class="movie-list">
    <li class="movie">
      <a class="poster" href="/movie/1"><img src="/img/1.jpg" width="300" height="450" alt="الغلاف"></a>
      <div class="meta">
        <h3 class="title"><a href="/movie/1">الفيلم الأول</a></h3>
        <span class="year">2021</span>
        <span class="rating">8.4</span>
        <span class="genre">أكشن</span>
        <span class="genre">دراما</span>
      </div>
    </li>
    <li class="movie highlighted">
      <a class="poster" href="/movie/2"><img src="/img/2.jpg" width="300" height="450" alt="الغلاف"></a>
      <div class="meta">
        <h3 class="title"><a href="/movie/2">الفيلم الثاني</a></h3>
        <span class="year">2019</span>
        <span class="rating">7.1</span>
        <span class="genre">كوميديا</span>
      </div>
    </li>
    <li class="movie">
      <a class="poster" href="/movie/3"><img src="/img/3.jpg" width="300" height="450" alt="الغلاف"></a>
      <div class="meta">
        <h3 class="title"><a href="/movie/3">الفيلم الثالث</a></h3>
        <span class="year">2023</span>
        <span class="rating">9.0</span>
        <span class="genre">خيال علمي</span>
        <span class="genre">رعب</span>
      </div>
    </li>
    <li class="ad-banner"><a href="http://spam.example.com">إعلان</a></li>
  </ul>

  <div class="pagination">
    <a class="page-link" href="/movies?page=1">1</a>
    <a class="page-link" href="/movies?page=2">2</a>
    <a class="next-page" rel="next" href="/movies?page=2">التالي ›</a>
  </div>

  <div id="popup-modal" class="popup-modal" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999">
    <div class="popup-inner">اشترك في النشرة</div>
  </div>
</body></html>`;

// ------------------------------------------------------------------
// أدوات الاختبار
// ------------------------------------------------------------------
const log = [];
let failed = 0;

function check(name, fn) {
  try {
    fn();
    log.push('PASS  ' + name);
  } catch (error) {
    failed++;
    log.push('FAIL  ' + name + '\n        → ' + error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'شرط غير محقّق');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'قيمة غير مطابقة') + ' — متوقّع: ' + JSON.stringify(expected) + ' / فعلي: ' + JSON.stringify(actual));
  }
}

function makeWorld(html) {
  const dom = new JSDOM(html || PAGE, {
    url: 'https://example.com/movies?page=1',
    runScripts: 'outside-only'
  });
  for (const rel of ['src/lib/selector.js', 'src/lib/extract.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), dom.getInternalVMContext(), { filename: rel });
  }
  const SC = dom.window.SCX;
  assert(SC && SC.sel && SC.ex, 'لم تُحمَّل مكتبات SCX');
  return { dom: dom, win: dom.window, SC: SC };
}

/** يحاكي ما تفعله أداة الالتقاط عند النقر على عنصر. */
function pick(world, selector, override) {
  const el = world.win.document.querySelector(selector);
  assert(el, 'لم يُعثر على العنصر المطلوب اختياره: ' + selector);
  const guessed = world.SC.ex.guessType(el);
  return Object.assign(
    {
      name: override && override.name ? override.name : selector.replace(/[^a-z]/gi, '_'),
      type: guessed.type,
      attr: guessed.attr || '',
      path: world.SC.sel.cssPath(el),
      el: el
    },
    override || {}
  );
}

function analyze(world, entries) {
  return world.SC.ex.analyze({ fields: [] }, entries);
}

// ------------------------------------------------------------------
// 1) التعلّم من خمسة حقول
// ------------------------------------------------------------------
const world = makeWorld();
const SC = world.SC;
const doc = world.win.document;

check('jsdom يدعم :scope في querySelectorAll (لازم للمحددات النسبية)', () => {
  const meta = doc.querySelector('#movies .movie .meta');
  const found = meta.querySelectorAll(':scope > span.year');
  assertEqual(found.length, 1, 'نتيجة :scope');
});

const entries = [
  pick(world, '#movies .movie .title', { name: 'title' }),
  pick(world, '#movies .movie img', { name: 'poster' }),
  pick(world, '#movies .movie .year', { name: 'year' }),
  pick(world, '#movies .movie .rating', { name: 'rating' }),
  pick(world, '#movies .movie .genre', { name: 'genres', type: 'list', attr: '' })
];

const learned = analyze(world, entries);

check('التعلّم يعيد نتيجة', () => assert(learned, 'analyze أعاد null'));

check('حاوية الصف هي li.movie في القائمة', () => {
  assert(/^#?[a-z]*#?movies$|^ul#movies$/.test(learned.parentSelector), 'محدد الأب: ' + learned.parentSelector);
  assertEqual(learned.itemSignature.tag, 'li', 'وسم الصف');
  assert(learned.itemSignature.classes.indexOf('movie') !== -1, 'الصف يتضمّن الصنف movie');
});

check('عدد الصفوف المتشابهة = 3 (استُبعد li.ad-banner)', () => {
  assertEqual(learned.itemCount, 3, 'عدد العناصر المتشابهة');
  assertEqual(learned.rowCount, 3, 'عدد الصفوف بعد التصفية');
});

check('استبعاد صف الإعلان من النتائج', () => {
  const job = { parentSelector: learned.parentSelector, itemSignature: learned.itemSignature, fields: learned.fields };
  const rows = SC.ex.findRows(job);
  assertEqual(rows.length, 3, 'عدد الصفوف');
  for (const row of rows) {
    assert(!/ad-banner/.test(row.className), 'ظهر صف إعلاني');
  }
});

check('الصنف الإضافي (highlighted) لم يُسقط الصف الثاني', () => {
  const job = { parentSelector: learned.parentSelector, itemSignature: learned.itemSignature, fields: learned.fields };
  const rows = SC.ex.findRows(job);
  const hasHighlighted = rows.some((row) => /highlighted/.test(row.className));
  assert(hasHighlighted, 'الصف ذو الصنف الإضافي مفقود');
});

check('كل حقل يُحلّ في كل صف بلا فقدان', () => {
  for (const field of learned.fields) {
    assertEqual(field.missing, 0, 'حقل مفقود: ' + field.name + ' (المحدد: ' + field.selector + ')');
  }
});

check('محددات الحقول لا تعتمد على nth-of-type هشّة', () => {
  const year = learned.fields.find((field) => field.name === 'year');
  assertEqual(year.selector, 'div.meta > span.year', 'محدد السنة');
  const poster = learned.fields.find((field) => field.name === 'poster');
  assertEqual(poster.selector, 'a.poster > img', 'محدد الصورة');
});

// ------------------------------------------------------------------
// 2) الاستخراج
// ------------------------------------------------------------------
const job = {
  parentSelector: learned.parentSelector,
  itemSignature: learned.itemSignature,
  fields: learned.fields
};
const page = SC.ex.extractPage(job);

check('استُخرجت ثلاثة صفوف', () => assertEqual(page.rows.length, 3, 'عدد الصفوف'));

check('النصوص العربية سليمة', () => {
  assertEqual(page.rows[0].title, 'الفيلم الأول', 'عنوان الصف الأول');
  assertEqual(page.rows[1].title, 'الفيلم الثاني', 'عنوان الصف الثاني');
  assertEqual(page.rows[2].title, 'الفيلم الثالث', 'عنوان الصف الثالث');
  assertEqual(page.rows[0].year, '2021', 'سنة الصف الأول');
  assertEqual(page.rows[2].rating, '9.0', 'تقييم الصف الثالث');
});

check('روابط الصور تُحوّل إلى روابط مطلقة', () => {
  assertEqual(page.rows[0].poster, 'https://example.com/img/1.jpg', 'رابط الصورة');
  assertEqual(page.rows[2].poster, 'https://example.com/img/3.jpg', 'رابط الصورة الثالثة');
});

check('حقل القائمة يجمع كل القيم', () => {
  assertEqual(page.rows[0].genres, 'أكشن | دراما', 'تصنيفات الصف الأول');
  assertEqual(page.rows[1].genres, 'كوميديا', 'تصنيفات الصف الثاني');
  assertEqual(page.rows[2].genres, 'خيال علمي | رعب', 'تصنيفات الصف الثالث');
});

// ------------------------------------------------------------------
// 3) حقول من نوع رابط
// ------------------------------------------------------------------
check('نوع «رابط» يستخرج href مطلقاً', () => {
  const hrefEntry = pick(world, '#movies .movie .poster', { name: 'link' });
  assertEqual(hrefEntry.type, 'href', 'النوع المخمّن');
  const field = { name: 'link', type: 'href', selector: 'a.poster', attr: '' };
  const value = SC.ex.valueOf(doc.querySelector('#movies .movie'), field);
  assertEqual(value, 'https://example.com/movie/1', 'قيمة الرابط');
});

check('نوع «رقم» يستخرج الرقم من نص مخلوط', () => {
  const row = doc.querySelector('#movies .movie');
  const field = { name: 'r', type: 'number', selector: 'span.rating' };
  assertEqual(SC.ex.valueOf(row, field), '8.4', 'قيمة الرقم');
});

check('نوع «خاصية» يستخرج attribute', () => {
  const row = doc.querySelector('#movies .movie');
  const field = { name: 'w', type: 'attr', attr: 'width', selector: 'img' };
  assertEqual(SC.ex.valueOf(row, field), '300', 'قيمة العرض');
});

// ------------------------------------------------------------------
// 4) متانة المحدد المطلق
// ------------------------------------------------------------------
check('cssPath فريد لكل عنصر في الصفحة', () => {
  const nodes = Array.from(doc.querySelectorAll('#movies .movie *'));
  let checked = 0;
  for (const node of nodes) {
    const selector = SC.sel.cssPath(node);
    if (!selector) continue;
    checked++;
    let matches = 0;
    try {
      matches = doc.querySelectorAll(selector).length;
    } catch (error) {
      throw new Error('محدد غير صالح: ' + selector);
    }
    assertEqual(matches, 1, 'المحدد غير فريد: ' + selector);
  }
  assert(checked > 20, 'عدد العناصر المختبَرة قليل: ' + checked);
});

check('صنف يبدو مولَّداً آلياً يُرفض', () => {
  assert(!SC.sel.isStableToken('css-1x2y3z'), 'css-1x2y3z يجب أن يُرفض');
  assert(!SC.sel.isStableToken('3f9a2b1c'), 'الهاش يجب أن يُرفض');
  assert(!SC.sel.isStableToken('item-1234'), 'الأرقام الكثيرة تُرفض');
  assert(SC.sel.isStableToken('movie-title'), 'movie-title صنف مستقر');
});

// ------------------------------------------------------------------
// 5) الالتقاط من صف يحمل صنفاً إضافياً (اختبار تحمّل الضجيج)
// ------------------------------------------------------------------
check('الالتقاط انطلاقاً من الصف المميّز يعطي نفس القاعدة', () => {
  const noisy = [
    pick(world, '#movies .movie.highlighted .title', { name: 'title' }),
    pick(world, '#movies .movie.highlighted .year', { name: 'year' })
  ];
  const result = analyze(world, noisy);
  assert(result, 'analyze أعاد null');
  assertEqual(result.itemCount, 3, 'عدد الصفوف من الصف المميّز');
  assertEqual(
    result.parentSelector,
    learned.parentSelector,
    'محدد الأب يجب أن يطابق نتيجة الالتقاط من الصف العادي'
  );
});

// ------------------------------------------------------------------
// 6) حقل واحد فقط (حالة غامضة مقصودة)
// ------------------------------------------------------------------
check('حقل واحد: يختار أضيق مستوى متكرّر', () => {
  const single = [pick(world, '#movies .movie .title', { name: 'title' })];
  const result = analyze(world, single);
  assert(result, 'analyze أعاد null');
  assert(result.itemCount >= 2, 'يجب أن يكتشف تكراراً — فعلي: ' + result.itemCount);
});

// ------------------------------------------------------------------
// 7) صفحة جدولية بلا مُعرّفات + صف إعلاني + صورة كسولة
// ------------------------------------------------------------------
const TABLE_PAGE = `<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"></head><body>
  <div class="wrap">
    <table class="results">
      <thead><tr><th>الاسم</th><th>السعر</th><th>صورة</th></tr></thead>
      <tbody>
        <tr class="row-item"><td class="name"><span>منتج أ</span></td><td class="price">12.50 ر.س</td><td><img class="thumb" data-src="/t/a.png"></td></tr>
        <tr class="row-item"><td class="name"><span>منتج ب</span></td><td class="price">7.00 ر.س</td><td><img class="thumb" data-src="/t/b.png"></td></tr>
        <tr class="row-item"><td class="name"><span>منتج ج</span></td><td class="price">99.99 ر.س</td><td><img class="thumb" data-src="/t/c.png"></td></tr>
        <tr class="row-item ad-row"><td colspan="3">مساحة إعلانية</td></tr>
      </tbody>
    </table>
  </div>
</body></html>`;

const tableWorld = makeWorld(TABLE_PAGE);
const tableEntries = [
  pick(tableWorld, '.results tbody .name span', { name: 'name' }),
  pick(tableWorld, '.results tbody .price', { name: 'price' }),
  pick(tableWorld, '.results tbody img.thumb', { name: 'image' })
];
const tableLearned = analyze(tableWorld, tableEntries);

check('جدول: اكتشاف الصفوف 3 واستبعاد الصف الإعلاني', () => {
  assert(tableLearned, 'analyze أعاد null');
  assertEqual(tableLearned.itemCount, 3, 'عدد الصفوف');
  assertEqual(tableLearned.rowCount, 3, 'عدد الصفوف بعد التصفية');
});

check('جدول: استخراج القيم وتفكيك الصورة الكسولة (data-src)', () => {
  const job = {
    parentSelector: tableLearned.parentSelector,
    itemSignature: tableLearned.itemSignature,
    fields: tableLearned.fields
  };
  const rows = tableWorld.SC.ex.extractPage(job).rows;
  assertEqual(rows.length, 3, 'عدد الصفوف');
  assertEqual(rows[0].name, 'منتج أ', 'الاسم');
  assertEqual(rows[1].price, '7.00 ر.س', 'السعر');
  assertEqual(rows[2].image, 'https://example.com/t/c.png', 'الصورة الكسولة');
});

check('جدول: الأسعار لا تختلط بقيم الصفوف المجاورة', () => {
  const job = {
    parentSelector: tableLearned.parentSelector,
    itemSignature: tableLearned.itemSignature,
    fields: tableLearned.fields
  };
  const rows = tableWorld.SC.ex.extractPage(job).rows;
  const prices = rows.map((row) => row.price);
  assertEqual(prices.join(','), '12.50 ر.س,7.00 ر.س,99.99 ر.س', 'تسلسل الأسعار');
});

// ------------------------------------------------------------------
// 8) فخ التكرار المتداخل: مجموعة وسوم داخل كل بطاقة
// ------------------------------------------------------------------
const NESTED_PAGE = `<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"></head><body>
  <section class="grid">
    <div class="card"><h2 class="card-title">عنوان أ</h2>
      <div class="tags"><a class="tag">وسم1</a><a class="tag">وسم2</a><a class="tag">وسم3</a></div>
      <span class="date">2024-01-01</span></div>
    <div class="card"><h2 class="card-title">عنوان ب</h2>
      <div class="tags"><a class="tag">وسم4</a></div>
      <span class="date">2024-02-02</span></div>
    <div class="card"><h2 class="card-title">عنوان ج</h2>
      <div class="tags"><a class="tag">وسم5</a><a class="tag">وسم6</a></div>
      <span class="date">2024-03-03</span></div>
  </section>
</body></html>`;

const nestedWorld = makeWorld(NESTED_PAGE);

check('متداخل: اختيار حقلين سطحيين يعطي البطاقة لا مجموعة الوسوم', () => {
  const entries = [
    pick(nestedWorld, '.grid .card .card-title', { name: 'title' }),
    pick(nestedWorld, '.grid .card .date', { name: 'date' })
  ];
  const result = analyze(nestedWorld, entries);
  assert(result, 'analyze أعاد null');
  assertEqual(result.itemCount, 3, 'عدد البطاقات');
  assertEqual(result.itemSignature.classes.join(','), 'card', 'الصف يجب أن يكون div.card');
});

check('متداخل: اختيار وسم من داخل المجموعة لا يفسد القاعدة', () => {
  const entries = [
    pick(nestedWorld, '.grid .card .card-title', { name: 'title' }),
    pick(nestedWorld, '.grid .card .tags .tag', { name: 'tag' })
  ];
  const result = analyze(nestedWorld, entries);
  assert(result, 'analyze أعاد null');
  assertEqual(result.itemCount, 3, 'عدد البطاقات');
  const tagField = result.fields.find((field) => field.name === 'tag');
  assert(tagField && tagField.selector, 'محدد الوسم مفقود');
  const job = {
    parentSelector: result.parentSelector,
    itemSignature: result.itemSignature,
    fields: result.fields
  };
  const rows = nestedWorld.SC.ex.extractPage(job).rows;
  assertEqual(rows[0].tag, 'وسم1', 'قيمة الوسم الأول');
  assertEqual(rows[2].tag, 'وسم5', 'قيمة الوسم الثالث');
});

check('متداخل: الوسوم المتعددة في بطاقة تُجمع عند استخدام نوع القائمة', () => {
  const entries = [
    pick(nestedWorld, '.grid .card .card-title', { name: 'title' }),
    pick(nestedWorld, '.grid .card .tags .tag', { name: 'tags', type: 'list' })
  ];
  const result = analyze(nestedWorld, entries);
  const job = {
    parentSelector: result.parentSelector,
    itemSignature: result.itemSignature,
    fields: result.fields
  };
  const rows = nestedWorld.SC.ex.extractPage(job).rows;
  assertEqual(rows[0].tags, 'وسم1 | وسم2 | وسم3', 'وسوم البطاقة الأولى');
});

// ------------------------------------------------------------------
console.log(log.join('\n'));
console.log('\n' + (failed ? 'فشل ' + failed + ' اختبار/اختبارات' : 'كل الاختبارات نجحت (' + log.length + ')'));
process.exit(failed ? 1 : 0);
