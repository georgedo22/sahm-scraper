/* ------------------------------------------------------------------
 * صهم — src/content/popup-guard.js
 * يُحقن في سياق الصفحة نفسه (MAIN world) عند document_start.
 * مهمته الوحيدة: منع أساليب الإعلانات في فتح نوافذ جديدة أو حوارات مزعجة.
 * هذا السكربت اختياري بالكامل (يُشغّل من اللوحة).
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  if (window.__sahmGuardInstalled) return;
  window.__sahmGuardInstalled = true;
  window.__sahmAllowOpen = false;

  var originalOpen = window.open;

  window.open = function () {
    if (window.__sahmAllowOpen) return originalOpen.apply(window, arguments);
    try {
      console.debug('[صهم] مُنع فتح نافذة جديدة');
    } catch (e) {
      /* لا شيء */
    }
    return null;
  };

  // الأنماط الصريحة فقط — نتجنّب أي إخفاء أو منع عام حتى لا نكسر الموقع.
  var EXPLICIT_AD = /^(popunder|clickad|interstitial|ad-overlay|adsbygoogle|onclickads|popads)$/i;

  function looksLikeAdNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var cls = typeof node.className === 'string' ? node.className.split(/\s+/) : [];
    var id = node.id || '';
    for (var i = 0; i < cls.length; i++) {
      if (EXPLICIT_AD.test(cls[i])) return true;
    }
    return EXPLICIT_AD.test(id);
  }

  document.addEventListener(
    'click',
    function (event) {
      if (window.__sahmAllowOpen) return;
      var path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
      var head = path[0];
      if (!looksLikeAdNode(head)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );

  // حوارات التنبيه المتكرّرة تُعطّل السحب الآلي
  window.alert = function () {};
  if (window.print) window.print = function () {};
})();
