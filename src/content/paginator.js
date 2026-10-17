/* ------------------------------------------------------------------
 * صهم — src/content/paginator.js
 * محرّك الانتقال للصفحة التالية:
 *   - استخدام الزر الذي التقطه المستخدم، أو اكتشافه تلقائياً.
 *   - كشف الزر المعطّل (آخر صفحة).
 *   - التفريق بين تنقّل كامل (تحميل صفحة جديدة) وتنقّل داخل نفس الصفحة (SPA).
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const SC = (globalThis.SCX = globalThis.SCX || {});
  if (SC.paginator) return;
  const S = SC.sel;
  const G = {};

  const NEXT_WORDS = [
    'next',
    'next page',
    'nextpage',
    'older',
    'older posts',
    'more',
    'load more',
    'التالي',
    'التالية',
    'الصفحة التالية',
    'التالي ›',
    'الصفحة التاليه',
    'المزيد',
    'أكثر',
    '›',
    '»'
  ];

  const PREV_WORDS = ['prev', 'previous', 'back', 'السابق', 'السابقة', '‹', '«'];

  const NEXT_CANDIDATE_SELECTOR = [
    'a[rel="next"]',
    '[class*="pagination"] a',
    '[class*="pager"] a',
    '[class*="pagination"] button',
    '[class*="pager"] button',
    '.next a',
    'a.next',
    'li.next a',
    'button.next',
    '[class*="next"]',
    '[aria-label*="next" i]',
    '[title*="next" i]',
    '[aria-label*="التالي"]',
    '[title*="التالي"]',
    'a[href*="page="]',
    'a[href*="paged="]',
    'a[href*="page/"]'
  ].join(',');

  function normText(el) {
    return S.norm(el.textContent).toLowerCase();
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const className = typeof el.className === 'string' ? el.className : '';
    if (/\bdisabled\b|\bis-disabled\b|\bdisabled--/.test(className)) return true;
    const parent = el.closest('li, .page-item, [class*="pagination"]');
    if (parent && /disabled/.test(typeof parent.className === 'string' ? parent.className : '')) return true;
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (e) {
      return false;
    }
  }

  function hrefOf(el) {
    const anchor = el.tagName === 'A' ? el : el.querySelector('a[href]');
    if (anchor) return anchor.getAttribute('href') || '';
    return el.getAttribute('href') || '';
  }

  /** اكتشاف تلقائي لزر "التالي" عندما لا يحدّده المستخدم. */
  function autoDetect() {
    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(NEXT_CANDIDATE_SELECTOR));
    } catch (e) {
      return null;
    }
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (!isVisible(el) || isDisabled(el)) continue;
      const text = normText(el);
      const className = typeof el.className === 'string' ? el.className : '';
      const aria = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');

      let score = 0;
      if (/(^|\s)(next|nextpage|next-page)(\s|$)|-next|next-|_next/i.test(className)) score += 3;
      if (el.getAttribute('rel') === 'next') score += 4;
      if (/next/i.test(aria)) score += 2;
      if (text && NEXT_WORDS.indexOf(text) !== -1) score += 4;
      else if (text.length <= 12 && NEXT_WORDS.some((word) => text === word || text === word + ' »')) score += 3;
      if (text === '›' || text === '»' || text === '>' || text === '→') score += 3;
      if (el.closest('[class*="pagination"], [class*="pager"], nav')) score += 2;
      if (el.tagName === 'A' || el.tagName === 'BUTTON') score += 1;
      if (PREV_WORDS.some((word) => text === word || text.indexOf(word) === 0)) score -= 6;
      if (!text && !hrefOf(el)) score -= 2;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore >= 3 ? best : null;
  }

  function findNext(job) {
    const pagination = (job && job.pagination) || {};
    if (pagination.selector) {
      let el = null;
      try {
        el = document.querySelector(pagination.selector);
      } catch (e) {
        el = null;
      }
      if (el && el.isConnected) return { element: el, strategy: 'picked' };
      // المحدد الملتقط لم يعد موجوداً، أو صار غير مرئي: نجرّب الاكتشاف التلقائي
    }
    const auto = autoDetect();
    return auto ? { element: auto, strategy: 'auto' } : null;
  }

  /** وصف حالة التنقل الحالية دون النقر. */
  function state(job) {
    const found = findNext(job);
    if (!found) return { hasNext: false, reason: 'not-found' };
    const el = found.element;
    return {
      hasNext: !isDisabled(el) && isVisible(el),
      disabled: isDisabled(el),
      visible: isVisible(el),
      label: S.norm(el.textContent).slice(0, 40) || el.getAttribute('aria-label') || '',
      href: hrefOf(el),
      strategy: found.strategy
    };
  }

  function flash(el) {
    try {
      const previous = el.style.outline;
      el.style.setProperty('outline', '3px solid #34d399', 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
      setTimeout(() => {
        el.style.setProperty('outline', previous || '');
        el.style.setProperty('outline-offset', '');
      }, 900);
    } catch (e) {
      /* عنصر غريب — لا يهم */
    }
  }

  /**
   * ينقر زر التالي. يُؤجَّل التنفيذ قليلاً حتى يستطيع سكربت المحتوى
   * إرسال الرد قبل أن يُدمَّر جرّاء التنقّل.
   */
  function clickNext(job) {
    const found = findNext(job);
    if (!found) return { ok: false, reason: 'not-found' };
    const el = found.element;
    if (isDisabled(el)) return { ok: false, reason: 'disabled' };
    if (!isVisible(el)) return { ok: false, reason: 'not-visible' };

    const href = hrefOf(el);
    const isAnchorNavigation =
      /^https?:/i.test(href) && !/^javascript:/i.test(href) && !el.hasAttribute('data-no-nav');

    // التمرير كمالي: فشله يجب ألا يمنع النقر
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) {
      try {
        el.scrollIntoView();
      } catch (e2) {
        /* لا دالة تمرير — نكمل */
      }
    }
    flash(el);

    // السماح بفتح النوافذ من هذا العنصر فقط (بعض المواقع تستخدم window.open)
    try {
      window.__sahmAllowOpen = true;
    } catch (e) {
      /* لا شيء */
    }

    const rect = el.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };

    const anchorAllowsNewTab = (() => {
      const anchor = el.tagName === 'A' ? el : el.querySelector('a[href]');
      return anchor && anchor.getAttribute('target') === '_blank';
    })();

    setTimeout(() => {
      try {
        if (anchorAllowsNewTab && /^https?:/i.test(href)) {
          // نبقى في نفس التبويب بدل فتح تبويب جديد
          location.assign(href);
          return;
        }
        el.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        el.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        el.dispatchEvent(new MouseEvent('click', eventOptions));
        if (el.tagName !== 'A' && isAnchorNavigation) {
          const anchor = el.querySelector('a[href]');
          if (anchor && anchor.getAttribute('target') !== '_blank') {
            setTimeout(() => location.assign(href), 250);
          }
        }
      } catch (error) {
        /* نتجاهل أخطاء النقر */
      }
    }, 60);

    // samePageExpected=true يعني أن الواجهة ستتغيّر داخل نفس المستند (SPA)
    const samePageExpected = !isAnchorNavigation;
    return {
      ok: true,
      strategy: found.strategy,
      href: href,
      navigates: isAnchorNavigation,
      samePageExpected: samePageExpected
    };
  }

  /** بصمة سريعة لمحتوى الصفحة، لكشف الصفحات المتكرّرة أو التوقّف. */
  function snapshot(job) {
    let rows = [];
    try {
      rows = SC.ex.findRows(job);
    } catch (e) {
      rows = [];
    }
    const sample = rows.slice(0, 5).map((row) => S.norm(row.textContent).slice(0, 200)).join('\u0001');
    return { count: rows.length, sample: sample };
  }

  /** تمرير تدريجي لتحميل المحتوى الكسول أو التمرير اللانهائي. */
  function autoScroll(steps) {
    const total = steps || 6;
    let index = 0;
    return new Promise((resolve) => {
      const tick = () => {
        const before = document.documentElement.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
        index++;
        setTimeout(() => {
          const after = document.documentElement.scrollHeight;
          if (index >= total || after === before) {
            window.scrollTo(0, 0);
            resolve();
            return;
          }
          tick();
        }, 350);
      };
      tick();
    });
  }

  G.findNext = findNext;
  G.state = state;
  G.clickNext = clickNext;
  G.snapshot = snapshot;
  G.autoScroll = autoScroll;
  G.isDisabled = isDisabled;
  SC.paginator = G;
})();
