/* ------------------------------------------------------------------
 * صهم — src/ui/panel.js
 * منطق اللوحة الجانبية: تحرير المجموعة، الالتقاط، التشغيل، التصدير.
 * ------------------------------------------------------------------ */
'use strict';

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

const TYPE_OPTIONS = [
  { value: 'text', label: 'نص' },
  { value: 'href', label: 'رابط' },
  { value: 'image', label: 'صورة' },
  { value: 'number', label: 'رقم' },
  { value: 'src', label: 'وسيط (src)' },
  { value: 'datetime', label: 'تاريخ' },
  { value: 'attr', label: 'خاصية' },
  { value: 'html', label: 'HTML' },
  { value: 'list', label: 'قائمة قيم' }
];

const REASON_TEXT = {
  'max-pages': 'الوصول إلى الحد الأقصى للصفحات',
  'no-next': 'لا توجد صفحة تالية',
  loop: 'اكتُشفت حلقة في التنقّل',
  stalled: 'زر «التالي» لا يتقدّم',
  empty: 'صفحات فارغة متتالية',
  timeout: 'تجاوز الحد الزمني',
  error: 'خطأ',
  user: 'إيقاف يدوي',
  'tab-closed': 'أُغلق التبويب',
  restart: 'إعادة تشغيل'
};

const $ = (id) => document.getElementById(id);

const state = {
  jobs: [],
  job: null,
  run: null,
  options: Object.assign({}, DEFAULT_OPTIONS),
  rows: [],
  totalRows: 0,
  activeTab: null,
  picking: false,
  pickSource: '',
  detailSample: {},
  saveTimer: null
};

// ------------------------------------------------------------------
// أدوات عامة
// ------------------------------------------------------------------
function uid(prefix) {
  return (prefix || 'job') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function send(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ from: 'panel', type: type, payload: payload || {} }, (response) => {
        const error = chrome.runtime.lastError;
        resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: 'no-response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

let toastTimer = null;
function toast(message, isError) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('error', !!isError);
  box.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3200);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function newJob() {
  return {
    id: uid('job'),
    name: 'مجموعة ' + (state.jobs.length + 1),
    startUrl: state.activeTab ? state.activeTab.url || '' : '',
    parentSelector: '',
    itemSignature: null,
    itemSelector: '',
    fields: [],
    detail: newDetail(),
    pagination: { selector: '', label: '', maxPages: 20 },
    options: Object.assign({}, state.options),
    createdAt: Date.now()
  };
}

/** كتلة «صفحة العنصر» — الشكل نفسه المتوقّع في الخلفية. */
function newDetail(overrides) {
  return Object.assign(
    {
      enabled: false,
      linkSelector: '',
      containerSelector: '',
      fields: [],
      waitMs: 9000,
      maxItems: 0
    },
    overrides || {}
  );
}

/** يضمن وجود كتلة التفاصيل في أي مهمة قادمة من التخزين. */
function ensureDetail(job) {
  if (!job) return job;
  job.detail = newDetail(job.detail);
  job.fields = job.fields || [];
  return job;
}

/** المفتاح الذي يُحفظ به حقل التفاصيل داخل الصف النهائي. */
function detailKey(name) {
  return 'detail_' + name;
}

// ------------------------------------------------------------------
// العرض
// ------------------------------------------------------------------
function renderJobPicker() {
  const select = $('jobSelect');
  const saved = state.jobs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const inList = saved.some((job) => job.id === state.job.id);
  const parts = [];
  if (!inList) parts.push('<option value="' + state.job.id + '">(مسودة) ' + escapeHtml(state.job.name) + '</option>');
  for (const job of saved) {
    parts.push(
      '<option value="' + job.id + '">' + escapeHtml(job.name || 'بدون اسم') + '</option>'
    );
  }
  select.innerHTML = parts.join('');
  select.value = state.job.id;
}

function renderForm() {
  const job = state.job;
  if (document.activeElement !== $('jobName')) $('jobName').value = job.name || '';
  if (document.activeElement !== $('startUrl')) $('startUrl').value = job.startUrl || '';
  if (document.activeElement !== $('nextSelector')) $('nextSelector').value = (job.pagination && job.pagination.selector) || '';
  if (document.activeElement !== $('maxPages')) $('maxPages').value = job.pagination.maxPages || 20;

  const detail = job.detail || newDetail();
  $('detailEnabled').checked = !!detail.enabled;
  if (document.activeElement !== $('detailLinkSelector')) $('detailLinkSelector').value = detail.linkSelector || '';
  if (document.activeElement !== $('detailMaxItems')) $('detailMaxItems').value = detail.maxItems || 0;
  $('detailBody').hidden = !detail.enabled;

  const o = job.options || DEFAULT_OPTIONS;
  $('optKillPopups').checked = !!o.killPopups;
  $('optGuardPopups').checked = !!o.guardPopups;
  $('optBlockAds').checked = !!o.blockAds;
  $('optClickClose').checked = !!o.clickClose;
  $('optAutoScroll').checked = !!o.autoScroll;
  if (document.activeElement !== $('delayMs')) $('delayMs').value = o.delayMs;

  const tabHint = state.activeTab
    ? 'التبويب النشط: ' + (state.activeTab.title || state.activeTab.url || '')
    : 'لا يوجد تبويب نشط.';
  $('tabHint').textContent = tabHint.length > 90 ? tabHint.slice(0, 90) + '…' : tabHint;
}

function renderFields() {
  renderFieldList('fieldsList', 'list');
  renderDetailFields();
  renderLearned();
  renderRun();
}

/** مربّع «القاعدة المكتشفة» لقائمة العناصر. */
function renderLearned() {
  const learned = $('learnedBox');
  if (state.job.parentSelector) {
    learned.hidden = false;
    $('learnedSelector').textContent = state.job.itemSelector || state.job.parentSelector;
    const count = state.job.rowCount != null ? state.job.rowCount : state.job.itemCount;
    $('learnedCount').textContent = count != null ? count + ' صف متشابه' : '—';
  } else {
    learned.hidden = true;
  }
}

function renderDetailFields() {
  const detail = state.job.detail || newDetail();
  const body = $('detailBody');
  if (body) body.hidden = !detail.enabled;
  $('detailFieldsList').hidden = !detail.enabled;
  renderFieldList('detailFieldsList', 'detail');
}

/** يعرض مجموعة حقول (القائمة أو التفاصيل) بنفس المحرّر. */
function cardSlot(card) {
  const group = card.dataset.group === 'detail' ? 'detail' : 'list';
  const index = Number(card.dataset.index);
  const fields = group === 'detail' ? (state.job.detail.fields = state.job.detail.fields || []) : state.job.fields;
  return { group: group, index: index, fields: fields, field: fields[index] };
}

function renderFieldList(containerId, group) {
  const list = $(containerId);
  if (!list) return;
  const fields = group === 'detail' ? (state.job.detail && state.job.detail.fields) || [] : state.job.fields || [];
  const emptyText =
    group === 'detail'
      ? 'لا حقول تفاصيل بعد — افتح صفحة عنصر ثم اضغط «التقاط حقول التفاصيل».'
      : 'لا حقول بعد — اضغط «التقاط حقل» وانقر على عنصر في الصفحة.';

  if (!fields.length) {
    list.innerHTML = '<div class="empty">' + emptyText + '</div>';
    return;
  }

  list.innerHTML = fields
    .map((field, index) => {
      const typeOptions = TYPE_OPTIONS.map(
        (option) =>
          '<option value="' + option.value + '"' + (field.type === option.value ? ' selected' : '') + '>' +
          option.label +
          '</option>'
      ).join('');
      const needsAttr = field.type === 'attr' || field.type === 'src';
      const needsSep = field.type === 'list';
      const sample = sampleFor(index, group);
      const missing = field.missing
        ? '<span class="missing">مفقود في ' + field.missing + ' صف</span>'
        : '';
      return [
        '<div class="field" data-index="' + index + '" data-group="' + group + '">',
        '  <div class="field-head">',
        '    <input class="f-name" type="text" value="' + escapeHtml(field.name) + '" aria-label="اسم الحقل">',
        '    <select class="f-type" aria-label="نوع الحقل">' + typeOptions + '</select>',
        '    <button class="icon-btn f-hilite" type="button" title="إبراز هذا الحقل في الصفحة">◎</button>',
        '    <button class="icon-btn danger f-del" type="button" title="حذف الحقل">✕</button>',
        '  </div>',
        '  <input class="f-sel" type="text" dir="ltr" value="' + escapeHtml(field.selector || '') + '" aria-label="محدد CSS للحقل">',
        needsAttr
          ? '  <input class="f-attr" type="text" dir="ltr" style="margin-top:6px" value="' +
            escapeHtml(field.attr || '') +
            '" placeholder="اسم الخاصية، مثال: data-src" aria-label="اسم الخاصية">'
          : '',
        needsSep
          ? '  <input class="f-sep" type="text" style="margin-top:6px" value="' +
            escapeHtml(field.separator || ' | ') +
            '" placeholder="فاصل القيم" aria-label="فاصل القيم">'
          : '',
        '  <div class="field-foot">',
        '    <span class="sample">' + (sample ? 'مثال: ' + escapeHtml(sample) : 'لا عيّنة بعد') + '</span>',
        '    ' + missing,
        '  </div>',
        '</div>'
      ].join('');
    })
    .join('');
}

function sampleFor(index, group) {
  const field =
    group === 'detail' ? state.job.detail.fields[index] : state.job.fields[index];
  if (!field) return '';
  let value;
  if (group === 'detail') {
    value = state.detailSample ? state.detailSample[field.name] : '';
  } else if (state.rows.length) {
    value = state.rows[0][field.name];
  }
  if (value == null || value === '') return '';
  return String(value).length > 40 ? String(value).slice(0, 40) + '…' : String(value);
}

/** أعمدة المعاينة: حقول القائمة ثم حقول التفاصيل (بمفتاحها المُسبَّق). */
function previewColumns() {
  const columns = [];
  for (const field of state.job.fields || []) {
    if (field.name) columns.push({ title: field.name, key: field.name });
  }
  for (const field of (state.job.detail && state.job.detail.fields) || []) {
    if (field.name) columns.push({ title: detailKey(field.name), key: detailKey(field.name) });
  }
  return columns;
}

function renderPreview(rows) {
  const wrap = $('previewWrap');
  const columns = previewColumns();
  if (!rows || !rows.length || !columns.length) {
    wrap.innerHTML = '<div class="empty" style="margin:8px">لا معاينة بعد.</div>';
    return;
  }
  const head = columns.map((column) => '<th>' + escapeHtml(column.title) + '</th>').join('');
  const body = rows
    .slice(0, 100)
    .map((row) => {
      const cells = columns
        .map((column) => {
          const value = row[column.key];
          const isUrl = typeof value === 'string' && /^https?:\/\//i.test(value);
          return '<td class="' + (isUrl ? 'ltr' : '') + '" title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</td>';
        })
        .join('');
      return '<tr>' + cells + '</tr>';
    })
    .join('');
  wrap.innerHTML = '<table class="preview"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
}

function renderStats(total) {
  const fields = (state.job.fields || []).length;
  const detail = state.job.detail || newDetail();
  const detailFields = detail.enabled ? (detail.fields || []).length : 0;
  const rows = state.rows.length;
  if (typeof total === 'number') state.totalRows = total;
  const totalRows = state.totalRows || 0;
  const parts = [
    '<span class="stat">حقول القائمة <b>' + fields + '</b></span>',
    '<span class="stat">حقول التفاصيل <b>' + detailFields + '</b></span>',
    '<span class="stat">الصفوف المسحوبة <b>' + totalRows + '</b></span>',
    '<span class="stat">المعاينة <b>' + rows + '</b></span>'
  ];
  $('stats').innerHTML = parts.join('');
}

function renderRun() {
  if (!state.job) return;
  const run = state.run;
  const running = !!run && run.status === 'running';
  const max = (state.job.pagination && state.job.pagination.maxPages) || 20;

  $('runBtn').disabled = running || !canRun();
  $('probeBtn').disabled = running || !canRun();
  $('stopRunBtn').hidden = !running;

  if (!run) {
    $('progressBar').style.width = '0%';
    $('progressText').textContent = 'جاهز.';
    return;
  }

  $('progressBar').style.width = Math.min(100, Math.round((run.page / max) * 100)) + '%';
  if (running) {
    let text = 'جارٍ السحب — صفحة ' + run.page + ' من ' + max + ' · ' + run.totalRows + ' صف';
    if (run.detailMode) {
      text +=
        ' · العنصر ' + (run.itemIndex || 0) + ' من ' + (run.itemTotal || 0) +
        (run.itemsFailed ? ' (فشل ' + run.itemsFailed + ')' : '');
    }
    $('progressText').textContent = text;
  } else {
    const reason = REASON_TEXT[run.reason] || run.reason || '';
    const detail = run.error ? ' — ' + run.error : '';
    $('progressText').textContent =
      (run.status === 'error' ? 'توقّف بخطأ' : 'انتهى') +
      (reason ? ': ' + reason : '') +
      detail +
      ' · المجموع ' + run.totalRows + ' صف' +
      (run.detailMode && run.itemsFilled
        ? ' (بتفاصيل ' + run.itemsFilled + (run.itemsFailed ? '، فشل ' + run.itemsFailed : '') + ')'
        : '');
  }
}

function appendLog(text) {
  const box = $('logBox');
  if (!text) return;
  const prefix = new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  box.textContent += '[' + prefix + '] ' + text + '\n';
  if (box.textContent.length > 12000) box.textContent = box.textContent.slice(-8000);
  box.scrollTop = box.scrollHeight;
}

function setPicking(active, source) {
  state.picking = active;
  state.pickSource = active ? source || 'field' : '';

  const fieldBtn = $('pickFieldBtn');
  const isField = active && state.pickSource === 'field';
  fieldBtn.classList.toggle('picking', isField);
  fieldBtn.textContent = isField ? 'الالتقاط مُفعّل ●' : 'التقاط حقل ●';

  const detailBtn = $('pickDetailBtn');
  if (detailBtn) {
    const isDetail = active && state.pickSource === 'detail';
    detailBtn.classList.toggle('picking', isDetail);
    detailBtn.textContent = isDetail ? 'الالتقاط مُفعّل ●' : 'التقاط حقول التفاصيل ●';
  }

  const linkBtn = $('pickLinkBtn');
  if (linkBtn) {
    const isLink = active && state.pickSource === 'link';
    linkBtn.classList.toggle('picking', isLink);
    linkBtn.textContent = isLink ? 'الالتقاط مُفعّل ●' : 'التقاط رابط الدخول ●';
  }

  $('stopPickBtn').hidden = !active;
}

function canRun() {
  return runBlockReason() === '';
}

/** سبب تعطيل زر البدء — رسالة واضحة بدل زر صامت. */
function runBlockReason() {
  const job = state.job;
  if (!job.parentSelector || !(job.fields || []).length) {
    return 'التقط حقل بيانات واحداً على الأقل من صف القائمة';
  }
  if (job.detail && job.detail.enabled && !(job.detail.fields || []).length) {
    return 'فعّلت الدخول إلى صفحة العنصر — التقط حقول التفاصيل أولاً';
  }
  return '';
}

// ------------------------------------------------------------------
// حفظ / تحميل
// ------------------------------------------------------------------
function scheduleSave() {
  if (!canRun()) return;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveJob(true), 800);
}

async function saveJob(silent) {
  if (!state.job) return;
  const result = await send('panel:saveJob', { job: state.job });
  if (!result.ok) {
    if (!silent) toast('تعذّر الحفظ: ' + (result.error || ''), true);
    return;
  }
  const exists = state.jobs.some((job) => job.id === state.job.id);
  if (!exists) state.jobs.push(state.job);
  else state.jobs = state.jobs.map((job) => (job.id === state.job.id ? state.job : job));
  renderJobPicker();
  if (!silent) toast('تم حفظ المجموعة');
}

async function loadJob(jobId) {
  const found = state.jobs.find((job) => job.id === jobId);
  if (!found) return;
  state.job = ensureDetail(JSON.parse(JSON.stringify(found)));
  state.job.options = Object.assign({}, DEFAULT_OPTIONS, state.job.options || {});
  state.job.fields = state.job.fields || [];
  state.rows = [];
  state.detailSample = {};
  renderJobPicker();
  renderForm();
  renderFields();
  renderPreview([]);
  await refreshRows(true);
}

async function refreshRows(preview) {
  const countResult = await send('panel:rowCount', { jobId: state.job.id });
  const total = countResult.ok ? countResult.total : 0;
  if (preview) {
    const result = await send('panel:readRows', { jobId: state.job.id, limit: 100 });
    state.rows = result.ok ? result.rows || [] : [];
  } else {
    state.rows = [];
  }
  state.totalRows = total;
  renderStats(total);
  if (preview) {
    renderPreview(state.rows);
    renderFields();
  }
}

// ------------------------------------------------------------------
// الالتقاط
// ------------------------------------------------------------------
function explainError(error) {
  if (error === 'no-content-script') {
    return 'لا يمكن العمل على هذه الصفحة (صفحات النظام، متجر كروم، أو صفحة الإضافة نفسها ممنوعة).';
  }
  if (error === 'timeout') return 'انتهت مهلة الاتصال بالصفحة.';
  return error ? String(error) : 'خطأ غير معروف';
}

async function startPick(mode, target) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    toast('لا يوجد تبويب نشط للالتقاط منه', true);
    return;
  }
  state.activeTab = tab;
  await send('panel:engage', { tabId: tab.id });
  setPicking(true, target === 'detail' ? 'detail' : mode);
  const result = await send('panel:pick', {
    mode: mode,
    target: target || 'list',
    job: state.job,
    tabId: tab.id
  });
  if (!result.ok) {
    setPicking(false);
    toast('تعذّر بدء الالتقاط: ' + explainError(result.error), true);
  }
}

function applyLearned(learned) {
  if (!learned) return;
  const previous = new Map((state.job.fields || []).map((field) => [field.name, field]));
  const merged = (learned.fields || []).map((field) => {
    const old = previous.get(field.name);
    if (!old) return field;
    return Object.assign({}, old, {
      selector: field.selector || old.selector,
      path: field.path || old.path,
      missing: field.missing
    });
  });
  for (const field of state.job.fields || []) {
    if (!merged.some((item) => item.name === field.name)) merged.push(field);
  }
  state.job.fields = merged;
  if (learned.parentSelector) state.job.parentSelector = learned.parentSelector;
  if (learned.itemSignature) state.job.itemSignature = learned.itemSignature;
  if (learned.itemSelector) state.job.itemSelector = learned.itemSelector;
  state.job.itemCount = learned.itemCount;
  state.job.rowCount = learned.rowCount;
  if (learned.preview) {
    state.rows = learned.preview;
  }
}

function detailFieldList() {
  return (state.job.detail && state.job.detail.fields) || [];
}

function applyLearnedDetail(learned) {
  if (!learned) return;
  const detail = state.job.detail;
  const previous = new Map((detail.fields || []).map((field) => [field.name, field]));
  const merged = (learned.fields || []).map((field) => {
    const old = previous.get(field.name);
    if (!old) return field;
    return Object.assign({}, old, {
      selector: field.selector || old.selector,
      path: field.path || old.path
    });
  });
  for (const field of detail.fields || []) {
    if (!merged.some((item) => item.name === field.name)) merged.push(field);
  }
  detail.fields = merged;
  if (learned.containerSelector) detail.containerSelector = learned.containerSelector;
  const sample = (learned.preview && learned.preview[0]) || {};
  state.detailSample = Object.assign({}, state.detailSample || {}, sample);
}

function handlePickResult(payload) {
  if (!payload) return;

  if (payload.mode === 'cancel') {
    setPicking(false);
    return;
  }

  if (payload.mode === 'link') {
    state.job.detail = state.job.detail || newDetail();
    state.job.detail.linkSelector = payload.link.selector || '';
    state.job.detail.linkLabel = payload.link.label || '';
    state.job.detail.enabled = true;
    renderForm();
    renderDetailFields();
    renderRun();
    renderStats();
    toast(
      'تم التقاط رابط الدخول: ' +
        (payload.link.label || payload.link.selector) +
        (payload.link.relativeToRow ? ' (نسبةً إلى الصف)' : '')
    );
    scheduleSave();
    return;
  }

  if (payload.mode === 'field' && payload.target === 'detail') {
    if (payload.learned) {
      applyLearnedDetail(payload.learned);
    } else if (payload.field && !detailFieldList().some((field) => field.name === payload.field.name)) {
      state.job.detail.fields.push(payload.field);
    }
    renderDetailFields();
    renderRun();
    renderStats();
    scheduleSave();
    return;
  }

  if (payload.mode === 'field') {
    if (payload.learned) {
      applyLearned(payload.learned);
    } else if (payload.field && !state.job.fields.some((field) => field.name === payload.field.name)) {
      state.job.fields.push(payload.field);
    }
    renderFields();
    renderPreview(state.rows);
    renderStats();
    scheduleSave();
    return;
  }

  if (payload.mode === 'next') {
    state.job.pagination = Object.assign({}, state.job.pagination, {
      selector: payload.pagination.selector,
      label: payload.pagination.label
    });
    renderForm();
    toast('تم التقاط زر «التالي»: ' + (payload.pagination.label || payload.pagination.selector));
    scheduleSave();
    return;
  }

  if (payload.mode === 'container') {
    if (payload.learned) applyLearned(payload.learned);
    if (payload.container) {
      state.job.parentSelector = payload.container.parentSelector || state.job.parentSelector;
      state.job.itemSignature = payload.container.itemSignature || state.job.itemSignature;
      state.job.itemSelector = payload.container.itemSelector || state.job.itemSelector;
    }
    renderFields();
    renderPreview(state.rows);
    renderStats();
    toast('تم تحديث الصف المتكرّر: ' + (state.job.rowCount != null ? state.job.rowCount + ' صف' : ''));
    scheduleSave();
  }
}

// ------------------------------------------------------------------
// التصدير
// ------------------------------------------------------------------
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv(rows) {
  const fields = state.job.fields.filter((field) => field.name);
  const header = fields.map((field) => csvCell(field.name)).join(',');
  const lines = rows.map((row) => fields.map((field) => csvCell(row[field.name])).join(','));
  // BOM ليفتح Excel العربية النص بترميز صحيح
  return '\uFEFF' + [header].concat(lines).join('\r\n');
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeName() {
  const base = (state.job.name || 'sahm').replace(/[\\/:*?"<>|]+/g, '-').trim();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return (base || 'sahm') + '-' + stamp;
}

async function fetchAllRows() {
  const result = await send('panel:readRows', { jobId: state.job.id });
  if (!result.ok) {
    toast('تعذّر قراءة النتائج: ' + (result.error || ''), true);
    return null;
  }
  return result.rows || [];
}

// ------------------------------------------------------------------
// الأحداث
// ------------------------------------------------------------------
function bindEvents() {
  $('jobName').addEventListener('input', () => {
    state.job.name = $('jobName').value;
    renderJobPicker();
    scheduleSave();
  });

  $('startUrl').addEventListener('input', () => {
    state.job.startUrl = $('startUrl').value.trim();
    scheduleSave();
  });

  $('useCurrentBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) return;
    state.activeTab = tab;
    state.job.startUrl = tab.url || '';
    renderForm();
    await send('panel:engage', { tabId: tab.id });
    scheduleSave();
  });

  $('jobSelect').addEventListener('change', () => loadJob($('jobSelect').value));

  $('newJobBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    state.activeTab = tab;
    state.job = newJob();
    state.rows = [];
    state.detailSample = {};
    renderJobPicker();
    renderForm();
    renderFields();
    renderPreview([]);
    renderStats(0);
    $('logBox').textContent = '';
    toast('مجموعة جديدة — ابدأ بالتقاط الحقول');
  });

  $('delJobBtn').addEventListener('click', async () => {
    const saved = state.jobs.some((job) => job.id === state.job.id);
    if (!saved) {
      toast('المجموعة الحالية غير محفوظة بعد');
      return;
    }
    if (!confirm('حذف المجموعة «' + (state.job.name || '') + '» وكل بياناتها؟')) return;
    const result = await send('panel:deleteJob', { jobId: state.job.id });
    if (result.ok) {
      state.jobs = result.jobs || [];
      toast('تم حذف المجموعة');
      const tab = await activeTab();
      state.activeTab = tab;
      state.job = newJob();
      state.rows = [];
      state.detailSample = {};
      renderJobPicker();
      renderForm();
      renderFields();
      renderPreview([]);
      renderStats(0);
    }
  });

  // -------- الحقول
  $('pickFieldBtn').addEventListener('click', () => startPick('field'));
  $('stopPickBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    if (tab) await send('panel:stopPick', { tabId: tab.id });
    setPicking(false);
  });

  $('addFieldBtn').addEventListener('click', () => {
    const used = new Set(state.job.fields.map((field) => field.name));
    let index = state.job.fields.length + 1;
    let name = 'field_' + index;
    while (used.has(name)) name = 'field_' + ++index;
    state.job.fields.push({ name: name, type: 'text', attr: '', selector: '', path: '' });
    renderFields();
  });

  $('pickContainerBtn').addEventListener('click', () => startPick('container'));
  $('hiliteRowsBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab || !state.job.itemSelector) {
      toast('لا يوجد محدد صفوف بعد', true);
      return;
    }
    await send('panel:hilite', { tabId: tab.id, selector: state.job.itemSelector });
  });

  // -------- محرّر الحقول (مشترك بين حقول القائمة وحقول التفاصيل)
  for (const containerId of ['fieldsList', 'detailFieldsList']) {
    $(containerId).addEventListener('input', onFieldInput);
    $(containerId).addEventListener('change', onFieldTypeChange);
    $(containerId).addEventListener('click', onFieldClick);
  }

  // -------- الصفحات المفصّلة
  $('detailEnabled').addEventListener('change', () => {
    state.job.detail.enabled = $('detailEnabled').checked;
    renderDetailFields();
    renderRun();
    renderStats();
    scheduleSave();
    if (state.job.detail.enabled && !(state.job.detail.fields || []).length) {
      toast('افتح صفحة عنصر ثم اضغط «التقاط حقول التفاصيل»');
    }
  });

  $('detailLinkSelector').addEventListener('input', () => {
    state.job.detail.linkSelector = $('detailLinkSelector').value.trim();
    scheduleSave();
  });

  $('detailMaxItems').addEventListener('input', () => {
    state.job.detail.maxItems = Math.max(0, Math.min(20000, Number($('detailMaxItems').value) || 0));
    scheduleSave();
  });

  $('pickLinkBtn').addEventListener('click', () => {
    state.job.detail.enabled = true;
    renderForm();
    renderDetailFields();
    renderRun();
    startPick('link');
  });

  $('pickDetailBtn').addEventListener('click', () => {
    state.job.detail.enabled = true;
    renderForm();
    renderDetailFields();
    renderRun();
    startPick('field', 'detail');
  });

  $('addDetailFieldBtn').addEventListener('click', () => {
    const detail = state.job.detail;
    const used = new Set((detail.fields || []).map((field) => field.name));
    let index = (detail.fields || []).length + 1;
    let name = 'detail_field_' + index;
    while (used.has(name)) name = 'detail_field_' + ++index;
    detail.fields.push({ name: name, type: 'text', attr: '', selector: '', path: '' });
    detail.enabled = true;
    renderForm();
    renderDetailFields();
    renderRun();
    scheduleSave();
  });

  $('gotoFirstBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) {
      toast('لا يوجد تبويب نشط', true);
      return;
    }
    if (!state.job.parentSelector || !(state.job.fields || []).length) {
      toast('التقط حقول القائمة أولاً حتى نعرف صفوف العناصر', true);
      return;
    }
    toast('جارٍ فتح صفحة أول عنصر…');
    const result = await send('panel:gotoFirstItem', { job: state.job, tabId: tab.id });
    if (!result.ok) {
      toast('تعذّر فتح صفحة العنصر: ' + explainError(result.error), true);
      return;
    }
    toast('فُتحت صفحة العنصر — التقط حقول التفاصيل الآن');
  });

  function onFieldInput(event) {
    const card = event.target.closest('.field');
    if (!card) return;
    const slot = cardSlot(card);
    if (!slot.field) return;
    if (event.target.classList.contains('f-name')) slot.field.name = event.target.value.trim() || slot.field.name;
    if (event.target.classList.contains('f-sel')) slot.field.selector = event.target.value.trim();
    if (event.target.classList.contains('f-attr')) slot.field.attr = event.target.value.trim();
    if (event.target.classList.contains('f-sep')) slot.field.separator = event.target.value;
    scheduleSave();
  }

  function onFieldTypeChange(event) {
    if (!event.target.classList.contains('f-type')) return;
    const card = event.target.closest('.field');
    if (!card) return;
    const slot = cardSlot(card);
    if (!slot.field) return;
    slot.field.type = event.target.value;
    renderFields();
    scheduleSave();
  }

  async function onFieldClick(event) {
    const card = event.target.closest('.field');
    if (!card) return;
    const slot = cardSlot(card);
    if (!slot.field) return;

    if (event.target.classList.contains('f-del')) {
      slot.fields.splice(slot.index, 1);
      renderFields();
      renderStats();
      scheduleSave();
      return;
    }

    if (event.target.classList.contains('f-hilite')) {
      const tab = await activeTab();
      if (!tab) return;
      const base = slot.group === 'detail' ? state.job.detail.containerSelector : state.job.itemSelector;
      const selector =
        (base && slot.field.selector ? base + ' ' + slot.field.selector : '') ||
        slot.field.path ||
        slot.field.selector;
      if (!selector) {
        toast('لا يوجد محدد لإبرازه', true);
        return;
      }
      const result = await send('panel:hilite', { tabId: tab.id, selector: selector });
      if (!result.ok) toast('لم يُعثر على العنصر في الصفحة الحالية', true);
    }
  }

  // -------- التنقل
  $('pickNextBtn').addEventListener('click', () => startPick('next'));
  $('clearNextBtn').addEventListener('click', () => {
    state.job.pagination = Object.assign({}, state.job.pagination, { selector: '', label: '' });
    renderForm();
    scheduleSave();
  });
  $('nextSelector').addEventListener('input', () => {
    state.job.pagination = Object.assign({}, state.job.pagination, { selector: $('nextSelector').value.trim() });
    scheduleSave();
  });
  $('maxPages').addEventListener('input', () => {
    state.job.pagination.maxPages = Math.max(1, Math.min(500, Number($('maxPages').value) || 20));
    scheduleSave();
  });

  // -------- الخيارات
  const optionBindings = [
    ['optKillPopups', 'killPopups'],
    ['optGuardPopups', 'guardPopups'],
    ['optBlockAds', 'blockAds'],
    ['optClickClose', 'clickClose'],
    ['optAutoScroll', 'autoScroll']
  ];
  for (const [id, key] of optionBindings) {
    $(id).addEventListener('change', async () => {
      state.job.options = Object.assign({}, state.job.options, { [key]: $(id).checked });
      state.options = Object.assign({}, state.options, { [key]: $(id).checked });
      await send('panel:options', { options: state.options });
      scheduleSave();
    });
  }
  $('delayMs').addEventListener('input', async () => {
    const value = Math.max(0, Math.min(30000, Number($('delayMs').value) || 0));
    state.job.options = Object.assign({}, state.job.options, { delayMs: value });
    state.options = Object.assign({}, state.options, { delayMs: value });
    await send('panel:options', { options: state.options });
    scheduleSave();
  });

  // -------- التشغيل
  $('probeBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) {
      toast('لا يوجد تبويب نشط', true);
      return;
    }
    if (!canRun()) {
      toast('التقط حقلين على الأقل ليحدّد صهم الصف المتكرّر', true);
      return;
    }
    await saveJob(true);
    await send('panel:options', { options: state.options });
    $('logBox').textContent = '';
    appendLog('اختبار على الصفحة الحالية…');
    const result = await send('panel:probe', { job: state.job, tabId: tab.id });
    if (!result.ok) {
      appendLog('فشل الاختبار: ' + explainError(result.error));
      toast('فشل الاختبار — ' + explainError(result.error), true);
      return;
    }
    appendLog('استُخرج ' + result.itemCount + ' عنصراً (جديد ' + result.added + ')');
    if (result.detailMode) {
      appendLog('روابط الدخول المكتشفة: ' + (result.linkCount || 0));
    }
    if (result.pagination) {
      appendLog(
        'زر «التالي»: ' +
          (result.pagination.hasNext ? 'موجود' : 'غير موجود') +
          (result.pagination.label ? ' — ' + result.pagination.label : '')
      );
    }
    await refreshRows(true);
  });

  $('runBtn').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) {
      toast('لا يوجد تبويب نشط', true);
      return;
    }
    if (!canRun()) {
      toast(runBlockReason() || 'أكمل إعداد المجموعة أولاً', true);
      return;
    }
    if (!state.job.startUrl) {
      state.job.startUrl = tab.url || '';
      renderForm();
    }
    $('logBox').textContent = '';
    await send('panel:options', { options: state.options });
    const result = await send('panel:startRun', { job: state.job, tabId: tab.id });
    if (!result.ok) {
      toast('تعذّر بدء السحب: ' + explainError(result.error), true);
      return;
    }
    state.run = { status: 'running', page: 0, totalRows: 0, reason: '' };
    renderRun();
    appendLog('بدأ السحب…');
  });

  $('stopRunBtn').addEventListener('click', async () => {
    await send('panel:stopRun', {});
    appendLog('أُرسل طلب الإيقاف…');
  });

  // -------- النتائج
  $('previewBtn').addEventListener('click', () => refreshRows(true));

  $('exportCsvBtn').addEventListener('click', async () => {
    const rows = await fetchAllRows();
    if (rows) download(safeName() + '.csv', toCsv(rows), 'text/csv');
  });

  $('exportJsonBtn').addEventListener('click', async () => {
    const rows = await fetchAllRows();
    if (rows) download(safeName() + '.json', JSON.stringify(rows, null, 2), 'application/json');
  });

  $('copyJsonBtn').addEventListener('click', async () => {
    const rows = await fetchAllRows();
    if (!rows) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
      toast('نُسخ ' + rows.length + ' صف إلى الحافظة');
    } catch (e) {
      toast('تعذّر النسخ: ' + String(e), true);
    }
  });

  $('clearRowsBtn').addEventListener('click', async () => {
    if (!confirm('تفريغ كل الصفوف المسحوبة لهذه المجموعة؟')) return;
    await send('panel:clearRows', { jobId: state.job.id });
    state.rows = [];
    renderPreview([]);
    renderStats(0);
    toast('تم تفريغ البيانات');
  });
}

// ------------------------------------------------------------------
// التهيئة
// ------------------------------------------------------------------
async function init() {
  const boot = await send('panel:getState', {});
  state.jobs = (boot && boot.jobs) || [];
  state.options = Object.assign({}, DEFAULT_OPTIONS, (boot && boot.options) || {});
  state.run = boot && boot.run ? boot.run : null;

  state.activeTab = await activeTab();

  const current =
    state.jobs.find((job) => job.id === boot.currentJobId) ||
    state.jobs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];

  if (current) {
    state.job = ensureDetail(JSON.parse(JSON.stringify(current)));
    state.job.options = Object.assign({}, DEFAULT_OPTIONS, state.job.options || {});
    state.job.fields = state.job.fields || [];
  } else {
    state.job = newJob();
  }

  bindEvents();
  renderJobPicker();
  renderForm();
  renderFields();
  renderPreview([]);
  renderRun();
  renderStats(0);

  if (state.activeTab && state.activeTab.id) {
    await send('panel:engage', { tabId: state.activeTab.id });
  }
  if (canRun()) await refreshRows(true);
  else renderPreview([]);

  if (state.run && state.run.status === 'running') {
    appendLog('يوجد سحب جارٍ بالفعل — تُحدَّث النتائج تلقائياً.');
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.from !== 'sw') return;
  if (message.type === 'pick:result') handlePickResult(message.payload);
  else if (message.type === 'run:update') {
    state.run = message.payload;
    renderRun();
    if (message.payload && message.payload.totalRows != null) {
      state.totalRows = message.payload.totalRows;
      renderStats(state.totalRows);
    }
    // عند انتهاء السحب نُحدّث المعاينة والعدّاد من التخزين
    if (message.payload && message.payload.status !== 'running' && state.job) {
      refreshRows(true);
    }
  } else if (message.type === 'run:log') {
    appendLog(message.payload && message.payload.text);
  }
});

chrome.tabs.onActivated.addListener(async (info) => {
  const tab = await activeTab();
  state.activeTab = tab;
  if (tab && tab.id) await send('panel:engage', { tabId: tab.id });
  renderForm();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!state.activeTab || state.activeTab.id !== tabId) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const tab = await activeTab();
  state.activeTab = tab;
  renderForm();
});

document.addEventListener('DOMContentLoaded', init);
