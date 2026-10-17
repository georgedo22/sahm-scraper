/* ------------------------------------------------------------------
 * صهم — src/lib/selector.js
 * أدوات مشتركة: توليد محددات CSS مستقرة، وقياس تشابه العناصر المتكرّرة،
 * واشتقاق المسارات النسبية من حاوية الصف إلى كل حقل.
 * تُحمَّل كسكربت محتوى عادي (بدون وحدات ES) وتُشارك عبر globalThis.SCX.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const SC = (globalThis.SCX = globalThis.SCX || {});
  if (SC.sel) return;

  // أصناف تُولَّد آلياً بواسطة أطر العمل ولا تصلح كمحدّد مستقر
  const NOISE_PREFIX = /^(css|sc|jsx|emotion|styled|svelte|v|tw|chakra|ant|mantine)-/i;
  const HASHY = /^[0-9a-f]{6,}$/i;                       // 3f9a2b1c
  const RANDOM_MIX = /[a-z]{1,4}\d{2,}[a-z]{1,4}\d{2,}/i; // x1a2b3
  const MANY_DIGITS = /\d{3,}/;
  const MAX_CLASS_USES = 3000; // صنف منتشر في آلاف العناصر لا يميّز شيئاً

  const classUses = new Map();
  let classUsesStamp = 0;

  function cssEscape(value) {
    const s = String(value == null ? '' : value);
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  }

  /** توحيد المسافات: يحوّل كل فراغات HTML المتعددة إلى فراغ واحد. */
  function norm(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function classUseCount(name) {
    const now = Date.now();
    if (now - classUsesStamp > 3000) {
      classUses.clear();
      classUsesStamp = now;
    }
    if (classUses.has(name)) return classUses.get(name);
    let count = 0;
    try {
      count = document.getElementsByClassName(name).length;
    } catch (e) {
      count = 0;
    }
    classUses.set(name, count);
    return count;
  }

  /** هل يصلح اسم الصنف كمحدّد ثابت لا يتغيّر بين تحميل وآخر؟ */
  function isStableToken(token) {
    if (!token || token.length > 32) return false;
    if (NOISE_PREFIX.test(token)) return false;
    if (HASHY.test(token)) return false;
    if (RANDOM_MIX.test(token)) return false;
    if (MANY_DIGITS.test(token)) return false;
    if (/^\d/.test(token)) return false;
    if (/^[_-]/.test(token)) return false;
    if (/^(active|selected|hover|focus|open|show|hidden|current|loaded)$/i.test(token)) return false;
    return true;
  }

  function stableClasses(el, limit) {
    const max = limit || 3;
    const out = [];
    const list = el.classList ? Array.from(el.classList) : [];
    for (const cls of list) {
      if (!isStableToken(cls)) continue;
      if (classUseCount(cls) > MAX_CLASS_USES) continue;
      out.push(cls);
      if (out.length >= max) break;
    }
    return out;
  }

  function nthOfType(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    let index = 1;
    for (const child of parent.children) {
      if (child === el) break;
      if (child.tagName === el.tagName) index++;
    }
    return tag + ':nth-of-type(' + index + ')';
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function countMatches(root, selector) {
    if (!selector) return 0;
    try {
      return root.querySelectorAll(selector).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * خطوة واحدة داخل المسار.
   * preferClass = true (للمسارات النسبية): نفضّل اسم الصنف حتى لو تكرّر بين
   * الأخوة — هذا أدقّ مع تغيّر ترتيب العناصر وضروري لحقول "القائمة".
   * preferClass = false (للمسار المطلق): نضمن التفرّد عبر nth-of-type.
   */
  function stepFor(el, preferClass) {
    const tag = el.tagName.toLowerCase();
    const classes = stableClasses(el);
    const parent = el.parentElement;

    if (parent) {
      const selector = classes.length ? tag + classes.map((c) => '.' + cssEscape(c)).join('') : tag;
      try {
        const matches = Array.from(parent.querySelectorAll(':scope > ' + selector));
        if (preferClass) {
          // يكفي أن يكون العنصر أول مطابقة، فيبقى المحدد صالحاً لأي فهرس
          if (matches.length && matches[0] === el) return selector;
        } else if (matches.length === 1) {
          return selector;
        }
      } catch (e) {
        /* :scope غير مدعوم في سياق نادر — نتجاهل ونكمل */
      }
    }
    return nthOfType(el);
  }

  /** مسار مطلق فريد من جذر المستند إلى العنصر. */
  function cssPath(el, maxDepth) {
    if (!el || el.nodeType !== 1) return '';
    const limit = maxDepth || 12;

    if (el.id && isStableToken(el.id)) {
      const byId = '#' + cssEscape(el.id);
      if (isUnique(byId)) return byId;
    }

    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < limit) {
      if (node.id && isStableToken(node.id)) {
        const byId = '#' + cssEscape(node.id);
        if (isUnique(byId)) {
          parts.unshift(byId);
          break;
        }
      }
      parts.unshift(stepFor(node, false));
      if (isUnique(parts.join(' > '))) break;
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /**
   * مسار نسبي من الحاوية (صف البيانات) إلى العنصر المطلوب.
   * childOnly = true يعني استخدام المحور المباشر (>) وهو الأدق.
   */
  function relPath(container, el, options) {
    const childOnly = !options || options.childOnly !== false;
    if (!container || !el || !container.contains(el)) return '';
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node !== container && node.nodeType === 1 && guard++ < 25) {
      parts.unshift(stepFor(node, true));
      node = node.parentElement;
    }
    if (node !== container) return '';
    return parts.join(childOnly ? ' > ' : ' ');
  }

  /** بصمة بنيوية للعنصر تُستخدم لمقارنة الأشقاء المتشابهين. */
  function signature(el) {
    return {
      tag: el && el.tagName ? el.tagName.toLowerCase() : '',
      classes: el && el.classList ? Array.from(el.classList) : []
    };
  }

  /**
   * تشابه بنيوي بين عنصرين: 0 = مختلف تماماً، 1 = متطابق.
   * نأخذ الأكثر تسامحاً بين جاكارد والاحتواء، لأن عنصراً واحداً قد يحمل
   * صنفاً إضافياً (مثل "مميّز" أو "مثبّت"). الدقّة النهائية تأتي لاحقاً من
   * اختبار وجود الحقول داخل كل صف.
   */
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a.tag !== b.tag) return 0;
    const setA = new Set(a.classes || []);
    const setB = new Set(b.classes || []);
    if (!setA.size && !setB.size) return 1;
    let shared = 0;
    for (const item of setA) if (setB.has(item)) shared++;
    if (!shared) return 0;
    const union = setA.size + setB.size - shared;
    const jaccard = shared / union;
    const min = Math.min(setA.size, setB.size);
    const containment = min ? shared / min : 0;
    return Math.max(jaccard, containment);
  }

  /** كل الأشقاء المشابهين للعنصر داخل نفس الأب (يستثني العنصر نفسه). */
  function similarSiblings(el, threshold) {
    const parent = el && el.parentElement;
    if (!parent) return [];
    const min = typeof threshold === 'number' ? threshold : 0.6;
    const sig = signature(el);
    const out = [];
    for (const child of parent.children) {
      if (child === el) continue;
      if (similarity(signature(child), sig) >= min) out.push(child);
    }
    return out;
  }

  /** أعمق أب مشترك يحتوي كل العناصر المعطاة. */
  function lowestCommonAncestor(elements) {
    const list = (elements || []).filter((el) => el && el.nodeType === 1);
    if (!list.length) return null;
    let node = list[0];
    while (node && !list.every((el) => node.contains(el))) node = node.parentElement;
    return node;
  }

  /** يحوّل قيمة نسبية إلى رابط مطلق، ويفكّ srcset. */
  function absoluteUrl(value, attrName) {
    let raw = norm(value);
    if (!raw) return '';
    if ((attrName || '').toLowerCase() === 'srcset') {
      const first = raw.split(',')[0].trim().split(/\s+/)[0];
      raw = first || raw;
    }
    if (/^(data|blob|javascript):/i.test(raw)) return raw;
    try {
      return new URL(raw, (globalThis.location && location.href) || undefined).href;
    } catch (e) {
      return raw;
    }
  }

  /** يستخرج أفضل رابط صورة ممكن من عنصر <img> أو <source>. */
  function bestImageUrl(node) {
    if (!node) return '';
    if (node.tagName === 'SOURCE') {
      const fromSet = node.getAttribute('srcset');
      if (fromSet) return absoluteUrl(fromSet, 'srcset');
    }
    const srcset = node.getAttribute && node.getAttribute('srcset');
    if (srcset) {
      const candidates = srcset
        .split(',')
        .map((part) => {
          const bits = part.trim().split(/\s+/);
          const url = bits[0];
          const size = parseFloat((bits[1] || '').replace(/[a-z]/gi, '')) || 0;
          return { url: url, size: size };
        })
        .filter((c) => c.url);
      if (candidates.length) {
        candidates.sort((a, b) => b.size - a.size);
        return absoluteUrl(candidates[0].url);
      }
    }
    const lazyAttrs = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-echo', 'data-url'];
    for (const attr of lazyAttrs) {
      const value = node.getAttribute && node.getAttribute(attr);
      if (value && !/^data:image\/gif;base64,R0lGODlhAQAB/i.test(value)) return absoluteUrl(value);
    }
    return '';
  }

  /** صورة الخلفية إن كان العنصر يعتمد على CSS. */
  function backgroundImageUrl(el) {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg && bg.match(/url\(["']?(.*?)["']?\)/i);
      if (match && match[1]) return absoluteUrl(match[1]);
    } catch (e) {
      /* لا شيء */
    }
    return '';
  }

  SC.sel = {
    cssEscape: cssEscape,
    norm: norm,
    isStableToken: isStableToken,
    stableClasses: stableClasses,
    cssPath: cssPath,
    relPath: relPath,
    stepFor: stepFor,
    signature: signature,
    similarity: similarity,
    similarSiblings: similarSiblings,
    lowestCommonAncestor: lowestCommonAncestor,
    absoluteUrl: absoluteUrl,
    bestImageUrl: bestImageUrl,
    backgroundImageUrl: backgroundImageUrl,
    isUnique: isUnique,
    countMatches: countMatches
  };
})();
