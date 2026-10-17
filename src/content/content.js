/* ------------------------------------------------------------------
 * صهم — src/content/content.js
 * نقطة الدخول في الصفحة: تنسّق بين الالتقاط والاستخراج والتنقّل والحماية.
 * لا تعمل إلا في الإطار الرئيسي.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  if (window !== window.top) return; // الإطار الرئيسي فقط
  const SC = globalThis.SCX;
  if (!SC || SC.contentReady) return;
  SC.contentReady = true;

  const state = {
    job: null,
    running: false,
    statusHost: null,
    statusText: null,
    hideTimer: null
  };

  // ------------------------------------------------------------------
  // شريط الحالة داخل الصفحة
  // ------------------------------------------------------------------
  function statusUI(text) {
    try {
      if (!state.statusHost) {
        state.statusHost = document.createElement('div');
        state.statusHost.id = '__sahm_status_host';
        state.statusHost.style.setProperty('position', 'fixed', 'important');
        state.statusHost.style.setProperty('left', '14px', 'important');
        state.statusHost.style.setProperty('bottom', '14px', 'important');
        state.statusHost.style.setProperty('width', '0', 'important');
        state.statusHost.style.setProperty('height', '0', 'important');
        state.statusHost.style.setProperty('z-index', '2147483646', 'important');
        state.statusHost.style.setProperty('pointer-events', 'none', 'important');
        const shadow = state.statusHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = [
          '<style>',
          '.pill{position:fixed;left:14px;bottom:14px;display:flex;align-items:center;gap:8px;',
          '  padding:7px 12px;border-radius:999px;background:#0f172a;color:#f8fafc;',
          '  border:1px solid rgba(148,163,184,.35);box-shadow:0 8px 24px rgba(2,6,23,.4);',
          '  font:12px/1.5 system-ui,"Segoe UI",Tahoma,sans-serif;direction:rtl;',
          '  max-width:60vw;pointer-events:none;}',
          '.d{width:7px;height:7px;border-radius:50%;background:#34d399;}',
          '.d.busy{animation:s 1.1s ease-in-out infinite;}',
          '@keyframes s{0%,100%{opacity:1}50%{opacity:.25}}',
          '</style>',
          '<div class="pill"><span class="d busy"></span><span class="t"></span></div>'
        ].join('');
        state.statusText = shadow.querySelector('.t');
        document.documentElement.appendChild(state.statusHost);
      }
      state.statusText.textContent = text;
      state.statusHost.style.display = 'block';
      if (state.hideTimer) clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(() => {
        if (state.statusHost) state.statusHost.style.display = 'none';
      }, 6000);
    } catch (e) {
      /* لا نُسقط الصفحة بسبب شريط الحالة */
    }
  }

  function hideStatus() {
    if (state.statusHost) state.statusHost.style.display = 'none';
  }

  // ------------------------------------------------------------------
  // أدوات
  // ------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function safeRows(job) {
    try {
      return SC.ex.findRows(job);
    } catch (e) {
      return [];
    }
  }

  async function waitForItems(job, timeoutMs) {
    const limit = timeoutMs || 9000;
    const started = Date.now();
    while (Date.now() - started < limit) {
      if (safeRows(job).length > 0) return true;
      await sleep(160);
    }
    return false;
  }

  /** يحوّل الحقول المخزّنة إلى عناصر حقيقية داخل الصفحة (لإعادة حساب التجميع). */
  function liveEntries(job) {
    const rows = safeRows(job);
    const out = [];
    for (const field of job.fields || []) {
      let el = null;
      if (field.path) {
        try {
          el = document.querySelector(field.path);
        } catch (e) {
          el = null;
        }
      }
      if (!el && rows.length && field.selector) {
        try {
          el = rows[0].querySelector(field.selector);
        } catch (e) {
          el = null;
        }
      }
      if (el) {
        out.push({
          name: field.name,
          type: field.type,
          attr: field.attr,
          path: field.path,
          el: el
        });
      }
    }
    return out;
  }

  function applyOptions(options) {
    if (!options) return;
    SC.popups.configure({
      ads: !!options.blockAds,
      kill: !!options.killPopups,
      clickClose: !!options.clickClose
    });
  }

  function currentJob() {
    return state.job;
  }

  function sendToBackground(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError; // نتجاهل انقطاع القناة عند التنقّل
      });
    } catch (e) {
      /* تم إبطال السياق بعد تحديث الإضافة */
    }
  }

  // ------------------------------------------------------------------
  // المُعالِجات
  // ------------------------------------------------------------------
  const handlers = {
    PING: async function () {
      return { ok: true, url: location.href, title: document.title };
    },

    OPTIONS: async function (payload) {
      applyOptions(payload.options);
      return { ok: true };
    },

    PICK_START: async function (payload) {
      state.job = payload.job || state.job;
      const job = state.job;
      if (job) SC.popups.setProtected(job);
      const target = payload.target || 'list';
      // في وضع التفاصيل نُحوّل مصدر الحقول إلى حقول التفاصيل، فيعمل
      // الالتقاط المتكرّر وترقيم الأسماء كما يعمل في القائمة.
      const pickerJob =
        target === 'detail' && job && job.detail
          ? Object.assign({}, job, { fields: (job.detail && job.detail.fields) || [] })
          : job;
      SC.picker.start(
        {
          mode: payload.mode || 'field',
          target: target,
          job: pickerJob,
          entriesProvider: () => liveEntries(pickerJob || { fields: [] })
        },
        (result) => {
          sendToBackground({ from: 'cs', type: 'PICK_RESULT', payload: result });
        }
      );
      return { ok: true };
    },

    PICK_STOP: async function () {
      SC.picker.stop(false);
      return { ok: true };
    },

    HILITE: async function (payload) {
      return { ok: SC.picker.hilite(payload.selector) };
    },

    EXTRACT: async function (payload) {
      const job = payload.job || state.job;
      if (!job) return { ok: false, error: 'no-job' };
      state.job = job;
      SC.popups.setProtected(job);
      applyOptions(job.options);

      const waitMs = (job.options && job.options.waitMs) || 9000;
      const found = await waitForItems(job, waitMs);

      if (job.options && job.options.autoScroll) {
        await SC.paginator.autoScroll(6);
        await sleep(400);
      }

      const page = SC.ex.extractPage(job);
      const pagination = SC.paginator.state(job);
      return {
        ok: true,
        url: location.href,
        title: document.title,
        itemFound: found,
        itemCount: page.itemCount,
        rows: page.rows,
        links: page.links || null,
        snapshot: SC.paginator.snapshot(job),
        pagination: pagination
      };
    },

    CLICK_NEXT: async function (payload) {
      const job = payload.job || state.job;
      if (!job) return { ok: false, error: 'no-job' };
      state.job = job;
      SC.popups.setProtected(job);
      const result = SC.paginator.clickNext(job);
      if (result.ok) statusUI('صهم: الانتقال للصفحة التالية…');
      return result;
    },

    // قراءة حقول صفحة التفاصيل الحالية. لا نلمس الإعلانات هنا: لا ننقر
    // شيئاً في هذه الصفحة، وتعديل DOM قد يخفي العناصر المطلوبة.
    DETAIL_EXTRACT: async function (payload) {
      const job = payload.job || state.job;
      if (!job || !job.detail || !(job.detail.fields || []).length) {
        return { ok: false, error: 'no-detail-plan' };
      }
      state.job = job;

      const waitMs = job.detail.waitMs || (job.options && job.options.waitMs) || 9000;
      const started = Date.now();
      let best = { values: {}, found: -1, total: (job.detail.fields || []).length };
      let lastImprove = started;

      // ننتظر حتى تكتمل الحقول، ونتوقّف مبكراً إذا توقّف التحسّن
      while (Date.now() - started < waitMs) {
        const probe = SC.ex.extractDetail(job.detail);
        // نقبل التحسّن فقط (لا نستبدل نتيجة جيدة بأخرى أسوأ إن تغيّر DOM)
        if (best.found < 0 || probe.found > best.found) {
          best = probe;
          lastImprove = Date.now();
        }
        if (probe.total > 0 && probe.found >= probe.total) {
          best = probe;
          break;
        }
        if (Date.now() - lastImprove > 2500) break;
        await sleep(180);
      }

      return {
        ok: true,
        url: location.href,
        title: document.title,
        values: best.values,
        found: best.found,
        total: best.total
      };
    },

    SCROLL_LOAD: async function (payload) {
      const steps = (payload && payload.steps) || 6;
      await SC.paginator.autoScroll(steps);
      return { ok: true };
    },

    RUN_STATUS: async function (payload) {
      state.running = !!(payload && payload.running);
      if (state.running) statusUI(payload.text || 'صهم: السحب جارٍ…');
      else hideStatus();
      return { ok: true };
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.from !== 'sw') return false;
    const handler = handlers[message.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message.payload || {}))
      .then((result) => respond(result || { ok: true }))
      .catch((error) => respond({ ok: false, error: String((error && error.message) || error) }));
    return true; // رد غير متزامن
  });

  // ------------------------------------------------------------------
  // إعلان الجاهزية للخلفية (وعلى كل تنقّل كامل تعيد الإضافة حقننا)
  // ------------------------------------------------------------------
  function announceReady() {
    try {
      chrome.runtime.sendMessage(
        { from: 'cs', type: 'READY', payload: { url: location.href, title: document.title } },
        (response) => {
          if (chrome.runtime.lastError) return;
          if (!response) return;
          if (response.options) applyOptions(response.options);
          if (response.job) state.job = response.job;
        }
      );
    } catch (e) {
      /* السياق مُبطَل — لا شيء لفعله */
    }
  }

  SC.content = {
    state: state,
    currentJob: currentJob,
    liveEntries: liveEntries,
    statusUI: statusUI,
    hideStatus: hideStatus
  };

  announceReady();
})();
