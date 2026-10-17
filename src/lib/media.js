/* ------------------------------------------------------------------
 * صهم — src/lib/media.js
 * كشف وسائط المشاهدة: iframe / embed / object / video / source،
 * استخراج روابطها المطلقة، وتسمية مزودات الفيديو المعروفة
 * (YouTube، Vimeo، Dailymotion، Streamtape، Vidbom، Upcloud…)،
 * وبناء رابط Embed لكل مزود معروف من رابط المشاهدة العادي.
 * تُحمَّل كسكربت محتوى عادي (بدون وحدات ES) وتُشارك عبر globalThis.SCX.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const SC = (globalThis.SCX = globalThis.SCX || {});
  if (SC.media) return;
  const S = SC.sel;

  // كل الوسميات التي قد تحمل مصدر وسيط على العنصر نفسه
  const MEDIA_TAGS = new Set(['IFRAME', 'EMBED', 'OBJECT', 'VIDEO', 'AUDIO', 'SOURCE']);

  // خصائص المصادر المرتّبة بالأولوية (الأساسي أولاً)
  const SRC_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-embed', 'data-video'];

  const EMBED_SELECTOR = [
    'iframe',
    'embed',
    'object[data]',
    'video[src]',
    'video > source[src]',
    'iframe[data-src]',
    'iframe[data-original]',
    'iframe[data-lazy-src]',
    'embed[data-src]',
    '.player iframe',
    '.player[data-src]'
  ].join(',');

  // ------------------------------------------------------------------
  // المزودات المعروفة: نمط الرابط ← اسم المزود ← قالب الـ Embed
  // ------------------------------------------------------------------
  const PROVIDERS = [
    { name: 'YouTube',      re: /(^|\.)youtube(\.|com$)/i,                    watch: 'https://www.youtube.com/watch?v=',   embed: (u) => 'https://www.youtube.com/embed/' + queryId(u, 'v') },
    { name: 'YouTube',      re: /^youtu\.be$/i,                               watch: 'https://youtu.be/',                  embed: (u) => 'https://www.youtube.com/embed/' + pathId(u, 1) },
    { name: 'Vimeo',        re: /(^|\.)vimeo(\.|com$)/i,                      watch: 'https://vimeo.com/',                 embed: (u) => 'https://player.vimeo.com/video/' + pathId(u, 1) },
    { name: 'Dailymotion',  re: /(^|\.)dailymotion(\.|com$)/i,                watch: 'https://www.dailymotion.com/video/', embed: (u) => 'https://www.dailymotion.com/embed/video/' + pathId(u, 2) },
    { name: 'StreamTape',   re: /streamtape\.[a-z]+/i,                        embed: (u) => 'https://www.streamtape.com/embed?link=' + encodeURIComponent(u) },
    { name: 'Streamable',   re: /(^|\.)streamable\.com/i,                     embed: (u) => 'https://streamable.com/e/' + pathId(u, 1) },
    { name: 'Facebook',     re: /(^|\.)facebook\.com|^fb\.watch$/i,           embed: (u) => 'https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(u) },
    { name: 'OK.ru',        re: /(^|\.)ok\.ru$/i,                             embed: (u) => 'https://ok.ru/videoembed/' + pathId(u, 2) },
    { name: 'VK',           re: /(^|\.)vk\.(com|ru)$/i,                       embed: (u) => u.replace('/video', '/video_embed') },
    { name: 'NineShare',    re: /90pvt|nine.?share|90minit/i,                 embed: null },
    { name: 'Vidbom',       re: /vidb(om|oom)\./i,                            embed: (u) => u.replace('/f/', '/e/') },
    { name: 'Upcloud',      re: /upcloud|move365|rct365/i,                    embed: null },
    { name: 'Plist',        re: /playlist(?:it)?\.|watch.(?:pass|passx)/i,    embed: null },
    { name: 'JWPlayer',     re: /jwplayer|content\.jwpltx|rss\.jwplatform|ssl\.jwpltx/i, embed: null }
  ];

  function pathId(url, partIndex) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      return parts[(partIndex || 1) - 1] || '';
    } catch (e) {
      return '';
    }
  }

  function queryId(url, key) {
    try {
      return new URL(url).searchParams.get(key) || '';
    } catch (e) {
      return '';
    }
  }

  /** يسمّي مزود الفيديو إن كان الرابط معروفاً، وإلا يعيد اسم المضيف. */
  function providerName(url) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
    for (const provider of PROVIDERS) {
      if (provider.re.test(host)) return provider.name;
    }
    return host;
  }

  /** يبني رابط embed للمزودات المعروفة؛ يعيد '' إن لم يعرف القالب. */
  function embedUrlFor(url) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return '';
    }
    for (const provider of PROVIDERS) {
      if (!provider.embed) continue;
      if (provider.re.test(host)) {
        try {
          const built = provider.embed(url);
          if (built && /^https?:/i.test(built)) return built;
        } catch (e) {
          /* قالب غير صالح لهذا الرابط */
        }
      }
    }
    return '';
  }

  // ------------------------------------------------------------------
  // قراءة مصدر الوسيط
  // ------------------------------------------------------------------

  /** يستخرج أفضل مصدر مباشر من عنصر وسيط (iframe/embed/video/source…). */
  function mediaSourceOf(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toUpperCase();

    if (tag === 'OBJECT') {
      const data = el.getAttribute('data');
      if (data) return S.absoluteUrl(data);
      const param = el.querySelector && el.querySelector('param[name="movie"]');
      const value = param ? param.getAttribute('value') : '';
      if (value) return S.absoluteUrl(value);
    }

    for (const attr of SRC_ATTRS) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value && S.norm(value)) return S.absoluteUrl(value);
    }

    // مشغّل يوتيوب القديم <video><source>
    if (tag === 'VIDEO' && el.querySelector) {
      const source = el.querySelector('source[src]');
      if (source) return S.absoluteUrl(source.getAttribute('src'));
    }

    // srcdoc — صفحة مضمّنة كاملة داخل الوسم؛ نستخرج أول iframe/src منها
    const srcdoc = el.getAttribute && el.getAttribute('srcdoc');
    if (srcdoc) {
      const match = String(srcdoc).match(/(?:src|data-src)\s*=\s*["']([^"'<>]+)["']/i);
      if (match) return S.absoluteUrl(match[1]);
    }

    // مشغّلات تحلّل المصدر من خاصيات data-* طويلة
    for (const pair of decodeDataAttrs(el)) {
      if (/^https?:/i.test(pair)) return pair;
    }

    return '';
  }

  /** يفحص خصائص data-* ويبحث داخل قيمها عن رابط http(s). */
  function decodeDataAttrs(el) {
    const out = [];
    if (!el || !el.attributes) return out;
    for (const attribute of Array.from(el.attributes)) {
      if (!/^data-/i.test(attribute.name)) continue;
      let value = attribute.value || '';
      // بعض المواقع تمرّر الرابط مشفراً بـ base64 في خاصية data-*
      const candidates = [value];
      try {
        if (/^[A-Za-z0-9+/=%]{20,}$/.test(value)) {
          const decoded = atob(value.replace(/[^A-Za-z0-9+/=]/g, ''));
          if (/https?:/i.test(decoded)) candidates.push(decoded);
        }
      } catch (e) {
        /* ليس base64 */
      }
      for (const candidate of candidates) {
        const match = String(candidate).match(/https?:\/\/[^\s"'<>\\]+/i);
        if (match) out.push(match[0]);
      }
    }
    return out;
  }

  /** هل يبدو الرابط وسيطاً/مشغلاً وليس صفحة عادية؟ */
  function looksLikeMedia(url) {
    if (!url || !/^https?:/i.test(url)) return false;
    if (/^https?:\/\/(www\.)?(youtube\.com\/(embed|v|shorts)|youtu\.be|player\.vimeo\.com)/i.test(url)) return true;
    if (/\/(?:embed|embedding|e)\/|(?:embed|player|watch|video)[?.=]/i.test(url)) return true;
    if (/\.(mp4|m3u8|webm|ogg|mov|mkv|avi|flv|ts)(\?|#|$)/i.test(url)) return true;
    const provider = providerName(url);
    if (provider && PROVIDERS.some((p) => p.name === provider)) return true;
    return false;
  }

  // ------------------------------------------------------------------
  // المسار النسبي إلى عنصر داخل إطار فرعي
  // ------------------------------------------------------------------

  /** مسار CSS نسبي من root إلى el (نفس أسلوب relPath لكن بجذر أي عنصر). */
  function relPathFrom(root, el) {
    if (!root || !el || !root.contains || !root.contains(el) || root === el) return '';
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node !== root && node.nodeType === 1 && guard++ < 25) {
      parts.unshift(S.stepFor(node, true));
      node = node.parentElement;
    }
    if (node !== root) return '';
    return parts.join(' > ');
  }

  /**
   * يبني محدداً مركّباً يصل إلى عنصر داخل إطار فرعي من جذر الصفحة:
   *   iframe:nth-of-type(2) >>> video
   * يعمل فقط في سكربتات all_frames — والخلفية تتحقق من وجوده قبل الاستخدام.
   */
  function frameChainSelector(frameEl, innerSelector) {
    const chain = [];
    let node = frameEl;
    let guard = 0;
    while (node && node.ownerDocument && node.ownerDocument.defaultView &&
           node.ownerDocument.defaultView !== window.top && guard++ < 6) {
      const frameElement = getFrameElementSafe(node.ownerDocument);
      if (!frameElement) break;
      const parentRoot = frameElement.parentElement || frameElement.ownerDocument.documentElement;
      const rel = relPathFrom(parentRoot, frameElement);
      chain.unshift(rel || S.cssPath(frameElement));
      node = frameElement;
    }
    if (!chain.length) return '';
    return chain.join(' >>> ') + ' >>> ' + innerSelector;
  }

  function getFrameElementSafe(doc) {
    try {
      return doc.frameElement;
    } catch (e) {
      return null; // إطار عابر للأصول — لا يمكن الوصول إلى وسمه
    }
  }

  // ------------------------------------------------------------------
  // الالتقاط الذكي عند النقر على عنصر
  // ------------------------------------------------------------------

  /**
   * عند نقر المستخدم على عنصر، يبحث عن أفضل هدف "وسيط" حوله:
   * الوسم نفسه إن كان وسيطاً، أو وسيط داخله، أو وسيط قريب في نفس الحاوية.
   * يعيد { el, selector, path, insideFrame } أو null.
   */
  function nearestMediaAround(el) {
    if (!el || el.nodeType !== 1) return null;
    const selfTag = el.tagName.toUpperCase();
    if (MEDIA_TAGS.has(selfTag)) return describeMediaTarget(el, el);

    const inner = el.querySelector && el.querySelector(EMBED_SELECTOR);
    if (inner) return describeMediaTarget(inner, el);

    // أخوة/أعمام قريبون — كثير من الصفوف تضع iframe بجانب العنوان
    let node = el;
    let guard = 0;
    while (node && node !== document.body && guard++ < 4) {
      const parent = node.parentElement;
      if (!parent) break;
      const sibling = parent.querySelector && parent.querySelector(EMBED_SELECTOR);
      if (sibling && sibling !== node) return describeMediaTarget(sibling, el);
      node = parent;
    }
    return null;
  }

  function describeMediaTarget(mediaEl, clickedEl) {
    const inFrame = isInsideSubframe(mediaEl);
    let selector = '';
    let path = '';
    if (inFrame) {
      const frameRoot = ownerFrameHost(mediaEl);
      const inner = frameRoot ? relPathFrom(frameRoot, mediaEl) : '';
      selector = frameRoot ? frameChainSelector(frameRoot, inner || cssish(mediaEl)) : '';
      path = selector;
    } else {
      selector = S.relPath(document.body, mediaEl, { childOnly: false }) || S.cssPath(mediaEl);
      path = S.cssPath(mediaEl);
    }
    return {
      el: mediaEl,
      selector: selector || '',
      path: path || '',
      insideFrame: !!inFrame,
      clickedText: S.norm(clickedEl && clickedEl.textContent).slice(0, 60)
    };
  }

  function cssish(el) {
    return S.cssPath(el);
  }

  function isInsideSubframe(el) {
    try {
      return !!(el && el.ownerDocument && el.ownerDocument !== window.top.document);
    } catch (e) {
      return true; // مستند معزول — نتعامل معه كأنه داخل إطار
    }
  }

  /** حاوية الإطار الذي يسكن فيه العنصر (html أو body جذر مستنده). */
  function ownerFrameHost(el) {
    try {
      const doc = el.ownerDocument;
      return doc.documentElement || doc.body || null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // فحص شامل للصفحة (يُستخدم في EXTRACT و SCAN_MEDIA)
  // ------------------------------------------------------------------

  /** يعدّ كل وسط iframe/embed/object/video في المستند الحالي. */
  function scanLocal() {
    const found = [];
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(EMBED_SELECTOR));
    } catch (e) {
      nodes = [];
    }
    for (const el of nodes) {
      const src = mediaSourceOf(el);
      if (!src) continue;
      found.push({
        tag: el.tagName.toLowerCase(),
        src: src,
        provider: providerName(src),
        id: el.id || '',
        name: el.getAttribute('name') || '',
        classes: S.stableClasses(el, 3).join(' '),
        title: el.getAttribute('title') || '',
        width: parseInt(el.getAttribute('width') || '0', 10) || 0,
        height: parseInt(el.getAttribute('height') || '0', 10) || 0,
        selector: S.relPath(document.body, el, { childOnly: false }) || S.cssPath(el),
        path: S.cssPath(el)
      });
    }
    return found;
  }

  SC.media = {
    EMBED_SELECTOR: EMBED_SELECTOR,
    MEDIA_TAGS: MEDIA_TAGS,
    PROVIDERS: PROVIDERS,
    providerName: providerName,
    embedUrlFor: embedUrlFor,
    mediaSourceOf: mediaSourceOf,
    looksLikeMedia: looksLikeMedia,
    relPathFrom: relPathFrom,
    frameChainSelector: frameChainSelector,
    nearestMediaAround: nearestMediaAround,
    isInsideSubframe: isInsideSubframe,
    scanLocal: scanLocal
  };
})();
