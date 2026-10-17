/* ------------------------------------------------------------------
 * صهم — src/content/picker.js
 * واجهة الالتقاط بالفأرة: إبراز العنصر تحت المؤشر، واعتراض النقرة
 * حتى لا ينفّذ الموقع سلوكه (نقل، فتح نافذة، تشغيل فيديو).
 * تعمل كل الواجهة داخل Shadow DOM لتفادي تعارضات CSS مع الموقع.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const SC = (globalThis.SCX = globalThis.SCX || {});
  if (SC.picker) return;
  const S = SC.sel;

  const picker = {};
  let host = null;
  let box = null;
  let tag = null;
  let bar = null;
  let barStatus = null;
  let barName = null;

  let active = false;
  let mode = 'field';
  let target = 'list';
  let job = null;
  let entriesProvider = null;
  let emit = null;
  let lastTarget = null;
  let frame = 0;
  let counter = 0;
  let pickedNames = null;
  // عناصر التقطناها في جلسة الالتقاط الحالية — تُستعمل في صفحة العنصر
  // لاستنتاج حاوية مشتركة صحيحة (لا صفوف متكرّرة هناك).
  let pickedEntries = [];

  const TYPE_LABELS = {
    text: 'نص',
    html: 'HTML',
    href: 'رابط',
    src: 'وسيط',
    image: 'صورة',
    number: 'رقم',
    datetime: 'تاريخ',
    attr: 'خاصية',
    list: 'قائمة'
  };

  // ------------------------------------------------------------------
  // واجهة المستخدم (Shadow DOM)
  // ------------------------------------------------------------------
  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__sahm_picker_host';
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('left', '0', 'important');
    host.style.setProperty('top', '0', 'important');
    host.style.setProperty('width', '0', 'important');
    host.style.setProperty('height', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    host.style.setProperty('all', 'initial');

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      '  .box{position:fixed;left:0;top:0;width:0;height:0;border:2px solid #34d399;',
      '       background:rgba(52,211,153,.14);border-radius:4px;pointer-events:none;',
      '       box-sizing:border-box;z-index:2147483647;}',
      '  .tag{position:fixed;left:0;top:0;max-width:70vw;padding:2px 7px;border-radius:5px;',
      '       background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.4);',
      '       font:11px/1.6 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;',
      '       text-overflow:ellipsis;pointer-events:none;direction:ltr;text-align:left;',
      '       z-index:2147483647;}',
      '  .bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;',
      '       align-items:center;gap:10px;padding:8px 12px;border-radius:12px;',
      '       background:#0f172a;color:#f8fafc;border:1px solid rgba(148,163,184,.35);',
      '       box-shadow:0 10px 30px rgba(2,6,23,.45);direction:rtl;pointer-events:auto;',
      '       font:13px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif;z-index:2147483647;}',
      '  .dot{width:8px;height:8px;border-radius:50%;background:#34d399;flex:0 0 auto;',
      '       animation:sahm-pulse 1.4s ease-in-out infinite;}',
      '  @keyframes sahm-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '  .bar b{color:#6ee7b7;font-weight:600;}',
      '  .bar .sep{width:1px;height:18px;background:rgba(148,163,184,.35);}',
      '  .bar button{font:inherit;color:inherit;background:rgba(148,163,184,.14);',
      '       border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:3px 10px;cursor:pointer;}',
      '  .bar button:hover{background:rgba(148,163,184,.28);}',
      '  .bar button:focus-visible{outline:2px solid #34d399;outline-offset:2px;}',
      '  .hint{color:#94a3b8;}',
      '</style>',
      '<div class="box"></div>',
      '<div class="tag"></div>',
      '<div class="bar" role="status" aria-live="polite">',
      '  <span class="dot"></span>',
      '  <span class="bar-status"></span>',
      '  <b class="bar-name"></b>',
      '  <span class="hint">Esc للإنهاء</span>',
      '  <span class="sep"></span>',
      '  <button type="button" class="done">تم</button>',
      '</div>'
    ].join('');

    box = shadow.querySelector('.box');
    tag = shadow.querySelector('.tag');
    bar = shadow.querySelector('.bar');
    barStatus = shadow.querySelector('.bar-status');
    barName = shadow.querySelector('.bar-name');
    shadow.querySelector('.done').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      stop(true);
    });

    document.documentElement.appendChild(host);
  }

  function removeUI() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    box = tag = bar = barStatus = barName = null;
  }

  function setStatus(text, name) {
    if (!bar) return;
    barStatus.textContent = text;
    barName.textContent = name || '';
  }

  function draw(el) {
    if (!box || !el || !el.getBoundingClientRect) return;
    const rect = el.getBoundingClientRect();
    box.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
    box.style.width = Math.max(0, rect.width) + 'px';
    box.style.height = Math.max(0, rect.height) + 'px';

    const label = describe(el);
    tag.textContent = label;
    const tagTop = rect.top > 26 ? rect.top - 24 : rect.bottom + 4;
    tag.style.transform = 'translate(' + Math.max(2, rect.left) + 'px,' + Math.max(2, tagTop) + 'px)';
  }

  function describe(el) {
    const tagName = el.tagName.toLowerCase();
    const classes = S.stableClasses(el, 2);
    const id = el.id && S.isStableToken(el.id) ? '#' + el.id : '';
    const text = S.norm(el.textContent).slice(0, 40);
    return (
      tagName +
      id +
      classes.map((c) => '.' + c).join('') +
      (text ? '  «' + text + '»' : '')
    );
  }

  // ------------------------------------------------------------------
  // اعتراض الأحداث
  // ------------------------------------------------------------------
  function isOurs(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return host ? path.indexOf(host) !== -1 : false;
  }

  function targetOf(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (host && node === host) return null;
      if (node.nodeType === 1 && node !== document.documentElement && node !== document.body) return node;
    }
    const target = event.target;
    return target && target.nodeType === 1 ? target : null;
  }

  function onMove(event) {
    if (isOurs(event)) return;
    const el = targetOf(event);
    if (!el || el === lastTarget) return;
    lastTarget = el;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw(lastTarget);
    });
  }

  function onClick(event) {
    if (isOurs(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const el = targetOf(event);
    if (el) handlePick(el);
  }

  /** نمنع كل أحداث الضغط حتى لا ينفّذ الموقع نقره على زر أو رابط. */
  function swallow(event) {
    if (isOurs(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop(true);
    }
  }

  function onScroll() {
    if (lastTarget && lastTarget.isConnected) draw(lastTarget);
  }

  function onContextMenu(event) {
    if (isOurs(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stop(true);
  }

  // ------------------------------------------------------------------
  // معالجة النقرة
  // ------------------------------------------------------------------
  function uniqueName(base, used) {
    let name = base || 'field';
    let index = 2;
    while (used.has(name)) {
      name = base + '_' + index;
      index++;
    }
    used.add(name);
    return name;
  }

  function nameFor(el, used) {
    const candidate =
      firstUsefulClass(el) ||
      (el.id && S.isStableToken(el.id) ? el.id : '') ||
      firstUsefulClass(el.closest('li,article,div,td') || el) ||
      el.tagName.toLowerCase();
    return uniqueName(candidate, used);
  }

  function firstUsefulClass(el) {
    if (!el || !el.classList) return '';
    for (const cls of Array.from(el.classList)) {
      if (!S.isStableToken(cls)) continue;
      return cls.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
    }
    return '';
  }

  function handlePick(el) {
    if (!bar) return;

    // وضع رابط الدخول: نحسب المسار نسبةً إلى الصف لا إلى الصفحة،
    // حتى يصلح لكل صف وليس للصف الذي نقرنا عليه فقط.
    if (mode === 'link') {
      const label = S.norm(el.textContent) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      let rowEl = null;
      if (job && job.itemSelector) {
        try {
          rowEl = el.closest(job.itemSelector);
        } catch (e) {
          rowEl = null;
        }
      }
      if (!rowEl && job && job.parentSelector) {
        try {
          const rows = SC.ex.findRows(job);
          rowEl = rows.filter((row) => row.contains(el))[0] || null;
        } catch (e) {
          rowEl = null;
        }
      }
      let selector = '';
      if (rowEl && rowEl !== el) {
        try {
          selector = S.relPath(rowEl, el, { childOnly: false });
        } catch (e) {
          selector = '';
        }
      }
      if (!selector) selector = S.cssPath(el);
      const href = el.tagName === 'A' ? el.getAttribute('href') : el.querySelector('a[href]') ? el.querySelector('a[href]').getAttribute('href') : '';
      const payload = {
        mode: 'link',
        link: {
          selector: selector,
          label: label.slice(0, 60),
          relativeToRow: !!(rowEl && rowEl !== el),
          href: href || ''
        }
      };
      stop(false);
      if (emit) emit(payload);
      return;
    }

    if (mode === 'next') {
      const label = S.norm(el.textContent) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const payload = {
        mode: 'next',
        pagination: { selector: S.cssPath(el), label: label.slice(0, 40) }
      };
      stop(false);
      if (emit) emit(payload);
      return;
    }

    if (mode === 'container') {
      const parent = el.parentElement;
      const entries = typeof entriesProvider === 'function' ? entriesProvider() : [];
      let learned = null;
      try {
        learned = SC.ex.analyze(job, entries, { forceContainer: el });
      } catch (error) {
        learned = null;
      }
      const payload = {
        mode: 'container',
        container: {
          parentSelector: (learned && learned.parentSelector) || (parent ? S.cssPath(parent) : S.cssPath(el)),
          itemSignature: (learned && learned.itemSignature) || S.signature(el),
          itemSelector: S.cssPath(el),
          label: describe(el).slice(0, 60)
        },
        learned: learned
      };
      stop(false);
      if (emit) emit(payload);
      return;
    }

    // وضع الحقول: نضيف الحقل ونتابع التقاط حقول أخرى على نفس العنصر المتكرّر
    const used = new Set((job && job.fields ? job.fields : []).map((f) => f.name));
    if (pickedNames) for (const name of pickedNames) used.add(name);
    if (!pickedNames) pickedNames = new Set();

    const guessed = SC.ex.guessType(el);
    const name = nameFor(el, used);
    pickedNames.add(name);

    const entry = {
      name: name,
      type: guessed.type,
      attr: guessed.attr || '',
      path: S.cssPath(el),
      el: el
    };

    const fromProvider = typeof entriesProvider === 'function' ? entriesProvider() : [];
    let entries;
    if (target === 'detail') {
      // صفحة العنصر بلا صفوف متكرّرة: كل نقرة تُضاف إلى سابقتها، فيُستنتج
      // الأب المشترك من مجموع الحقول لا من آخر حقل وحده.
      pickedEntries = pickedEntries.filter((item) => item.el && item.el.isConnected);
      entries = pickedEntries.concat(
        fromProvider.filter((item) => !pickedEntries.some((picked) => picked.path === item.path))
      );
    } else {
      entries = fromProvider;
    }
    entries.push(entry);
    if (target === 'detail') pickedEntries = entries.slice();
    counter++;
    setStatus('التقطت:', name + ' · ' + (TYPE_LABELS[entry.type] || entry.type));

    let learned = null;
    try {
      learned = target === 'detail' ? SC.ex.analyzeDetail(entries) : SC.ex.analyze(job, entries);
    } catch (error) {
      learned = null;
    }

    if (emit) {
      emit({
        mode: 'field',
        target: target,
        field: {
          name: entry.name,
          type: entry.type,
          attr: entry.attr,
          path: entry.path
        },
        learned: learned,
        pickedCount: counter
      });
    }
  }

  // ------------------------------------------------------------------
  // التحكم
  // ------------------------------------------------------------------
  function start(options, callback) {
    options = options || {};
    ensureUI();
    active = true;
    mode = options.mode || 'field';
    target = options.target || 'list';
    job = options.job || null;
    entriesProvider = options.entriesProvider || null;
    emit = callback || null;
    counter = 0;
    pickedNames = null;
    pickedEntries = [];
    lastTarget = null;

    const statusText =
      mode === 'link'
        ? 'انقر على الرابط الذي يدخل إلى صفحة العنصر'
        : mode === 'next'
        ? 'انقر على زر «التالي» في الصفحة'
        : mode === 'container'
        ? 'انقر على عنصر واحد من الصف المتكرّر'
        : target === 'detail'
        ? 'انقر على حقول صفحة التفاصيل واحداً واحداً'
        : 'انقر على أول حقل، ثم أكمل بقية الحقول';

    setStatus(statusText, '');
    if (bar) bar.style.display = 'flex';

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('pointerdown', swallow, true);
    document.addEventListener('pointerup', swallow, true);
    document.addEventListener('auxclick', swallow, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
  }

  function stop(notifyCancel) {
    if (!active) return;
    active = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('pointerdown', swallow, true);
    document.removeEventListener('pointerup', swallow, true);
    document.removeEventListener('auxclick', swallow, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    lastTarget = null;
    removeUI();
    if (notifyCancel && emit) emit({ mode: 'cancel', pickedCount: counter });
  }

  /** وميض سريع على عنصر لتأكيد محدد ما من اللوحة. */
  function hilite(selector) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return false;
    }
    if (!el) return false;
    ensureUI();
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {
      /* التمرير كمالي فقط */
    }
    draw(el);
    if (box) box.style.background = 'rgba(56,189,248,.3)';
    setTimeout(() => {
      if (!active) removeUI();
    }, 1600);
    return true;
  }

  picker.start = start;
  picker.stop = stop;
  picker.hilite = hilite;
  picker.isActive = () => active;
  picker.TYPE_LABELS = TYPE_LABELS;
  SC.picker = picker;
})();
