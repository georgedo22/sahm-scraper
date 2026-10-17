/* ------------------------------------------------------------------
 * صهم — src/background.js (service worker)
 * العقل المنسّق: يخزّن المشاريع، يقود حلقة السحب بين الصفحات،
 * يخزّن النتائج على شكل أجزاء، ويوصّل الرسائل بين اللوحة والصفحة.
 * ------------------------------------------------------------------ */
'use strict';

const STORE = {
  RUN: 'run',
  OPTIONS: 'options',
  JOBS: 'jobs',
  CURRENT_JOB: 'currentJobId',
  ENGAGED: 'engaged'
};

const ROWS_KEY = (jobId) => 'rowsIndex:' + jobId;
const CHUNK_KEY = (jobId, page) => 'chunk:' + jobId + ':' + page;

const LIMITS = {
  maxRows: 200000,
  maxPagesHard: 500,
  maxRuntimeMs: 45 * 60 * 1000,
  maxLogLines: 200
};

const DEFAULT_OPTIONS = {
  blockAds: false,
  killPopups: true,
  guardPopups: true,
  clickClose: false,
  autoScroll: false,
  delayMs: 1500,
  maxPages: 20,
  waitMs: 9000
};

// ------------------------------------------------------------------
// تخزين
// ------------------------------------------------------------------
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (data) => resolve(data || {})));
}
function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
}
function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
}

// ------------------------------------------------------------------
// حالة التشغيل (في الذاكرة + نسخة مُبسّطة في التخزين)
// ------------------------------------------------------------------
let run = null;
let driving = false;
let readyWaiters = [];

function newRun(job, tabId) {
  return {
    jobId: job.id,
    jobName: job.name || 'مجموعة',
    tabId: tabId,
    status: 'running',
    page: 0,
    totalRows: 0,
    detailMode: !!(job.detail && job.detail.enabled && (job.detail.fields || []).length),
    itemIndex: 0,
    itemTotal: 0,
    itemsFilled: 0,
    itemsFailed: 0,
    itemsCrawled: 0,
    listUrl: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastUrl: '',
    visitedUrls: [],
    consecutiveEmpty: 0,
    consecutiveErrors: 0,
    stalled: 0,
    lastSnapshot: '',
    reason: '',
    error: '',
    log: [],
    seen: new Set(),
    seenHashes: []
  };
}

function publicRun() {
  if (!run) return null;
  return {
    jobId: run.jobId,
    jobName: run.jobName,
    tabId: run.tabId,
    status: run.status,
    page: run.page,
    totalRows: run.totalRows,
    detailMode: run.detailMode,
    itemIndex: run.itemIndex,
    itemTotal: run.itemTotal,
    itemsFilled: run.itemsFilled,
    itemsFailed: run.itemsFailed,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    reason: run.reason,
    error: run.error,
    log: run.log.slice(-40)
  };
}

async function persistRun() {
  if (!run) return storageRemove(STORE.RUN);
  const saved = publicRun();
  saved.seenHashes = run.seenHashes.slice(-40000);
  saved.visitedUrls = run.visitedUrls.slice(-200);
  saved.lastSnapshot = run.lastSnapshot;
  saved.consecutiveEmpty = run.consecutiveEmpty;
  saved.consecutiveErrors = run.consecutiveErrors;
  saved.stalled = run.stalled;
  saved.lastUrl = run.lastUrl;
  await storageSet({ [STORE.RUN]: saved });
}

function log(message) {
  if (!run) return;
  run.log.push({ t: Date.now(), text: message });
  if (run.log.length > LIMITS.maxLogLines) run.log.splice(0, run.log.length - LIMITS.maxLogLines);
  broadcast('run:log', { text: message, t: Date.now() });
}

function broadcast(type, payload) {
  try {
    chrome.runtime.sendMessage({ from: 'sw', type: type, payload: payload }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* لا مستمعين */
  }
}

// ------------------------------------------------------------------
// أدوات الرسائل
// ------------------------------------------------------------------
function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs || 20000);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // سكربت المحتوى يرفض أي رسالة بلا from:'sw' — المغلف إلزامي
    const envelope = { from: 'sw', type: message.type, payload: message.payload || {} };
    try {
      chrome.tabs.sendMessage(tabId, envelope, (response) => {
        const err = chrome.runtime.lastError;
        if (err) finish({ ok: false, error: err.message || 'channel-error' });
        else finish(response || { ok: false, error: 'empty-response' });
      });
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}

function armReady(tabId, timeoutMs) {
  const waiter = { tabId: tabId, settled: false, resolve: null };
  const promise = new Promise((resolve) => {
    waiter.resolve = resolve;
  });
  waiter.timer = setTimeout(() => settleWaiter(waiter, null), timeoutMs || 30000);
  waiter.promise = promise;
  waiter.cancel = () => settleWaiter(waiter, null);
  readyWaiters.push(waiter);
  return waiter;
}

function settleWaiter(waiter, value) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  readyWaiters = readyWaiters.filter((item) => item !== waiter);
  waiter.resolve(value);
}

function settleReadyFor(tabId, payload) {
  for (const waiter of readyWaiters.slice()) {
    if (waiter.tabId === tabId) settleWaiter(waiter, payload);
  }
}

// ------------------------------------------------------------------
// تعقيم الصفوف والهاش
// ------------------------------------------------------------------
function hashRow(row) {
  const text = Object.keys(row)
    .map((key) => key + '=' + String(row[key]).slice(0, 300))
    .join('\u0001');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + text.length.toString(36);
}

async function resetRows(jobId) {
  const indexKey = ROWS_KEY(jobId);
  const data = await storageGet(indexKey);
  const index = data[indexKey];
  const removeKeys = [indexKey];
  if (index && index.pages) {
    for (let i = 0; i < index.pages; i++) removeKeys.push(CHUNK_KEY(jobId, i));
  }
  await storageRemove(removeKeys);
}

/** يضيف صفحة كاملة كجزء مستقل — كتابة O(1) لكل صفحة. */
async function appendPage(jobId, pageIndex, rows, seen, seenHashes) {
  const fresh = [];
  for (const row of rows) {
    const hash = hashRow(row);
    if (seen.has(hash)) continue;
    seen.add(hash);
    seenHashes.push(hash);
    fresh.push(row);
    if (seen.size >= LIMITS.maxRows) break;
  }
  if (!fresh.length) return 0;

  const indexKey = ROWS_KEY(jobId);
  const data = await storageGet(indexKey);
  const index = data[indexKey] || { pages: 0, total: 0, updatedAt: 0 };
  await storageSet({
    [CHUNK_KEY(jobId, index.pages)]: fresh,
    [indexKey]: {
      pages: index.pages + 1,
      total: index.total + fresh.length,
      updatedAt: Date.now()
    }
  });
  return fresh.length;
}

async function readRows(jobId, limit) {
  const indexKey = ROWS_KEY(jobId);
  const data = await storageGet(indexKey);
  const index = data[indexKey];
  if (!index || !index.pages) return [];
  const max = typeof limit === 'number' ? limit : Infinity;
  const keys = [];
  for (let i = 0; i < index.pages; i++) keys.push(CHUNK_KEY(jobId, i));
  const chunks = await storageGet(keys);
  const out = [];
  for (const key of keys) {
    const chunk = chunks[key] || [];
    for (const row of chunk) {
      out.push(row);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// ضمان وجود سكربتات المحتوى في التبويب.
// الصفحات المفتوحة قبل تثبيت الإضافة أو تحديثها لا تحتوي السكربتات،
// فنحقنها يدوياً بدل مطالبة المستخدم بإعادة تحميل الصفحة.
// ------------------------------------------------------------------
const CONTENT_FILES = [
  'src/lib/selector.js',
  'src/lib/extract.js',
  'src/content/popups.js',
  'src/content/picker.js',
  'src/content/paginator.js',
  'src/content/content.js'
];

async function ensureContent(tabId) {
  const ping = await sendToTab(tabId, { type: 'PING', payload: {} }, 4000);
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
  } catch (e) {
    return false;
  }
  const retry = await sendToTab(tabId, { type: 'PING', payload: {} }, 4000);
  return !!(retry && retry.ok);
}

// ------------------------------------------------------------------
// الإعدادات العامة
// ------------------------------------------------------------------
async function loadOptions() {
  const data = await storageGet(STORE.OPTIONS);
  return Object.assign({}, DEFAULT_OPTIONS, data[STORE.OPTIONS] || {});
}

async function pushOptions(options) {
  broadcast('options:update', options);
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: options.blockAds ? ['ads_block'] : [],
      disableRulesetIds: options.blockAds ? [] : ['ads_block']
    });
  } catch (e) {
    /* بعض إصدارات كروم قد ترفض — نتجاهل */
  }
}

// ------------------------------------------------------------------
// "التبويبات المشمولة": لا نتدخّل في الصفحات إلا بعد أن يفتح المستخدم
// اللوحة لهذا التبويب (أو يكون السحب جارياً عليه). هكذا تبقى التصفّح
// العادي بلا أي تدخّل.
// ------------------------------------------------------------------
const ENGAGE_TTL_MS = 6 * 60 * 60 * 1000;
let engaged = {};
let engagedLoaded = false;

async function ensureEngagedLoaded() {
  if (engagedLoaded) return;
  const data = await storageGet(STORE.ENGAGED);
  engaged = data[STORE.ENGAGED] || {};
  engagedLoaded = true;
}

async function engageTab(tabId) {
  if (typeof tabId !== 'number') return { ok: false };
  await ensureEngagedLoaded();
  engaged[String(tabId)] = Date.now();
  await storageSet({ [STORE.ENGAGED]: engaged });
  const options = await loadOptions();
  await sendToTab(tabId, { type: 'OPTIONS', payload: { options: options } }, 6000);
  return { ok: true };
}

async function disengageTab(tabId) {
  await ensureEngagedLoaded();
  if (engaged[String(tabId)]) {
    delete engaged[String(tabId)];
    await storageSet({ [STORE.ENGAGED]: engaged });
  }
}

function isEngaged(tabId) {
  if (typeof tabId !== 'number') return false;
  if (run && run.tabId === tabId && run.status === 'running') return true;
  const stamp = engaged[String(tabId)];
  if (!stamp) return false;
  return Date.now() - stamp < ENGAGE_TTL_MS;
}

// ------------------------------------------------------------------
// حماية النوافذ الجديدة (سكربت MAIN world)
// ------------------------------------------------------------------
const GUARD_ID = 'sahm-popup-guard';

async function applyPopupGuard(enabled) {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [GUARD_ID] });
    if (enabled && registered.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: GUARD_ID,
          matches: ['<all_urls>'],
          js: ['src/content/popup-guard.js'],
          runAt: 'document_start',
          allFrames: false,
          world: 'MAIN',
          persistAcrossSessions: true
        }
      ]);
    } else if (!enabled && registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [GUARD_ID] });
    }
  } catch (e) {
    /* نتجاهل: قد تكون الصفحة محمية أو السكربت مسجّلاً بالفعل */
  }
}

/** يحقن حارس النوافذ في تبويب مفتوح الآن (لأن document_start قد فات). */
async function injectGuardNow(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['src/content/popup-guard.js'],
      world: 'MAIN'
    });
  } catch (e) {
    /* بعض الصفحات (كروم-ويب ستور، صفحات الإضافة) ترفض الحقن */
  }
}

// ------------------------------------------------------------------
// حلقة السحب
// ------------------------------------------------------------------
function nextRunOptions(job) {
  const options = Object.assign({}, DEFAULT_OPTIONS, job.options || {});
  options.maxPages = Math.min(LIMITS.maxPagesHard, Math.max(1, parseInt(options.maxPages, 10) || 20));
  options.delayMs = Math.min(30000, Math.max(0, parseInt(options.delayMs, 10) || 0));
  options.waitMs = Math.min(60000, Math.max(1500, parseInt(options.waitMs, 10) || 9000));
  return options;
}

async function startRun(job, tabId) {
  if (!job || !tabId) return { ok: false, error: 'missing-input' };
  const options = nextRunOptions(job);
  job = normalizeJob(Object.assign({}, job, { options: options }));

  if (run && run.status === 'running') await stopRun('restart');

  if (!(await ensureContent(tabId))) {
    return { ok: false, error: 'no-content-script' };
  }

  await resetRows(job.id);
  run = newRun(job, tabId);
  await persistRun();
  await pushOptions(options);
  // حارس النوافذ الجديدة يعمل فقط أثناء السحب — لا نتدخّل في التصفّح العادي
  await applyPopupGuard(!!options.guardPopups);
  await injectGuardNow(tabId);

  broadcast('run:update', publicRun());
  log('بدء السحب — المجموعة: ' + (job.name || job.id));

  // الانتقال إلى رابط البداية إن كان مختلفاً عن الصفحة الحالية
  let currentUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url || '';
  } catch (e) {
    await stopRun('tab-closed');
    return { ok: false, error: 'tab-not-found' };
  }

  if (job.startUrl && normalizeUrl(job.startUrl) !== normalizeUrl(currentUrl)) {
    log('الانتقال إلى رابط البداية…');
    const waiter = armReady(tabId, 35000);
    try {
      await chrome.tabs.update(tabId, { url: job.startUrl });
    } catch (e) {
      settleWaiter(waiter, null);
      await finishRun('error', 'تعذّر فتح رابط البداية');
      return { ok: false, error: 'start-url-failed' };
    }
    await waiter.promise;
    await sleep(options.delayMs);
  }

  drive();
  return { ok: true };
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch (e) {
    return String(value || '');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ------------------------------------------------------------------
// وضع الصفحات المفصّلة: تنقّل، قراءة، رجوع
// ------------------------------------------------------------------
const DETAIL_PREFIX = 'detail_';

/** يضمن وجود كتلة «تفاصيل» مكتملة الشكل في المهمة. */
function normalizeJob(job) {
  const out = Object.assign({}, job);
  out.fields = out.fields || [];
  const detail = Object.assign(
    {
      enabled: false,
      linkSelector: '',
      containerSelector: '',
      fields: [],
      waitMs: 9000,
      maxItems: 0
    },
    out.detail || {}
  );
  detail.enabled = !!detail.enabled;
  detail.fields = detail.fields || [];
  detail.waitMs = Math.min(60000, Math.max(1500, parseInt(detail.waitMs, 10) || 9000));
  detail.maxItems = Math.max(0, parseInt(detail.maxItems, 10) || 0);
  out.detail = detail;
  return out;
}

/** حقول التفاصيل تُحفظ باسم مُسبَّق حتى لا تُطمس حقول القائمة. */
function prefixDetail(values) {
  const out = {};
  for (const key of Object.keys(values || {})) out[DETAIL_PREFIX + key] = values[key];
  return out;
}

/**
 * ينقل التبويب إلى رابط وينتظر جاهزية سكربت المحتوى فيه.
 * الجاهزية تُعلَن برسالة READY بعد كل تحميل كامل.
 *
 * تنبيه مهم: READY قد تصل من مستند سابق كان في طريقه (تنقّل معلّق)، فتوقظ
 * الانتظار قبل وصول الصفحة المطلوبة. لذلك نتحقق من رابط التبويب فعلياً بعد
 * كل READY، ونعيد المحاولة مرة واحدة إن لم يطابق — ثم نعتبر إعادة التوجيه
 * وصولاً ناجحاً (بعض المواقع تُعيد التوجيه إلى رابط مختلف).
 */
async function navigateAndWait(tabId, url, timeoutMs) {
  const limit = timeoutMs || 45000;

  for (let attempt = 0; attempt < 2; attempt++) {
    let current = '';
    try {
      current = (await chrome.tabs.get(tabId)).url || '';
    } catch (e) {
      return false;
    }
    if (normalizeUrl(current) === normalizeUrl(url)) return true;

    const waiter = armReady(tabId, limit);
    try {
      await chrome.tabs.update(tabId, { url: url });
    } catch (e) {
      settleWaiter(waiter, null);
      return false;
    }
    const ready = await waiter.promise;
    if (!ready) return false;

    try {
      const actual = (await chrome.tabs.get(tabId)).url || '';
      if (normalizeUrl(actual) === normalizeUrl(url)) return true;
      if (attempt === 1) return true; // أعاد الموقع التوجيه — نُكمل على ما وصل
    } catch (e) {
      return true;
    }
  }
  return true;
}

/**
 * يزحف إلى صفحة كل عنصر ويضمّ بياناتها إلى صف القائمة.
 * يُعيد { filled, failed } ويملأ rows الناتجة.
 */
async function crawlDetails(job, rows, links, listUrl) {
  const detail = job.detail;
  const links2 = links || [];
  // العدّادان تراكميان عبر صفحات القائمة، فلا تُصفّر الرحلة عند كل صفحة.
  const baseFilled = run.itemsFilled || 0;
  const baseFailed = run.itemsFailed || 0;
  let filled = baseFilled;
  let failed = baseFailed;

  run.itemTotal = rows.length;

  for (let index = 0; index < rows.length; index++) {
    if (!run || run.status !== 'running') break;
    const merged = Object.assign({}, rows[index]);
    const link = links2[index] || { href: '' };
    const capped = detail.maxItems > 0 && run.itemsCrawled >= detail.maxItems;
    let giveUp = false;

    if (link.href && !capped) {
      run.itemIndex = index + 1;
      run.itemsCrawled++;
      await persistRun();
      broadcast('run:update', publicRun());
      log('صفحة ' + run.page + ' — دخول العنصر ' + (index + 1) + '/' + rows.length + '…');

      const arrived = await navigateAndWait(run.tabId, link.href, 45000);
      if (!arrived) {
        failed++;
        log('تعذّر فتح صفحة العنصر رقم ' + (index + 1) + ' — نتخطّاه');
      } else {
        const result = await sendToTab(
          run.tabId,
          { type: 'DETAIL_EXTRACT', payload: { job: job } },
          detail.waitMs + 20000
        );
        if (result && result.ok) {
          Object.assign(merged, prefixDetail(result.values));
          // «نجاح» يعني وجود قيمة واحدة على الأقل، وإلا فالخطة لم تطابق الصفحة
          if (result.found > 0) {
            filled++;
          } else {
            failed++;
            log('لم أجد حقول التفاصيل في العنصر ' + (index + 1) + ' — نتخطّاه');
          }
        } else {
          failed++;
          log('تعذّر استخراج التفاصيل من العنصر ' + (index + 1) + ' — نتخطّاه');
        }
      }

      // العودة إلى القائمة لمواصلة العنصر التالي وللعثور على زر «التالي»
      const back = await navigateAndWait(run.tabId, listUrl, 45000);
      if (!back) {
        log('تعذّرت العودة إلى صفحة القائمة — إيقاف السحب');
        failed++;
        giveUp = true;
      }
    }

    // الصف يُحفظ دائماً (ببيانات القائمة وبما تيسّر من التفاصيل)
    run.itemsFilled = filled;
    run.itemsFailed = failed;
    await appendPage(run.jobId, run.page, [merged], run.seen, run.seenHashes);
    run.totalRows = run.seen.size;
    run.updatedAt = Date.now();
    broadcast('run:update', publicRun());
    if (giveUp) break;
  }

  return { filled: filled - baseFilled, failed: failed - baseFailed };
}

async function drive() {
  if (driving) return;
  driving = true;
  try {
    while (run && run.status === 'running') {
      if (Date.now() - run.startedAt > LIMITS.maxRuntimeMs) {
        await finishRun('timeout', 'تجاوز السحب الحد الزمني المسموح');
        break;
      }
      const job = await getJob(run.jobId);
      if (!job) {
        await finishRun('error', 'المجموعة غير موجودة');
        break;
      }
      const options = nextRunOptions(job);

      // 1) استخراج الصفحة الحالية
      const res = await sendToTab(run.tabId, { type: 'EXTRACT', payload: { job: job } }, options.waitMs + 25000);
      if (!run || run.status !== 'running') break;

      if (!res || !res.ok) {
        run.consecutiveErrors++;
        log('تعذّر قراءة الصفحة: ' + ((res && res.error) || 'خطأ غير معروف'));
        if (run.consecutiveErrors >= 2) {
          await finishRun('error', 'توقّف السحب: تعذّر استخراج البيانات');
          break;
        }
        await sleep(options.delayMs);
        continue;
      }
      run.consecutiveErrors = 0;
      run.page += 1;
      run.lastUrl = res.url || '';
      run.listUrl = res.url || '';

      // 2) تجميع الصفوف — وفي وضع التفاصيل نزحف إلى صفحة كل عنصر أولاً
      if (run.detailMode) {
        const summary = await crawlDetails(job, res.rows || [], res.links || [], run.listUrl);
        log(
          'صفحة ' + run.page + ': ' + summary.filled + ' عنصر بتفاصيل' +
            (summary.failed ? '، ' + summary.failed + ' فشل' : '')
        );
        if (!run || run.status !== 'running') break;
        // نُبقي res.snapshot كما هو: كُشِط من صفحة القائمة قبل الزحف،
        // وهو المرجع الصحيح لكشف «زر التالي لا يتقدّم».
      } else {
        const added = await appendPage(run.jobId, run.page, res.rows || [], run.seen, run.seenHashes);
        run.totalRows = run.seen.size;
        log('صفحة ' + run.page + ': استُخرج ' + (res.itemCount || 0) + ' عنصراً — جديد ' + added);
      }

      // 3) كشف التوقّف (زر لا يتقدّم فعلياً)
      const snapshot = JSON.stringify((res.snapshot && res.snapshot.sample) || '');
      if (run.page > 1 && snapshot === run.lastSnapshot) {
        run.stalled++;
        if (run.stalled >= 2) {
          await finishRun('stalled', 'الصفحات متطابقة — يبدو أن زر «التالي» لا يتقدّم');
          break;
        }
      } else {
        run.stalled = 0;
      }
      run.lastSnapshot = snapshot;

      run.consecutiveEmpty = (res.itemCount || 0) === 0 ? run.consecutiveEmpty + 1 : 0;
      if (run.consecutiveEmpty >= 2) {
        await finishRun('empty', 'صفحتان فارغتان متتاليتان');
        break;
      }

      await persistRun();
      broadcast('run:update', publicRun());

      // 4) شروط التوقف
      if (run.page >= options.maxPages) {
        await finishRun('max-pages', 'تم الوصول إلى الحد الأقصى للصفحات (' + options.maxPages + ')');
        break;
      }
      if (!res.pagination || !res.pagination.hasNext) {
        if (options.autoScroll && run.page === 1) {
          log('لا يوجد زر «التالي» — محاولة التمرير اللانهائي…');
          await sendToTab(run.tabId, { type: 'SCROLL_LOAD', payload: { steps: 10 } }, 60000);
          continue;
        }
        await finishRun('no-next', 'لا توجد صفحة تالية');
        break;
      }
      // حلقة حقيقية = العودة إلى رابط زاره سابقاً (وليس رابطاً ثابتاً مع تنقّل داخلي)
      const previousUrl = run.visitedUrls.length ? run.visitedUrls[run.visitedUrls.length - 1] : '';
      if (res.url && res.url !== previousUrl && run.visitedUrls.indexOf(res.url) !== -1) {
        await finishRun('loop', 'عادت الصفحة إلى رابط زارته سابقاً');
        break;
      }
      if (res.url) run.visitedUrls.push(res.url);

      // 5) الانتقال
      const waiter = armReady(run.tabId, 40000);
      let clicked = null;
      try {
        clicked = await sendToTab(run.tabId, { type: 'CLICK_NEXT', payload: { job: job } }, 20000);
      } catch (e) {
        clicked = { ok: false, error: String(e) };
      }
      if (!run || run.status !== 'running') {
        waiter.cancel();
        break;
      }
      if (!clicked || !clicked.ok) {
        waiter.cancel();
        await finishRun('no-next', 'تعذّر النقر على زر «التالي»' + (clicked && clicked.reason ? ' (' + clicked.reason + ')' : ''));
        break;
      }
      log('الانتقال إلى الصفحة ' + (run.page + 1) + '…');

      if (clicked.samePageExpected) {
        // تغيير داخل نفس المستند: ننتظر ثم نعيد الاستخراج
        waiter.cancel();
        await sleep(Math.max(options.delayMs, 900));
      } else {
        const ready = await waiter.promise;
        if (!ready) log('تحذير: تأخّر تحميل الصفحة التالية');
        await sleep(options.delayMs);
      }
    }
  } catch (error) {
    await finishRun('error', 'خطأ غير متوقع: ' + String((error && error.message) || error));
  } finally {
    driving = false;
  }
}

async function finishRun(reason, message) {
  if (!run) return;
  if (run.status === 'done' || run.status === 'error' || run.status === 'stopped') return;
  run.status = reason === 'error' ? 'error' : 'done';
  run.reason = reason;
  run.error = reason === 'error' ? message || '' : '';
  run.updatedAt = Date.now();
  log((reason === 'error' ? 'توقّف بخطأ: ' : 'انتهى السحب: ') + (message || reason) + ' — المجموع ' + run.totalRows + ' صف');
  await persistRun();
  broadcast('run:update', publicRun());
  await sendToTab(run.tabId, { type: 'RUN_STATUS', payload: { running: false } }, 5000);
  await applyPopupGuard(false);
}

async function stopRun(reason) {
  if (!run) return { ok: true };
  run.status = 'stopped';
  run.reason = reason || 'stopped';
  run.updatedAt = Date.now();
  log('أُوقف السحب يدوياً — المجموع ' + run.totalRows + ' صف');
  await persistRun();
  broadcast('run:update', publicRun());
  await sendToTab(run.tabId, { type: 'RUN_STATUS', payload: { running: false } }, 5000);
  await applyPopupGuard(false);
  return { ok: true };
}

// ------------------------------------------------------------------
// المشاريع
// ------------------------------------------------------------------
async function getJobs() {
  const data = await storageGet(STORE.JOBS);
  return Array.isArray(data[STORE.JOBS]) ? data[STORE.JOBS] : [];
}

async function getJob(jobId) {
  const jobs = await getJobs();
  return jobs.find((job) => job.id === jobId) || null;
}

async function saveJob(job) {
  if (!job || !job.id) return { ok: false, error: 'missing-job' };
  job = normalizeJob(job);
  const jobs = await getJobs();
  const index = jobs.findIndex((item) => item.id === job.id);
  job.updatedAt = Date.now();
  if (index === -1) jobs.push(job);
  else jobs[index] = job;
  await storageSet({ [STORE.JOBS]: jobs, [STORE.CURRENT_JOB]: job.id });
  return { ok: true, job: job };
}

async function deleteJob(jobId) {
  const jobs = (await getJobs()).filter((job) => job.id !== jobId);
  await storageSet({ [STORE.JOBS]: jobs });
  await resetRows(jobId);
  return { ok: true, jobs: jobs };
}

// ------------------------------------------------------------------
// الرسائل
// ------------------------------------------------------------------
const handlers = {
  'panel:getState': async () => {
    const jobs = await getJobs();
    const data = await storageGet([STORE.CURRENT_JOB, STORE.RUN]);
    const options = await loadOptions();

    // تنظيف تشغيل يتيم: التبويب أُغلق أثناء العمل
    if (data[STORE.RUN] && data[STORE.RUN].status === 'running') {
      if (!run) {
        run = Object.assign({}, data[STORE.RUN], {
          seen: new Set(data[STORE.RUN].seenHashes || []),
          seenHashes: data[STORE.RUN].seenHashes || [],
          log: []
        });
      }
      let alive = true;
      try {
        await chrome.tabs.get(run.tabId);
      } catch (e) {
        alive = false;
      }
      if (!alive) await stopRun('tab-closed');
    }

    return {
      ok: true,
      jobs: jobs,
      currentJobId: data[STORE.CURRENT_JOB] || (jobs[0] && jobs[0].id) || null,
      run: publicRun(),
      options: options
    };
  },

  'panel:saveJob': async (payload) => saveJob(payload.job),

  'panel:deleteJob': async (payload) => {
    const result = await deleteJob(payload.jobId);
    return result;
  },

  'panel:clearRows': async (payload) => {
    await resetRows(payload.jobId);
    return { ok: true };
  },

  'panel:readRows': async (payload) => {
    const rows = await readRows(payload.jobId, payload.limit);
    return { ok: true, rows: rows, truncated: typeof payload.limit === 'number' && rows.length >= payload.limit };
  },

  'panel:rowCount': async (payload) => {
    const data = await storageGet(ROWS_KEY(payload.jobId));
    const index = data[ROWS_KEY(payload.jobId)];
    return { ok: true, total: index ? index.total : 0 };
  },

  'panel:options': async (payload) => {
    const options = Object.assign({}, await loadOptions(), payload.options || {});
    await storageSet({ [STORE.OPTIONS]: options });
    await pushOptions(options);
    broadcast('options:update', options);
    return { ok: true, options: options };
  },

  'panel:pick': async (payload) => {
    if (!(await ensureContent(payload.tabId))) return { ok: false, error: 'no-content-script' };
    const result = await sendToTab(
      payload.tabId,
      {
        type: 'PICK_START',
        payload: { mode: payload.mode, target: payload.target || 'list', job: payload.job }
      },
      15000
    );
    return { ok: !!(result && result.ok), error: result && result.error };
  },

  'panel:stopPick': async (payload) => {
    const result = await sendToTab(payload.tabId, { type: 'PICK_STOP', payload: {} }, 8000);
    return { ok: !!(result && result.ok) };
  },

  'panel:hilite': async (payload) => {
    const result = await sendToTab(payload.tabId, { type: 'HILITE', payload: { selector: payload.selector } }, 8000);
    return { ok: !!(result && result.ok) };
  },

  // يفتح صفحة أول عنصر في القائمة حتى يلتقط المستخدم حقول التفاصيل هناك
  'panel:gotoFirstItem': async (payload) => {
    const job = normalizeJob(payload.job || {});
    if (!(await ensureContent(payload.tabId))) return { ok: false, error: 'no-content-script' };
    const result = await sendToTab(payload.tabId, { type: 'EXTRACT', payload: { job: job } }, 30000);
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || 'extract-failed' };
    const links = (result.links || []).filter((link) => link.href);
    if (!links.length) return { ok: false, error: 'no-links' };
    const ok = await navigateAndWait(payload.tabId, links[0].href, 45000);
    return { ok: ok, error: ok ? '' : 'nav-failed', href: links[0].href, total: links.length };
  },

  'panel:probe': async (payload) => {
    // اختبار سريع على الصفحة الحالية دون تنقّل
    const job = normalizeJob(payload.job);
    if (!(await ensureContent(payload.tabId))) return { ok: false, error: 'no-content-script' };
    await resetRows(job.id);
    const result = await sendToTab(payload.tabId, { type: 'EXTRACT', payload: { job: job } }, 30000);
    if (!result || !result.ok) {
      return { ok: false, error: (result && result.error) || 'extract-failed' };
    }
    const seen = new Set();
    const hashes = [];
    const added = await appendPage(job.id, 1, result.rows || [], seen, hashes);
    return {
      ok: true,
      added: added,
      itemCount: result.itemCount || 0,
      linkCount: (result.links || []).filter((link) => link.href).length,
      detailMode: !!(job.detail && job.detail.enabled),
      pagination: result.pagination,
      url: result.url
    };
  },

  'panel:startRun': async (payload) => {
    const job = payload.job;
    const saved = await saveJob(job);
    if (!saved.ok) return saved;
    return startRun(job, payload.tabId);
  },

  'panel:stopRun': async () => stopRun('user'),

  'panel:engage': async (payload) => engageTab(payload.tabId),

  'panel:disengage': async (payload) => {
    await disengageTab(payload.tabId);
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message) return false;

  // رسائل من سكربت المحتوى
  if (message.from === 'cs') {
    if (message.type === 'READY') {
      const tabId = sender.tab && sender.tab.id;
      if (typeof tabId === 'number') settleReadyFor(tabId, message.payload || {});
      if (run && run.status === 'running' && run.tabId === tabId) {
        setTimeout(() => drive(), 300);
      }
      Promise.resolve()
        .then(async () => {
          await ensureEngagedLoaded();
          if (typeof tabId !== 'number' || !isEngaged(tabId)) return { options: null };
          const options = await loadOptions();
          // نطبّق أيضاً خيارات التشغيل الجاري إن وُجدت
          if (run && run.tabId === tabId) {
            const job = await getJob(run.jobId);
            if (job) return { options: nextRunOptions(job) };
          }
          return { options: options };
        })
        .then((result) => respond(result))
        .catch(() => respond({ options: null }));
      return true;
    }

    if (message.type === 'PICK_RESULT') {
      broadcast('pick:result', message.payload || {});
      respond({ ok: true });
      return false;
    }
    return false;
  }

  // رسائل من اللوحة
  if (message.from !== 'panel') return false;
  const handler = handlers[message.type];
  if (!handler) {
    respond({ ok: false, error: 'unknown-message:' + message.type });
    return false;
  }
  Promise.resolve()
    .then(() => handler(message.payload || {}))
    .then((result) => respond(result || { ok: true }))
    .catch((error) => respond({ ok: false, error: String((error && error.message) || error) }));
  return true;
});

// ------------------------------------------------------------------
// أحداث الإضافة
// ------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  loadOptions().then(pushOptions);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (run && run.tabId === tabId) stopRun('tab-closed');
  disengageTab(tabId);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
