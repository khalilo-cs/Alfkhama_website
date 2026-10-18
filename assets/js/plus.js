/* شرح بالعربية: هذا الملف طبقة تحسينات اختيارية فوق السكربت الرئيسي داخل index.html (الصفحة الرئيسية وصفحات */
/* المتجر). */
/* يضيف: اقتراحات بحث فورية، شريط "شاهدتها مؤخرًا"، أسهم وتكبير وسحب لمعرض الصور، روابط أقسام في الواجهة، */
/* بطاقة "ثبّت التطبيق"، وتنبيهات الاتصال ومزامنة السلة بين التبويبات. تنسيقه في assets/css/plus.css. */
/* يعتمد على متغيرات ودوال معرّفة عالميًا في السكربت الرئيسي (PRODUCTS وesc وtoast وغيرها)، ولا يعمل وحده. */
/* Storefront enhancement layer (no dependencies). Loaded after the page's main script, so it can use its helpers
   (PRODUCTS, catalogState, searchTokens, matchesTerm, highlightHtml, toast, setGalleryImage, setPageImage …).
   Progressive: every module is isolated, and the page works without any of them. */
// دالة فورية تعزل المتغيرات هنا عن النطاق العالمي كي لا تتعارض مع السكربت الرئيسي.
(() => {
  // الوضع الصارم يكشف الأخطاء البرمجية الصامتة.
  'use strict';
  // اختصاران لاختيار العناصر: $ لعنصر واحد، و$$ لقائمة عناصر كمصفوفة حقيقية.
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  // كل وحدة تعمل داخل guard: إن فشلت وحدة لسبب ما لا تتأثر بقية الوحدات ولا الصفحة، ويُسجَّل سبب الفشل فقط.
  const guard = (name, fn) => { try { fn(); } catch (error) { console.info('Storefront enhancement unavailable: ' + name, error); } };
  // هل حُمّل الكتالوج (المنتجات والأقسام) من الخادم؟ المتغير catalogState معرّف في السكربت الرئيسي.
  const ready = () => typeof catalogState !== 'undefined' && catalogState === 'ready';
  // ينفّذ الدالة فورًا إن كان الكتالوج جاهزًا، وبعد ذلك عند كل إطلاق للحدث catalog:ready (مثلًا بعد التحديث).
  const whenReady = fn => { if (ready()) fn(); document.addEventListener('catalog:ready', fn); };

  /* ------------------------------------------------------------------ instant search suggestions (combobox) */
  guard('search', () => {
    // نربط حقل البحث بقائمة الاقتراحات #searchSuggest؛ إن غاب أي عنصر نتوقف دون خطأ.
    const input = $('#searchInput'), box = $('#searchSuggest'), form = $('#searchBar'), status = $('#searchStatus');
    if (!input || !box || !form) return;
    // سمات ARIA تجعل الحقل "combobox" ليفهمه قارئ الشاشة: قائمة اقتراحات تُفتح وتُغلق ويُحدَّد فيها خيار نشط.
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'searchSuggest');
    // options: عناصر الاقتراحات المعروضة، active: فهرس الخيار المحدد بالأسهم (-1 = لا شيء)، timer: مؤقّت
    // التأخير.
    let options = [], active = -1, timer = 0;
    // إغلاق القائمة وإعادة الحالة إلى الأصل.
    const close = () => {
      box.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; options = [];
    };
    // تحديد خيار بالفهرس i: يحدّث aria-selected وaria-activedescendant ويمرّر القائمة لإظهار الخيار.
    const mark = i => {
      active = i;
      options.forEach((el, k) => el.setAttribute('aria-selected', String(k === i)));
      if (i >= 0 && options[i]) { input.setAttribute('aria-activedescendant', options[i].id); options[i].scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    };
    // رسالة صوتية/نصية لقارئ الشاشة في عنصر #searchStatus (إن وُجد) عن عدد النتائج.
    const say = text => { if (status) status.textContent = text; };
    // بناء قائمة الاقتراحات من المنتجات الحالية: أول 5 نتائج مرتبة حسب الصلة مع رابط "عرض كل النتائج".
    function render() {
      // نقصّ النص إلى 100 حرف كحد أقصى قبل البحث.
      const term = input.value.trim().slice(0, 100);
      if (document.activeElement !== input) return; // the visitor already moved on
      // لا نعرض اقتراحات إلا بعد حرفين على الأقل وبعد جاهزية الكتالوج.
      if (term.length < 2 || !ready()) { close(); say(''); return; }
      const tokens = searchTokens(term);
      const all = matchProducts(PRODUCTS, term).sort((a, b) => relevance(b, tokens) - relevance(a, tokens));
      const hits = all.slice(0, 5);
      if (!hits.length) {
        // أي نص مصدره المستخدم أو بيانات المنتجات يمر عبر esc() قبل إدخاله في HTML لمنع حقن الشيفرة (XSS).
        box.innerHTML = `<div class="suggest-empty" role="option" aria-disabled="true" id="sg-none">لا توجد نتائج لـ «${esc(term)}». جرّب كلمة أخرى.</div>`;
        options = []; active = -1; box.hidden = false; input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
        say('لا توجد نتائج مطابقة'); return;
      }
      box.innerHTML = hits.map((p, i) => `<div class="suggest-item" role="option" id="sg-${i}" aria-selected="false" data-href="${esc(productUrl(p))}"><img src="${esc(p.thumb || p.image)}" alt="" width="52" height="52" loading="lazy" decoding="async"><span><b>${highlightHtml(p.name, term)}</b><small>${esc(p.categoryName || 'ستائر وأقمشة')}</small><small class="suggest-price">${priceHtml(p)}</small></span></div>`).join('')
        + `<div class="suggest-all" role="option" id="sg-all" aria-selected="false" data-href="/products?q=${encodeURIComponent(term)}"><span>عرض كل النتائج (${amount(all.length)})</span>${icons.arrow}</div>`;
      options = [...box.querySelectorAll('[role=option]')];
      box.hidden = false; input.setAttribute('aria-expanded', 'true'); mark(-1);
      say(`${countAr(all.length)} مطابقة. استخدم السهمين للأعلى والأسفل ثم Enter.`);
    }
    // تأخير 140 ملّي ثانية بعد آخر ضغطة (debounce) حتى لا نعيد بناء القائمة مع كل حرف.
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 140); });
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) render(); });
    // لوحة المفاتيح: الأسهم للتنقل، Enter لفتح الخيار المحدد، Escape للإغلاق، Tab لمغادرة الحقل.
    input.addEventListener('keydown', e => {
      const open = !box.hidden && options.length > 0;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { render(); return; } mark((active + 1) % options.length); }
      else if (e.key === 'ArrowUp') { if (!open) return; e.preventDefault(); mark((active - 1 + options.length) % options.length); }
      else if (e.key === 'Enter' && open && active >= 0) { e.preventDefault(); location.href = options[active].dataset.href; }
      else if (e.key === 'Escape' && !box.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') close();
    });
    // منع الفأرة من سحب التركيز من الحقل عند الضغط على اقتراح؛ فيعمل النقر قبل أن تُغلق القائمة.
    box.addEventListener('mousedown', e => e.preventDefault()); // keep the caret in the field
    box.addEventListener('click', e => { const o = e.target.closest('[data-href]'); if (o) location.href = o.dataset.href; });
    // إغلاق القائمة عند خروج التركيز من النموذج كله؛ التأخير 60ms يتيح للنقر على اقتراح أن يُنفَّذ أولًا.
    form.addEventListener('focusout', e => { if (!form.contains(e.relatedTarget)) setTimeout(close, 60); });
    form.addEventListener('submit', close);
    document.addEventListener('click', e => { if (!form.contains(e.target)) close(); });
    document.addEventListener('catalog:ready', () => { if (document.activeElement === input) render(); });
  });

  /* ------------------------------------------------------------------ recently viewed strip */
  guard('recent', () => {
    // المفتاح في localStorage الذي تُحفظ فيه معرّفات المنتجات المشاهدة (يكتبها السكربت الرئيسي ويطلق الحدث
    // recent:update).
    const KEY = 'fakhama-recent-v1';
    // قراءة آمنة للقائمة عبر safeLoad (معرّفة في السكربت الرئيسي)؛ نتأكد أنها مصفوفة ونحوّل العناصر لنصوص.
    const ids = () => { const v = safeLoad(KEY, []); return Array.isArray(v) ? v.map(String) : []; };
    // رسم شريط آخر المنتجات المشاهدة (حتى 8) مع استثناء المنتج المفتوح حاليًا في صفحة المنتج.
    function render() {
      if (!ready()) return;
      const here = document.body.dataset.productId ? String(document.body.dataset.productId) : '';
      const list = ids().map(id => PRODUCTS.find(p => String(p.id) === id)).filter(p => p && String(p.id) !== here).slice(0, 8);
      let sec = $('#recentSection');
      if (!list.length) { if (sec) sec.remove(); return; }
      // القسم يُبنى بـ HTML نصّي، وأسماء المنتجات والروابط تمر عبر esc() للحماية من حقن الشيفرة.
      const html = `<div class="container"><div class="section-head"><div><span class="eyebrow">تابع من حيث توقفت</span><h2 id="recentTitle">شاهدتها مؤخرًا</h2></div><button type="button" class="text-btn" id="clearRecent">مسح السجل</button></div>`
        + `<ul class="recent-strip">${list.map(p => `<li class="recent-item"><a href="${esc(productUrl(p))}"><img src="${esc(p.thumb || p.image)}" alt="" width="210" height="220" loading="lazy" decoding="async"><b>${esc(p.name)}</b><span class="recent-price">${priceHtml(p)}</span></a></li>`).join('')}</ul></div>`;
      // إن لم يوجد القسم نُنشئه ونضعه بعد #shop في الصفحة الرئيسية، أو قبل .page-cta، أو في آخر #main.
      if (!sec) {
        sec = document.createElement('section');
        sec.className = 'section recent-section'; sec.id = 'recentSection'; sec.setAttribute('aria-labelledby', 'recentTitle');
        const shop = $('#shop'), cta = $('main .page-cta'), main = $('#main');
        if (PAGE === 'home' && shop) shop.after(sec);
        else if (cta) cta.before(sec);
        else if (main) main.append(sec);
      }
      sec.innerHTML = html;
    }
    // تفويض الأحداث: زر "مسح السجل" يُنشأ ديناميكيًا لذا نلتقط النقر من document.
    document.addEventListener('click', e => {
      if (!e.target.closest('#clearRecent')) return;
      try { localStorage.removeItem(KEY); } catch {}
      render(); toast('تم مسح سجل المشاهدات');
    });
    // حدث مخصص يطلقه السكربت الرئيسي عند مشاهدة منتج جديد لتحديث الشريط.
    document.addEventListener('recent:update', () => { if (ready()) render(); });
    whenReady(render);
  });

  /* ------------------------------------------------------------------ gallery: arrows, counter, swipe, zoom */
  guard('gallery', () => {
    // محدد CSS لمنطقة الصورة الكبيرة: نافذة المعاينة السريعة (.modal-image)
    // أو صفحة المنتج (.product-gallery-main).
    const STAGE = '.modal-image, .product-gallery-main';
    // هل المعرض داخل نافذة المعاينة السريعة (#productModal)؟ لأن كل منهما له دالة تغيير صورة مختلفة.
    const isModal = stage => Boolean(stage.closest('#productModal'));
    // يحسب فهرس الصورة النشطة وعدد الصور من أزرار المصغرات (الفئة active).
    const currentIndex = stage => {
      const btns = isModal(stage) ? $$('#productModalContent [data-gindex]') : $$('[data-page-gindex]');
      const i = btns.findIndex(b => b.classList.contains('active'));
      return { i: Math.max(0, i), n: btns.length };
    };
    // الانتقال للصورة التالية/السابقة (delta = +1 أو -1) عبر setGalleryImage أو setPageImage من السكربت
    // الرئيسي.
    function go(stage, delta) {
      const { i, n } = currentIndex(stage); if (n < 2) return;
      if (isModal(stage)) setGalleryImage(i + delta); else setPageImage(i + delta);
    }
    // تشغيل/إيقاف تكبير الصورة، وتحديث حالة زر التكبير (aria-pressed) ووصفه لقارئ الشاشة.
    function zoom(stage, on, x, y) {
      stage.classList.toggle('is-zoomed', on);
      if (on) pan(stage, x, y);
      const b = stage.querySelector('[data-zoom-toggle]');
      if (b) { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'إلغاء التكبير' : 'تكبير الصورة'); }
    }
    // تحريك نقطة التكبير: يحوّل موضع المؤشر إلى نسبة مئوية داخل الصورة (0-100) ويخزنها في --zx و--zy لـ CSS.
    function pan(stage, x, y) {
      const r = stage.getBoundingClientRect(); if (!r.width) return;
      const px = x == null ? 50 : Math.max(0, Math.min(100, (x - r.left) / r.width * 100));
      const py = y == null ? 50 : Math.max(0, Math.min(100, (y - r.top) / r.height * 100));
      stage.style.setProperty('--zx', px.toFixed(1) + '%'); stage.style.setProperty('--zy', py.toFixed(1) + '%');
    }
    // ملاحظة: الأسهم والعداد وزر التكبير تُحقن بالسكربت في صفحة المنتج لأن الخادم يرسم الصفحة بدونها.
    // the product page gallery is server-rendered: add the same controls the quick view has
    // --ph يمرر الصورة الأولى كخلفية مموهة (blur-up) تظهر ريثما تُحمَّل الصورة الكبيرة؛ dataset.enhanced يمنع
    // التكرار.
    function enhancePage() {
      const main = $('.product-gallery-main');
      if (!main || main.dataset.enhanced || main.classList.contains('is-empty')) return;
      main.dataset.enhanced = '1'; main.classList.add('zoomable');
      const first = $('[data-page-gindex] img'); if (first) main.style.setProperty('--ph', cssUrl(first.getAttribute('src')));
      const n = $$('[data-page-gindex]').length;
      let html = `<button type="button" class="gzoom" data-zoom-toggle aria-pressed="false" aria-label="تكبير الصورة">${icons.zoom}</button>`;
      if (n > 1) html += `<button type="button" class="gnav gnav-prev" data-gnav="-1" aria-label="الصورة السابقة">${icons.chevR}</button><button type="button" class="gnav gnav-next" data-gnav="1" aria-label="الصورة التالية">${icons.chevL}</button><span class="gcount" id="pageGalleryCount" aria-hidden="true">${amount(1)} من ${amount(n)}</span>`;
      main.insertAdjacentHTML('beforeend', html);
    }
    enhancePage();
    // تفويض النقر على أزرار الأسهم (data-gnav) وزر التكبير (data-zoom-toggle).
    document.addEventListener('click', e => {
      const nav = e.target.closest('[data-gnav]');
      if (nav) { go(nav.closest(STAGE), Number(nav.dataset.gnav)); return; }
      const z = e.target.closest('[data-zoom-toggle]');
      if (z) { const stage = z.closest(STAGE); zoom(stage, !stage.classList.contains('is-zoomed')); }
    });
    // pointer gestures: tap = zoom in/out at that point, horizontal swipe = next/previous photo (RTL: swipe left = next)
    let down = null;
    // pointerdown/move/up تغطي الفأرة واللمس معًا؛ down يخزن بداية اللمسة (الموضع والوقت وهل تحرّك الإصبع).
    document.addEventListener('pointerdown', e => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const stage = e.target.closest && e.target.closest(STAGE);
      if (!stage || e.target.closest('button,a')) { down = null; return; }
      stage.classList.add('zoomable');
      down = { stage, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    });
    // إن تحرك المؤشر أكثر من 8 بكسل تُعد حركة سحب لا نقرة؛ وفي حالة التكبير تتبع الصورة المؤشر.
    document.addEventListener('pointermove', e => {
      const zoomed = e.target.closest && e.target.closest('.zoomable.is-zoomed');
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
      if (zoomed && e.isPrimary && (e.pointerType === 'mouse' || down)) pan(zoomed, e.clientX, e.clientY);
    }, { passive: true });
    // نقرة قصيرة (أقل من 600ms دون حركة) = تكبير/تصغير؛ سحب أفقي أكبر من 50px وأوضح من العمودي = صورة
    // تالية/سابقة.
    document.addEventListener('pointerup', e => {
      if (!down) return; const d = down; down = null;
      const dx = e.clientX - d.x, dy = e.clientY - d.y, zoomed = d.stage.classList.contains('is-zoomed');
      if (!d.moved && performance.now() - d.t < 600) zoom(d.stage, !zoomed, e.clientX, e.clientY);
      else if (!zoomed && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(d.stage, dx < 0 ? 1 : -1);
    });
    // إلغاء المتصفح للمس (مثلًا عند بدء التمرير) يمسح الحالة.
    document.addEventListener('pointercancel', () => { down = null; });
    // Escape first leaves the zoom, a second press closes the dialog
    // مرحلة الالتقاط (true) تجعل هذا المعالج يعمل قبل معالج إغلاق النافذة في السكربت الرئيسي.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const z = $('.zoomable.is-zoomed'); if (z) { zoom(z, false); e.stopPropagation(); e.preventDefault(); }
    }, true);
    // keyboard on the product page gallery (modal arrows are handled by the main script)
    // في RTL: السهم الأيسر = الصورة التالية، والأيمن = السابقة.
    document.addEventListener('keydown', e => {
      const stage = e.target.closest && e.target.closest('.product-gallery-main');
      if (!stage || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault(); go(stage, e.key === 'ArrowLeft' ? 1 : -1);
    });
  });

  /* ------------------------------------------------------------------ hero shortcuts */
  guard('hero', () => {
    // شريط اختصارات الأقسام في الواجهة الرئيسية (#heroChips): أول 5 أقسام ظاهرة من visibleCategories().
    const list = $('#heroChips'); if (!list) return;
    whenReady(() => {
      const cats = visibleCategories().slice(0, 5);
      list.innerHTML = cats.map(c => `<li><a href="${esc(categoryUrl(c.slug))}">${esc(c.name)}</a></li>`).join('');
    });
  });

  /* ------------------------------------------------------------------ install the app (PWA) */
  guard('install', () => {
    // داخل تطبيق الأندرويد (WebView) يحمل User-Agent الكلمة AlfakhamahApp/ فلا حاجة لعرض "ثبّت التطبيق".
    if (/AlfakhamahApp\//.test(navigator.userAgent)) return;
    // إن كان الموقع مثبتًا ويعمل كتطبيق مستقل (standalone) فلا نعرض بطاقة التثبيت.
    if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
    // مفتاح localStorage لتذكّر تأجيل البطاقة، و#installLink رابط "تثبيت التطبيق" في التذييل.
    const KEY = 'fakhama-install-v1', link = $('#installLink');
    const ua = navigator.userAgent;
    // سفاري على iOS لا يدعم beforeinstallprompt، فنعرض له إرشادًا يدويًا؛ ونستثني متصفحات كروم وفايرفوكس وإيدج
    // على iOS.
    const iosSafari = /iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    let deferred = null, card = null, timer = 0;
    // هل أجّل الزائر البطاقة خلال آخر 14 يومًا؟ (864e5 = ملّي ثانية في اليوم). الوصول لـ localStorage داخل try
    // لأنه قد يُحظر.
    const snoozed = () => { try { const t = Number(localStorage.getItem(KEY)); return Boolean(t) && Date.now() - t < 14 * 864e5; } catch { return false; } };
    const snooze = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch {} };
    const hide = () => { if (card) { card.remove(); card = null; } };
    // عرض بطاقة التثبيت: زر "تثبيت" إن كان المتصفح يدعمه، وإلا نص يشرح الإضافة للشاشة الرئيسية يدويًا.
    function show(manual) {
      if (card || (!deferred && !iosSafari)) return;
      card = document.createElement('section');
      card.className = 'install-card'; card.setAttribute('role', 'region'); card.setAttribute('aria-labelledby', 'installTitle');
      const text = deferred ? 'أضف المتجر إلى شاشتك الرئيسية لفتحه بسرعة كتطبيق مستقل.' : 'اضغط زر المشاركة في المتصفح ثم اختر «إضافة إلى الشاشة الرئيسية».';
      card.innerHTML = `<span class="ic-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg></span><h2 id="installTitle">ثبّت تطبيق الفخامة</h2><p>${text}</p><div class="ic-actions">${deferred ? '<button type="button" class="btn btn-primary" data-install-now>تثبيت</button>' : ''}<button type="button" class="btn btn-outline" data-install-later>${deferred ? 'لاحقًا' : 'تم'}</button></div>`;
      document.body.append(card);
      if (manual) card.querySelector('button').focus();
    }
    // تشغيل نافذة التثبيت الأصلية؛ إن رفضها الزائر نؤجل البطاقة 14 يومًا.
    async function runInstall() {
      if (!deferred) return;
      const ev = deferred; deferred = null; hide();
      try { await ev.prompt(); const choice = await ev.userChoice; if (choice && choice.outcome !== 'accepted') snooze(); } catch {}
      if (link) link.hidden = true;
    }
    // المتصفح يطلق هذا الحدث عندما يصبح الموقع قابلًا للتثبيت؛ نحتفظ به لنعرضه لاحقًا بدل ظهوره فورًا.
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); deferred = e;
      if (link) link.hidden = false;
      if (snoozed()) return;
      // التأخير الافتراضي 15 ثانية قبل ظهور البطاقة؛ __installDelayMs متغير اختياري يضبطه الاختبار الآلي.
      const wait = typeof window.__installDelayMs === 'number' ? window.__installDelayMs : 15000;
      clearTimeout(timer);
      // لا نزاحم لافتة الموافقة على الكوكيز: لا تظهر البطاقة إن كانت اللافتة معروضة.
      timer = setTimeout(() => { const consent = $('#consentBanner'); if (!consent || consent.hidden) show(false); }, wait);
    });
    // بعد اكتمال التثبيت نخفي البطاقة والرابط ونشكر الزائر برسالة.
    window.addEventListener('appinstalled', () => { deferred = null; clearTimeout(timer); hide(); if (link) link.hidden = true; toast('تم تثبيت التطبيق على جهازك'); });
    if (iosSafari && link) link.hidden = false;
    if (link) link.addEventListener('click', () => { if (deferred) runInstall(); else show(true); });
    document.addEventListener('click', e => {
      if (e.target.closest('[data-install-now]')) runInstall();
      else if (e.target.closest('[data-install-later]')) { snooze(); hide(); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && card && card.contains(document.activeElement)) { snooze(); hide(); } });
  });

  /* ------------------------------------------------------------------ connection notices, cross-tab sync */
  guard('network', () => {
    // إشعار عند انقطاع الإنترنت وعند عودته؛ إن فشل تحميل الكتالوج سابقًا نعيد المحاولة تلقائيًا.
    addEventListener('offline', () => toast('انقطع الاتصال بالإنترنت؛ قد لا تتحدّث الأسعار والمخزون.'));
    addEventListener('online', () => {
      toast('عاد الاتصال بالإنترنت');
      if (typeof catalogState !== 'undefined' && catalogState === 'error') loadLiveCatalog();
    });
    // حدث storage يصل عند تغيير localStorage من تبويب آخر: نزامن السلة والمفضلة هنا دون إعادة تحميل الصفحة.
    addEventListener('storage', e => {
      if (e.key !== 'fakhama-cart-v1' && e.key !== 'fakhama-favorites-v1') return;
      const c = safeLoad('fakhama-cart-v1', []), f = safeLoad('fakhama-favorites-v1', []);
      cart = Array.isArray(c) ? c : []; favorites = Array.isArray(f) ? f : [];
      renderCart(); updateCounts(); syncFavorites(); if (showFavorites) renderProducts();
    });
  });
})();
