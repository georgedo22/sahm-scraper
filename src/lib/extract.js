/* ------------------------------------------------------------------
 * صهم — src/lib/extract.js
 * منطق "التعلّم": اشتقاق حاوية الصفوف المتكرّرة من العناصر التي نقر عليها
 * المستخدم، ثم استخراج كل الصفوف المشابهة وقيم الحقول منها.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const SC = (globalThis.SCX = globalThis.SCX || {});
  if (SC.ex) return;
  const S = SC.sel;

  // ------------------------------------------------------------------
  // استخراج القيم
  // ------------------------------------------------------------------

  /** يحدّد أول عنصر يطابق محدد الحقل داخل الصف. */
  function firstNode(row, field) {
    if (!field.selector) return null;
    try {
      return row.querySelector(field.selector) || null;
    } catch (e) {
      return null;
    }
  }

  function allNodes(row, field) {
    if (!field.selector) return [];
    try {
      return Array.from(row.querySelectorAll(field.selector));
    } catch (e) {
      return [];
    }
  }

  function rawValue(el, field) {
    if (!el) return '';
    const type = field.type || 'text';
    const attr = field.attr || '';

    if (type === 'html') return String(el.innerHTML || '').trim();

    if (type === 'attr') {
      if (!attr) return '';
      const value = el.getAttribute(attr);
      return value == null ? '' : S.norm(value);
    }

    if (type === 'href') {
      const name = attr || 'href';
      let value = el.getAttribute(name);
      if (!value) {
        const anchor =
          (el.closest && el.closest('a[href], area[href]')) ||
          (el.querySelector && el.querySelector('a[href], area[href]'));
        value = anchor ? anchor.getAttribute('href') : '';
      }
      return S.absoluteUrl(value);
    }

    if (type === 'src') {
      const name = attr || 'src';
      let value = el.getAttribute(name);
      if (!value) value = S.bestImageUrl(el.querySelector && el.querySelector('img')) || '';
      return S.absoluteUrl(value, name);
    }

    if (type === 'image' || type === 'background') {
      const direct = S.bestImageUrl(el);
      if (direct) return direct;
      const imgs = el.querySelectorAll ? Array.from(el.querySelectorAll('img, picture source')) : [];
      let best = '';
      let bestScore = -1;
      for (const img of imgs) {
        const url = S.bestImageUrl(img);
        if (!url) continue;
        const width = parseInt(img.getAttribute('width') || '0', 10) || img.naturalWidth || 0;
        const height = parseInt(img.getAttribute('height') || '0', 10) || img.naturalHeight || 0;
        const score = width * height || url.length;
        if (score > bestScore) {
          bestScore = score;
          best = url;
        }
      }
      if (best) return best;
      const lazy = el.querySelector ? el.querySelector('[data-src],[data-original],[data-lazy-src],[data-bg]') : null;
      if (lazy) {
        const url = S.bestImageUrl(lazy);
        if (url) return url;
      }
      return S.backgroundImageUrl(el);
    }

    if (type === 'number') {
      const text = S.norm(el.textContent);
      const match = text.replace(/[٬,]/g, '').match(/-?\d+(?:\.\d+)?/);
      return match ? match[0] : '';
    }

    if (type === 'datetime') {
      return el.getAttribute('datetime') || S.norm(el.textContent);
    }

    return S.norm(el.textContent);
  }

  /** قيمة حقل واحد داخل صف واحد. */
  function valueOf(row, field) {
    if ((field.type || 'text') === 'list') {
      const nodes = allNodes(row, field);
      const parts = [];
      for (const node of nodes) {
        const value = rawValue(node, Object.assign({}, field, { type: field.itemType || 'text' }));
        if (value) parts.push(value);
      }
      return parts.join(field.separator || ' | ');
    }
    return rawValue(firstNode(row, field), field);
  }

  // ------------------------------------------------------------------
  // إيجاد الصفوف المتكرّرة
  // ------------------------------------------------------------------

  /**
   * يجد كل صفوف البيانات: أبناء الحاويات المطابقة للمحدد الأب،
   * الذين يشبهون البصمة البنيوية للصف النموذجي.
   */
  function findRows(job) {
    const empty = [];
    if (!job || !job.parentSelector) return empty;

    let parents;
    try {
      parents = Array.from(document.querySelectorAll(job.parentSelector));
    } catch (e) {
      return empty;
    }
    if (!parents.length) return empty;

    const sig = job.itemSignature;
    const threshold = typeof job.threshold === 'number' ? job.threshold : 0.6;
    const seen = new Set();
    const candidates = [];

    for (const parent of parents) {
      for (const child of parent.children) {
        if (seen.has(child)) continue;
        seen.add(child);
        if (sig && S.similarity(S.signature(child), sig) < threshold) continue;
        candidates.push(child);
      }
    }
    if (!candidates.length) return empty;

    // إزالة الصفوف المتداخلة (صف يحتوي صفاً آخر) لتفادي التكرار المضاعف.
    let rows = candidates;
    if (candidates.length <= 800) {
      const set = new Set(candidates);
      rows = candidates.filter((row) => {
        for (const other of set) {
          if (other !== row && other.contains(row)) return false;
        }
        return true;
      });
    }

    // إبقاء الصفوف التي تُحلّ فيها أغلب الحقول — يستبعد الإعلانات والفراغات البنيوية.
    const fields = (job.fields || []).filter((f) => f.selector);
    if (fields.length && rows.length > 2) {
      const needed = Math.max(1, Math.ceil(fields.length * 0.5));
      const kept = rows.filter((row) => {
        let hits = 0;
        for (const field of fields) {
          if (firstNode(row, field)) hits++;
        }
        return hits >= needed;
      });
      if (kept.length >= 2) rows = kept;
    }
    return rows;
  }

  /** يستخرج صفحة كاملة: مصفوفة كائنات، مفتاح كل واحد اسم الحقل. */
  function extractPage(job) {
    const rows = findRows(job);
    const fields = (job.fields || []).filter((f) => f.name);
    const data = rows.map((row) => {
      const record = {};
      for (const field of fields) record[field.name] = valueOf(row, field);
      return record;
    });
    const result = { rows: data, itemCount: rows.length };
    // في وضع الصفحات المفصّلة نُعيد روابط الدخول بنفس ترتيب الصفوف،
    // فيبقى الاقتران بين كل صف وهدفه مضموناً بلا مطابقة لاحقة.
    if (job.detail && job.detail.enabled) result.links = rowLinks(job, rows);
    return result;
  }

  // ------------------------------------------------------------------
  // الصفحات المفصّلة (المستوى الثاني)
  // ------------------------------------------------------------------

  /** رابط قابل للاستخدام للدخول (يستبعد الفواصل والروابط الميتة ونفس الصفحة). */
  function usableHref(href) {
    if (!href) return false;
    const value = String(href).trim();
    if (!value || value === '#' || value.charAt(0) === '#') return false;
    if (/^(javascript|mailto|tel|data|blob):/i.test(value)) return false;
    const strip = (url) => String(url).split('#')[0].replace(/\/$/, '');
    if (strip(value) === strip(location.href)) return false;
    return /^https?:/i.test(value);
  }

  /** رابط الدخول لكل صف، بنفس ترتيب الصفوف. */
  function rowLinks(job, rows) {
    const selector = (job && job.detail && job.detail.linkSelector) || '';
    const out = [];
    for (const row of rows) {
      let el = null;
      if (selector) {
        try {
          el = row.querySelector(selector);
        } catch (e) {
          el = null;
        }
        // قد يكون المحدد الملتقط هو الصف نفسه (بطاقة كاملة قابلة للنقر)
        if (!el && row.matches) {
          try {
            if (row.matches(selector)) el = row;
          } catch (e) {
            el = null;
          }
        }
      }
      if (!el) {
        if (row.tagName === 'A' && row.getAttribute('href')) el = row;
        else el = row.querySelector('a[href]');
      }
      const raw = el ? S.absoluteUrl(el.getAttribute('href') || '', location.href) : '';
      out.push({
        href: usableHref(raw) ? raw : '',
        text: el ? S.norm(el.textContent).slice(0, 80) : ''
      });
    }
    return out;
  }

  /**
   * تعلّم حقول صفحة التفاصيل. لا يوجد تكرار في هذه الصفحة، فالمبدأ مختلف:
   * نتّخذ أعمق أب مشترك كحاوية، ونخزّن لكل حقل مساراً نسبياً داخلها
   * ومساراً مطلقاً كاحتياط — فإن تغيّر أحدهما سلكنا الآخر.
   */
  function analyzeDetail(entries) {
    const live = (entries || []).filter((entry) => entry && entry.el && entry.el.isConnected);
    if (!live.length) return null;

    const container = S.lowestCommonAncestor(live.map((entry) => entry.el)) || document.body;
    const containerSelector = S.cssPath(container);

    const fields = live.map((entry) => {
      let strict = '';
      let relaxed = '';
      try {
        strict = S.relPath(container, entry.el, { childOnly: true });
        relaxed = S.relPath(container, entry.el, { childOnly: false });
      } catch (e) {
        strict = '';
        relaxed = '';
      }
      const resolvable = (selector) => {
        if (!selector) return false;
        try {
          return !!container.querySelector(selector);
        } catch (e) {
          return false;
        }
      };
      const selector = resolvable(strict) ? strict : resolvable(relaxed) ? relaxed : strict || relaxed || '';
      return {
        name: entry.name,
        type: entry.type || 'text',
        attr: entry.attr || '',
        separator: entry.separator || '',
        path: entry.path || S.cssPath(entry.el),
        selector: selector,
        missing: 0
      };
    });

    const detail = { containerSelector: containerSelector, fields: fields };
    const sample = extractDetail(detail);
    return {
      containerSelector: containerSelector,
      fields: fields,
      itemCount: 1,
      rowCount: 1,
      preview: [sample.values]
    };
  }

  /** يقرأ حقول التفاصيل من الصفحة الحالية وفق خطة التعلّم. */
  function extractDetail(detail) {
    const fields = (detail && detail.fields) || [];
    const values = {};
    let container = null;

    if (detail && detail.containerSelector) {
      try {
        container = document.querySelector(detail.containerSelector);
      } catch (e) {
        container = null;
      }
    }

    let found = 0;
    for (const field of fields) {
      // مهم: العنصر المطابق هو الهدف نفسه، فقراءته تكون منه مباشرة.
      // (valueOf تبحث داخل الصف عن محدد الحقل، وهذا صحيح في صفوف القائمة
      //  لا هنا — لأن حقل التفاصيل هو الهدف لا حاوٍ له.)
      let nodes = [];
      if (container && field.selector) {
        try {
          nodes = Array.from(container.querySelectorAll(field.selector));
        } catch (e) {
          nodes = [];
        }
      }
      if (!nodes.length && field.path) {
        try {
          const node = document.querySelector(field.path);
          if (node) nodes = [node];
        } catch (e) {
          nodes = [];
        }
      }

      const parts = nodes.map((node) => rawValue(node, field)).filter((value) => value !== '');
      if ((field.type || 'text') === 'list') {
        values[field.name] = parts.join(field.separator || ' | ');
      } else {
        values[field.name] = parts.length ? parts[0] : '';
      }
      if (parts.length) found++;
    }
    return { values: values, found: found, total: fields.length };
  }

  // ------------------------------------------------------------------
  // التعلّم: من نقرات المستخدم إلى محددات جاهزة
  // ------------------------------------------------------------------

  /** تخمين نوع البيانات من العنصر الذي نُقر عليه. */
  function guessType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'picture' || tag === 'source' || tag === 'svg') {
      return { type: 'image' };
    }
    if (tag === 'a' && el.getAttribute('href')) return { type: 'href' };
    if (tag === 'time' || el.hasAttribute('datetime')) return { type: 'datetime' };
    if (tag === 'video' && el.getAttribute('src')) return { type: 'src', attr: 'src' };

    const text = S.norm(el.textContent);
    if (!text) {
      if (el.querySelector('img, picture source')) return { type: 'image' };
      const anchor = el.querySelector('a[href]');
      if (anchor) return { type: 'href' };
      if (el.getAttribute('title')) return { type: 'attr', attr: 'title' };
      return { type: 'text' };
    }
    if (/^-?[\d٬,.\s]+$/.test(text) && /\d/.test(text)) return { type: 'number' };
    return { type: 'text' };
  }

  /**
   * المشي صعوداً من أعمق أب مشترك حتى إيجاد المستوى الذي يتكرّر فيه العنصر
   * بين أشقائه — هذا هو "صف البيانات".
   */
  function findRepeatLevel(startNode) {
    let node = startNode;
    let guard = 0;
    while (node && node !== document.body && node !== document.documentElement && guard++ < 25) {
      const siblings = S.similarSiblings(node);
      if (siblings.length >= 1) return { container: node, items: [node].concat(siblings) };
      node = node.parentElement;
    }
    return { container: startNode, items: [startNode] };
  }

  /**
   * يبني خطة السحب الكاملة من قائمة الحقول الملتقطة.
   * entries: [{ name, type, attr, path, el }]
   * options.forceContainer: عنصر يستخدم كصف نموذجي بدل الاكتشاف التلقائي.
   */
  function analyze(job, entries, options) {
    const live = (entries || []).filter((entry) => entry && entry.el && entry.el.isConnected);
    if (live.length === 0) return null;

    const forced = options && options.forceContainer;
    const anchor = S.lowestCommonAncestor(live.map((entry) => entry.el));
    if (!anchor && !forced) return null;

    const repeat = forced
      ? { container: forced, items: [forced].concat(S.similarSiblings(forced)) }
      : findRepeatLevel(anchor);
    const container = repeat.container;
    const items = repeat.items;
    const parent = container.parentElement;
    if (!parent) return null;

    const parentSelector = S.cssPath(parent);
    const itemSignature = S.signature(container);
    const need = Math.max(1, Math.ceil(items.length * 0.6));

    const fields = live.map((entry) => {
      // حقل خارج الحاوية المختارة يدوياً لا يمكن اشتقاق مسار نسبي له
      if (!container.contains(entry.el)) {
        return {
          name: entry.name,
          type: entry.type || 'text',
          attr: entry.attr || '',
          path: entry.path || '',
          selector: '',
          missing: items.length
        };
      }
      const strict = S.relPath(container, entry.el, { childOnly: true });
      const relaxed = S.relPath(container, entry.el, { childOnly: false });
      const hits = (selector) => {
        if (!selector) return 0;
        let count = 0;
        for (const item of items) {
          try {
            if (item.querySelector(selector)) count++;
          } catch (e) {
            /* محدد غير صالح */
          }
        }
        return count;
      };

      let selector = '';
      if (strict && hits(strict) >= need) selector = strict;
      else if (relaxed && hits(relaxed) >= need) selector = relaxed;
      else selector = strict || relaxed || '';

      return {
        name: entry.name,
        type: entry.type || 'text',
        attr: entry.attr || '',
        path: entry.path || S.cssPath(entry.el),
        selector: selector,
        missing: Math.max(0, items.length - hits(selector))
      };
    });

    const containerClasses = S.stableClasses(container, 2);
    const itemSelector =
      parentSelector +
      ' > ' +
      container.tagName.toLowerCase() +
      containerClasses.map((c) => '.' + S.cssEscape(c)).join('');

    const previewJob = {
      parentSelector: parentSelector,
      itemSignature: itemSignature,
      fields: fields,
      threshold: 0.6
    };

    // نعتمد الصفوف المُتحقَّق منها (التي توجد فيها الحقول فعلاً) في العدّ
    // وحساب "المفقود"، حتى لا تُحسب إعلانات أو أشرطة جانبية كصفوف بيانات.
    let finalItems = findRows(previewJob);
    if (!finalItems.length) finalItems = items;

    for (const field of fields) {
      let found = 0;
      for (const item of finalItems) {
        try {
          if (field.selector && item.querySelector(field.selector)) found++;
        } catch (e) {
          /* محدد غير صالح */
        }
      }
      field.missing = Math.max(0, finalItems.length - found);
    }

    const preview = finalItems.map((row) => {
      const record = {};
      for (const field of fields) record[field.name] = valueOf(row, field);
      return record;
    });

    return {
      parentSelector: parentSelector,
      itemSignature: itemSignature,
      itemSelector: itemSelector,
      itemCount: finalItems.length,
      rowCount: finalItems.length,
      fields: fields,
      preview: preview.slice(0, 3)
    };
  }

  SC.ex = {
    findRows: findRows,
    extractPage: extractPage,
    valueOf: valueOf,
    firstNode: firstNode,
    guessType: guessType,
    analyze: analyze,
    analyzeDetail: analyzeDetail,
    extractDetail: extractDetail,
    rowLinks: rowLinks,
    usableHref: usableHref
  };
})();
