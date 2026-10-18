/* شرح بالعربية: هذا الملف هو الـ Service Worker الخاص بالمتجر (تطبيق ويب تقدمي PWA). */
/* هو سكربت يعمل في خلفية المتصفح ويعترض طلبات الصفحات ليحفظ بعض الملفات الثابتة فقط (CSS وJS والخطوط والأيقونات). */
/* فائدته: تسريع الزيارات المتكررة وعرض صفحة offline.html عند انقطاع الإنترنت. */
/* يُسجَّل من index.html ومن admin.html عبر navigator.serviceWorker.register('/sw.js'). */
/* لا يخزّن أي بيانات خاصة: الطلبات والجلسات والمنتجات ولوحة الإدارة تذهب دائمًا إلى الشبكة مباشرة. */
/* Service worker for the public storefront (PWA).
 *
 * Deliberately minimal and privacy-safe:
 *  - /api/*, /admin*, /uploads/* and every non-GET request go straight to the network: no orders, sessions,
 *    credentials, catalogue data or admin pages are ever stored in the cache.
 *  - Page navigations are network-first; only a static offline notice is cached as the fallback, so a customer
 *    never sees stale prices or stock.
 *  - Only the bundled, public site files (/assets: styles, script, fonts, brand photos; /icons) are cached.
 *    The storefront's own stylesheet and script are served stale-while-revalidate so an update is picked up on the next visit.
 */
/* ---- الإعدادات: اسم الكاش وقائمة الملفات المحفوظة مسبقًا ---- */
/* عند تغيير الرقم v3 يُنشأ كاش جديد ويُحذف القديم تلقائيًا في حدث activate. */
const CACHE = 'fakhama-static-v3';
/* الصفحة التي تُعرض عند فشل تحميل أي صفحة بسبب انقطاع الإنترنت. */
const OFFLINE_URL = '/offline.html';
/* ملفات تُحفظ وقت التثبيت (install) ليعمل الموقع بشكل أسرع وتكون صفحة offline جاهزة دائمًا. */
const PRECACHE = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/assets/css/plus.css',
  '/assets/js/plus.js',
  '/assets/fonts/el-messiri-arabic-700-normal.woff2',
  '/assets/fonts/el-messiri-arabic-600-normal.woff2',
];
/* مسارات لا يتدخل فيها الـ Service Worker إطلاقًا (بيانات حيّة أو خاصة): واجهة API ولوحة الإدارة والصور المرفوعة. */
const NEVER_CACHE_PREFIXES = ['/api/', '/admin', '/uploads/'];
/* يطابق ملفات CSS وJS الخاصة بالموقع فقط؛ هذه تُقدَّم من الكاش ثم تُحدَّث من الشبكة (stale-while-revalidate). */
const SHELL_ASSET = /^\/assets\/(css|js)\//;
/* أقصى عدد للملفات التي تُحفظ أثناء التصفح (فوق الملفات المحفوظة مسبقًا) كي لا يكبر الكاش بلا حد. */
const MAX_RUNTIME_ENTRIES = 90;

/* ---- حدث التثبيت: حفظ الملفات المسبقة ثم تفعيل النسخة الجديدة فورًا (skipWaiting) ---- */
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

/* ---- حدث التفعيل: حذف كاش النسخ القديمة التي تبدأ بـ fakhama- ثم السيطرة على الصفحات المفتوحة ---- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('fakhama-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/* ---- دالة remember: تحفظ نسخة من الاستجابة في الكاش وتُبقي عدد الملفات المحفوظة تحت الحد ---- */
/* لا تحفظ إلا الاستجابات الناجحة (ok) وغير المبهمة (opaque)، وتحذف الأقدم عند تجاوز الحد. */
function remember(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  /* الاستجابة لا تُقرأ إلا مرة واحدة، لذلك نحفظ نسخة منها (clone) ونُرجع الأصل للمتصفح. */
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy).then(() => cache.keys()).then(keys => {
    const extra = keys.length - (PRECACHE.length + MAX_RUNTIME_ENTRIES);
    return extra > 0 ? Promise.all(keys.slice(PRECACHE.length, PRECACHE.length + extra).map(k => cache.delete(k))) : null;
  })).catch(() => {});
  return response;
}

/* ---- حدث fetch: يقرر لكل طلب هل يمر للشبكة مباشرة أم يُخدَّم من الكاش ---- */
self.addEventListener('fetch', event => {
  const request = event.request;
  /* أي طلب غير GET (مثل إرسال طلب شراء أو تسجيل دخول) يمر للشبكة دون تدخل. */
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  /* نتعامل مع ملفات موقعنا فقط، ونتجاهل أي نطاق خارجي. */
  if (url.origin !== self.location.origin) return;
  /* البيانات الحيّة والخاصة لا تُخزَّن أبدًا (راجع NEVER_CACHE_PREFIXES أعلاه). */
  if (NEVER_CACHE_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return;

  /* تصفّح الصفحات: الشبكة أولًا (network-first) حتى لا يرى الزبون أسعارًا أو مخزونًا قديمًا؛ */
  /* وإذا فشلت الشبكة تُعرض صفحة offline.html المحفوظة. */
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  /* ملفات CSS وJS: تُرجَّع من الكاش فورًا إن وُجدت، وفي الخلفية تُجلب نسخة أحدث للزيارة التالية. */
  if (SHELL_ASSET.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(hit => {
        /* cache: no-cache يجبر المتصفح على التحقق من الخادم؛ وعند الفشل نرجع النسخة المحفوظة أو خطأ شبكة. */
        const network = fetch(request, { cache: 'no-cache' }).then(response => remember(request, response)).catch(() => hit || Response.error());
        return hit || network;
      })
    );
    return;
  }
  /* بقية الملفات الثابتة (خطوط وصور الموقع والأيقونات): الكاش أولًا، وإن لم توجد تُجلب وتُحفظ. */
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(response => remember(request, response)))
    );
  }
});
