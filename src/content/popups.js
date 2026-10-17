/* ------------------------------------------------------------------
 * صهم — src/content/popups.js
 * حماية السحب من الإعلانات والطبقات المغطّية:
 *   1) إخفاء حاويات الإعلانات المعروفة (قابل للتراجع).
 *   2) قتل الطبقات/النوافذ المغطّية التي تحجب المحتوى أو تقفل التمرير.
 *   3) استعادة التمرير إذا قفله الموقع.
 * كل ذلك مع "منطقة محميّة": لا يُخفى أي عنصر يحتوي البيانات التي التقطها المستخدم.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const SC = (globalThis.SCX = globalThis.SCX || {});
  if (SC.popups) return;
  const S = SC.sel;
  const P = {};

  // حاويات إعلانات معروفة (تُستخدم كمرشّح أولي، ثم يُتحقق منها بعناية)
  const AD_SELECTORS = [
    'ins.adsbygoogle',
    '.adsbygoogle',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[id^="google_ads"]',
    '[id^="aswift_"]',
    '[id^="div-gpt-ad"]',
    '[class*="advert"]',
    '[id*="advert"]',
    '[class^="ads-"]',
    '[class$="-ads"]',
    '[class*="-ads-"]',
    '[class*="adsense"]',
    '[class*="ad-slot"]',
    '[class*="ad-container"]',
    '[class*="banner-ad"]',
    '[class*="sponsored"]',
    '[id^="taboola"]',
    '[class^="trc_"]',
    '[id^="outbrain"]',
    '[class^="ob-"]',
    '[id*="mgid"]',
    '[class*="mgid"]',
    '[id*="popads"]',
    '[id*="propeller"]',
    '[id*="revcontent"]',
    '[class*="adthrive"]',
    '[class*="ezoic"]',
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="adservice"]',
    'iframe[src*="/ads/"]',
    'iframe[src*="banner"]',
    '[aria-label*="advertisement" i]'
  ];

  // عناصر تشبه النوافذ المنبثقة
  const POPUP_SELECTORS = [
    '[id*="modal"]',
    '[class*="modal"]',
    '[id*="popup"]',
    '[class*="popup"]',
    '[class*="pop-up"]',
    '[class*="overlay"]',
    '[class*="lightbox"]',
    '[class*="interstitial"]',
    '[class*="newsletter"]',
    '[class*="subscribe"]',
    '[class*="cookie"]',
    '[class*="consent"]',
    '[class*="gdpr"]',
    '[class*="paywall"]',
    '[class*="age-gate"]',
    '[role="dialog"]',
    '[aria-modal="true"]'
  ];

  const CLOSE_SELECTORS = [
    '[aria-label*="close" i]',
    '[title*="close" i]',
    '[aria-label*="إغلاق"]',
    '[title*="إغلاق"]',
    '[data-dismiss="modal"]',
    '[data-close]',
    'button[class*="close"]',
    '[class*="close-btn"]',
    '[class*="closeButton"]',
    '[class*="close-button"]'
  ];

  const hidden = new WeakMap(); // عنصر → قيمة display الأصلية
  let protectedSelectors = [];
  let observer = null;
  let timer = null;
  let sweepQueued = false;
  let options = { ads: false, kill: true, clickClose: false };
  let stats = { ads: 0, overlays: 0, scrollFixes: 0 };

  P.stats = stats;

  function isHidden(el) {
    try {
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    } catch (e) {
      return false;
    }
  }

  /** هل يقع هذا العنصر في نطاق البيانات التي التقطها المستخدم؟ */
  function isProtected(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el === document.body || el === document.documentElement) return true;
    for (const selector of protectedSelectors) {
      try {
        if (el.matches(selector) || el.querySelector(selector)) return true;
      } catch (e) {
        /* محدد غير صالح — نتجاهله */
      }
    }
    return false;
  }

  /** يشبه المحتوى الحقيقي (مقال، جدول، نموذج) وليس إعلاناً. */
  function looksLikeContent(el) {
    try {
      if (el.querySelector('article, main, h1, form, table, [role="main"]')) return true;
      const links = el.querySelectorAll('a').length;
      const textLength = (el.textContent || '').length;
      return textLength > 800 && links >= 3;
    } catch (e) {
      return false;
    }
  }

  function hide(el, reason) {
    if (!el || !el.style) return false;
    if (isHidden(el)) return false;
    hidden.set(el, el.style.getPropertyValue('display'));
    el.style.setProperty('display', 'none', 'important');
    el.setAttribute('data-sahm-hidden', reason || '1');
    return true;
  }

  function restoreAll() {
    const nodes = document.querySelectorAll('[data-sahm-hidden]');
    for (const node of nodes) {
      const previous = hidden.get(node);
      node.style.removeProperty('display');
      if (previous) node.style.setProperty('display', previous);
      node.removeAttribute('data-sahm-hidden');
    }
    stats.ads = 0;
    stats.overlays = 0;
  }

  // ------------------------------------------------------------------
  // 1) إخفاء الإعلانات
  // ------------------------------------------------------------------
  function sweepAds() {
    let candidates = [];
    try {
      candidates = Array.from(document.querySelectorAll(AD_SELECTORS.join(',')));
    } catch (e) {
      return;
    }
    let budget = 200;
    for (const el of candidates) {
      if (budget-- <= 0) break;
      if (isProtected(el) || looksLikeContent(el)) continue;
      // لا نخفي عنصراً حجمه صفر (لا فائدة)
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height < 400 && el.tagName !== 'IFRAME') continue;
      if (hide(el, 'ad')) stats.ads++;
    }
  }

  // ------------------------------------------------------------------
  // 2) قتل الطبقات المغطّية
  // ------------------------------------------------------------------
  function looksLikeOverlay(el) {
    if (isProtected(el) || looksLikeContent(el)) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const zIndex = parseInt(cs.zIndex, 10);
    if (!(zIndex >= 900)) return false;

    const rect = el.getBoundingClientRect();
    const viewport = innerWidth * innerHeight;
    if (viewport <= 0) return false;
    const area = rect.width * rect.height;
    if (area < viewport * 0.3) return false;
    if (rect.width < innerWidth * 0.5 && rect.height < innerHeight * 0.5) return false;
    return true;
  }

  function clickCloseButtons(el) {
    let candidates = [];
    try {
      candidates = Array.from(el.querySelectorAll(CLOSE_SELECTORS.join(',')));
    } catch (e) {
      return;
    }
    let attempts = 0;
    for (const button of candidates) {
      if (attempts >= 2) break;
      if (isProtected(button)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      attempts++;
      try {
        button.click();
      } catch (e) {
        /* زر معطوب — لا يهم */
      }
    }
  }

  function killOverlays() {
    let candidates = [];
    try {
      candidates = Array.from(document.body.querySelectorAll(POPUP_SELECTORS.join(',')));
    } catch (e) {
      return;
    }
    // نضيف أيضاً أول ثلاثة مستويات من أبناء body (النوافذ تُحقن هناك غالباً)
    let depthBudget = 120;
    const walk = (node, depth) => {
      if (depth > 2 || depthBudget-- <= 0) return;
      for (const child of node.children) {
        candidates.push(child);
        walk(child, depth + 1);
      }
    };
    walk(document.body, 0);

    const seen = new Set();
    let budget = 120;
    for (const el of candidates) {
      if (budget-- <= 0) break;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (!looksLikeOverlay(el)) continue;

      if (options.clickClose) clickCloseButtons(el);
      if (hide(el, 'overlay')) stats.overlays++;

      // إخفاء خلفية معتمة مصاحبة
      const parent = el.parentElement;
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === el) continue;
          if (isProtected(sibling)) continue;
          if (/backdrop|overlay|mask|shadow/i.test(sibling.className || '')) {
            hide(sibling, 'backdrop');
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 3) استعادة التمرير
  // ------------------------------------------------------------------
  function unstickScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      let cs;
      try {
        cs = getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (cs.overflowY === 'hidden' || cs.overflow === 'hidden') {
        if (el.style.getPropertyValue('overflow') !== 'auto') {
          el.style.setProperty('overflow', 'auto', 'important');
          el.style.setProperty('overflow-y', 'auto', 'important');
          stats.scrollFixes++;
        }
      }
      if (cs.pointerEvents === 'none') {
        el.style.setProperty('pointer-events', 'auto', 'important');
      }
      const inlineHeight = el.style.height;
      if (inlineHeight === '100%' && cs.position === 'fixed') {
        el.style.removeProperty('position');
      }
    }
  }

  // ------------------------------------------------------------------
  // الحلقة الدورية
  // ------------------------------------------------------------------
  function sweep() {
    if (!options.ads && !options.kill) return;
    sweepQueued = false;
    try {
      if (options.ads) sweepAds();
      if (options.kill) {
        killOverlays();
        unstickScroll();
      }
    } catch (e) {
      /* لا نُسقط الصفحة بسبب خطأ في الحماية */
    }
  }

  function queueSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    setTimeout(sweep, 250);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(queueSweep);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timer = setInterval(() => {
      // الحلقة الدورية خفيفة: تعمل فقط إن كان هناك ما يستحق الفحص
      if (document.hidden) return;
      sweep();
    }, 2000);
    queueSweep();
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    restoreAll();
  }

  P.configure = function (next) {
    const merged = Object.assign({}, options, next || {});
    const wasActive = options.ads || options.kill;
    options = merged;
    const isActive = options.ads || options.kill;
    if (isActive && !observer) start();
    if (!isActive && wasActive) stop();
    if (isActive) queueSweep();
  };

  P.setProtected = function (job) {
    const list = [];
    if (job) {
      if (job.parentSelector) list.push(job.parentSelector);
      if (job.pagination && job.pagination.selector) list.push(job.pagination.selector);
      for (const field of job.fields || []) {
        if (field.selector && job.itemSelector) list.push(job.itemSelector);
      }
    }
    // حماية إضافية: أي شريط تنقّل صفحات شائع
    list.push('nav', 'footer', 'header');
    protectedSelectors = list.filter(Boolean);
  };

  P.isProtected = isProtected;
  P.sweep = sweep;
  P.stop = stop;
  SC.popups = P;
})();
