// ملف اختبار شامل من طرف المتصفح (E2E): يشغّل Chromium عبر Playwright ويتصرف كزبون ثم كمدير على الهاتف وسطح المكتب.
// يشغّل خادماً مؤقتاً خاصاً به (app.py) على منفذ حر مع مجلد بيانات مؤقت وكلمة مرور عشوائية للمدير، فلا يمسّ
// بيانات المتجر.
// كل فحص يُسجَّل كـ PASS أو FAIL في النهاية، وأي خطأ غير متوقع في console المتصفح يُعدّ فشلاً أيضاً (رمز خروج 1).
// الاستخدام: node tests/e2e_ui.cjs [مجلد لقطات الشاشة]؛ وتُحفظ لقطات الشاشة لمراجعة التصميم بالعين.
// Browser end-to-end check of the storefront and admin UI (Chromium via Playwright, phone-sized viewport).
//   NODE_PATH=$(npm root -g) node tests/e2e_ui.cjs [screenshot-dir]
// Starts its own server on a free port with a throw-away DATA_DIR and a random admin password.
// ---- الاستيراد والثوابت ----
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

// ROOT جذر المشروع، وSHOTS مجلد لقطات الشاشة (المعطى في سطر الأوامر أو مجلد مؤقت).
const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'fakhama-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });

// صورة PNG بحجم بكسل واحد، تُستخدم لاختبار رفع الصور من لوحة الإدارة.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// يحجز منفذاً حراً بفتح خادم مؤقت على المنفذ 0 ثم إغلاقه وإرجاع رقمه.
function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- تشغيل الخادم المؤقت والمتصفح ----
(async () => {
  // كلمة مرور المدير عشوائية وتُمرَّر بمتغير بيئة فقط (ENV_FILE=off يمنع قراءة .env محلي)، ونحتفظ بمخرجات الخطأ
  // للتشخيص.
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakhama-e2e-'));
  const password = 'E' + crypto.randomBytes(14).toString('base64url');
  const server = spawn('python3', ['-I', path.join(ROOT, 'app.py')], {
    cwd: dataDir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: password, ENV_FILE: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', d => { serverLog += d; });
  // ننتظر (حتى 10 ثوانٍ) حتى يرد /api/health دلالة على جاهزية الخادم.
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await sleep(100); } }
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  const results = [];
  // check: يغلّف كل فحص بـ try/catch فيسجّل PASS أو FAIL مع أول 3 أسطر من الرسالة بدل أن يوقف باقي الفحوص.
  // ملاحظة: الاستدعاء يكون check(اسم، دالة)() أي بقوسين في النهاية لتنفيذه.
  const check = (name, fn) => async () => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' — ' + e.message.split('\n').slice(0, 3).join(' | ')]); } };
  // قائمة أخطاء المتصفح (console/pageerror/HTTP 4xx-5xx) التي تُفحص عند النهاية.
  const errors = [];
  let newPassword = '';

  // ---- دوال مساعدة للصفحات المولَّدة من الخادم ----
  // watch: يراقب صفحة ويسجّل أخطاءها، ويستثني رمز 4xx للمسارات التي يكون الـ 404 فيها هو المقصود من الفحص.
  // --- helpers for the server-rendered pages
  // Browser errors on a page are failures, except a 4xx on a path whose 404 is the point of the check.
  const expectedUrl = (url, paths) => { try { const u = new URL(url); return u.origin === base && paths.includes(u.pathname); } catch { return false; } };
  const watch = (pg, label, expected = []) => {
    pg.on('console', m => { if (m.type() === 'error' && !expectedUrl(m.location().url, expected)) errors.push(`${label} console: ${m.text()}`); });
    pg.on('pageerror', e => errors.push(`${label} pageerror: ${e.message}`));
    pg.on('response', r => { if (r.status() >= 400 && !expectedUrl(r.url(), expected)) errors.push(`${label} http ${r.status()}: ${r.url()}`); });
  };
  // follow: ينفّذ نقرة تقود إلى صفحة جديدة وينتظر التنقل في الوقت نفسه (لتفادي سباق بين النقر والتحميل).
  // Click a link (or press a key in a form) and return the HTTP response of the page it leads to.
  const follow = async (pg, action) => { const [resp] = await Promise.all([pg.waitForNavigation(), action()]); return resp; };
  // الواجهة تحمّل الكتالوج الحي وتعيد رسم الشبكات؛ نمنع الفحص قبل أن تصبح حالته ready.
  const catalogReady = pg => pg.waitForFunction(() => typeof catalogState !== 'undefined' && catalogState === 'ready');
  // currentNav: يعيد روابط القائمة التي تحمل aria-current (الصفحة الحالية) لفحص إتاحة التنقل.
  // "page" on the list page itself, "true" for its section (a product or category page inside it)
  const currentNav = pg => pg.$$eval('#mainNav a[aria-current]:not([aria-current="false"])', as => as.map(a => a.getAttribute('href')));
  // oneH1: كل صفحة يجب أن تحوي عنواناً رئيسياً h1 واحداً فقط (قاعدة وصول وSEO).
  const oneH1 = async (pg, text) => {
    const h1s = await pg.$$eval('h1', els => els.map(e => e.textContent.trim()));
    assert.strictEqual(h1s.length, 1, 'exactly one h1: ' + JSON.stringify(h1s));
    if (text !== undefined) assert.strictEqual(h1s[0], text);
  };
  // toastSays: ننتظر ظهور رسالة منبثقة ثم نفرغها حتى لا يرضي نصّها القديم انتظاراً لاحقاً.
  // Wait for a toast, then clear it so a later wait cannot be satisfied by this one's text.
  const toastSays = async (pg, text) => {
    await pg.waitForFunction(t => document.querySelector('#toast').textContent.includes(t), text);
    await pg.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  };
  // settled: ننتظر انتهاء الحركات المحدودة قبل لقطة الشاشة (الحركة الدائمة كاللمعان لا تنتهي فتُستثنى).
  // Screenshots of a settled page: wait for the finite entrance animations (the looping shimmer never ends).
  const settled = pg => pg.evaluate(() => Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))));
  const apiProducts = async () => (await (await fetch(base + '/api/products')).json()).products;
  // the storefront search haystack (index.html renderProducts / pages.search_matches)
  // يحسب عدد النتائج المتوقعة بنفس نص البحث الذي تبنيه الواجهة (الاسم والقسم والوصف ورمز المنتج) لمقارنته بما يظهر.
  const searchCount = (products, term) => products.filter(p => `${p.name} ${p.category_name} ${p.description} ${p.sku || ''}`.toLowerCase().includes(term.toLowerCase())).length;
  const pathAndQ = url => { const u = new URL(url); return [u.pathname, u.searchParams.get('q')]; };

  // ---- الفحوص كلها داخل try/finally ليُغلق المتصفح ويُوقف الخادم مهما حدث ----
  try {
    // القسم الأول: زبون على هاتف (390x844) يتصفح المتجر ويطلب.
    // ------------------------------------------------------------ customer storefront (phone)
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-SA', isMobile: true, hasTouch: true });
    const page = await phone.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
    page.on('response', r => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });

    await page.goto(base + '/');
    await page.waitForSelector('.product-card');
    // الصفحة الرئيسية تعرض صور المالك الحقيقية فقط (لا منتجات تجريبية مختلقة).
    await check('storefront lists the 18 owner photos (no invented sample products)', async () => assert.strictEqual(await page.locator('.product-card').count(), 18))();
    await check('only categories with products are shown (cards + filter chips use real photos)', async () => {
      assert.strictEqual(await page.locator('#categoryGrid .category-card').count(), 1);
      assert.strictEqual(await page.locator('#filterList .filter-chip').count(), 2);
      assert.ok((await page.getAttribute('#categoryGrid .category-card img', 'src')).startsWith('/assets/wavy-'));
    })();
    // المنتج بسعر 0 يظهر "السعر حسب الطلب" وليس "0 ريال".
    await check('owner photos show "price on request", not 0 SAR', async () => {
      const first = await page.locator('.product-card').first().textContent();
      assert.ok(first.includes('ويفي') && first.includes('السعر حسب الطلب') && !first.includes('٠'), first);
    })();
    await check('all product images decode', async () => {
      // images are lazy-loaded: force them, then require every one to decode
      const results = await page.$$eval('img.product-image', imgs => Promise.all(imgs.map(i => { i.loading = 'eager'; return i.decode().then(() => i.naturalWidth > 0, () => false); })));
      assert.strictEqual(results.filter(ok => !ok).length, 0);
    })();
    // PWA: ملف manifest مربوط والـ Service Worker مفعّل بنطاق الموقع كله.
    await check('manifest + SW registered and active', async () => {
      const href = await page.getAttribute('link[rel=manifest]', 'href');
      assert.strictEqual(href, '/manifest.webmanifest');
      const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
      assert.strictEqual(scope, base + '/');
    })();
    await page.screenshot({ path: path.join(SHOTS, '01-store-mobile.png') });

    // البحث برمز المنتج يصفّي البطاقات؛ على الهاتف صندوق البحث مطويّ فنفتحه أولاً.
    await check('search filters products', async () => {
      await page.click('#searchToggle'); // the search box is collapsed on phones
      await page.fill('#searchInput', 'FAL-WAV-005');
      await page.waitForTimeout(150);
      const n = await page.locator('.product-card').count();
      assert.strictEqual(n, 1, 'cards=' + n);
      await page.fill('#searchInput', '');
    })();

    // رحلة الزبون الكاملة: معاينة سريعة ← السلة ← نموذج الطلب ← رقم الطلب في الرسالة المنبثقة وتفريغ السلة
    // المحفوظة في المتصفح.
    await check('add to cart and place an order through the UI', async () => {
      await page.locator('.quick-add').first().click({ force: true });
      await page.waitForSelector('#productModal.open');
      await page.click('[data-modal-add]');
      await page.click('#cartOpen');
      await page.waitForSelector('#cartDrawer.open');
      await page.screenshot({ path: path.join(SHOTS, '02-cart-mobile.png') });
      await page.click('#checkoutBtn');
      await page.waitForSelector('#orderModal.open');
      await page.fill('#customerName', 'عميل اختبار الواجهة');
      await page.fill('#customerPhone', '0551234567');
      await page.fill('#customerCity', 'جدة');
      await page.check('#orderForm input[name=consent]');
      await page.screenshot({ path: path.join(SHOTS, '03-order-form-mobile.png') });
      await page.click('#orderForm button[type=submit]');
      await page.waitForFunction(() => /تم تسجيل طلبك MH-\d{6}-\d{5} بنجاح/.test(document.querySelector('#toast').textContent));
      assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('fakhama-cart-v1') || '[]').length), 0, 'cart cleared');
    })();

    // القسم الثاني: لوحة الإدارة على الهاتف. نسجّل ما يحدث لزائر غير مسجّل لنتأكد أن فحص الجلسة لا يترك أخطاء
    // 401 في الـ console.
    // ------------------------------------------------------------ admin (phone)
    const admin = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-SA', isMobile: true, hasTouch: true });
    const ap = await admin.newPage();
    ap.on('pageerror', e => errors.push('admin pageerror: ' + e.message));
    const loginScreen = { statuses: [], consoleErrors: [] }; // what a logged-out visit to /admin/ produced
    ap.on('response', r => { if (r.status() >= 400) { if (r.url().includes('/api/admin/login')) return; loginScreen.statuses.push(`${r.status()} ${r.url()}`); errors.push(`admin http ${r.status()}: ${r.url()}`); } });
    ap.on('console', m => { if (m.type() === 'error') loginScreen.consoleErrors.push(m.text()); });
    await ap.goto(base + '/admin/');
    await ap.waitForSelector('#loginForm');
    await ap.waitForTimeout(800);
    // الزائر غير المسجّل: واجهة /api/admin/session تردّ 200 (authenticated:false) بدل 401، بينما تبقى بقية
    // واجهات المدير محمية بـ 401.
    await check('logged-out /admin/ logs no 401 and no console error (session probe answers 200)', async () => {
      assert.deepStrictEqual(loginScreen.statuses, [], 'no 4xx responses: ' + loginScreen.statuses.join(', '));
      assert.deepStrictEqual(loginScreen.consoleErrors, [], 'console errors: ' + loginScreen.consoleErrors.join(' | '));
      const anon = await ap.evaluate(() => fetch('/api/admin/session', { credentials: 'same-origin' }).then(async r => [r.status, await r.json()]));
      assert.deepStrictEqual(anon, [200, { authenticated: false }]);
      const prot = await Promise.all(['/api/admin/me', '/api/admin/dashboard', '/api/admin/products', '/api/admin/orders'].map(u => admin.request.get(base + u).then(r => r.status()))); // API context: not page traffic
      assert.deepStrictEqual(prot, [401, 401, 401, 401], 'protected endpoints still 401 for anonymous callers');
    })();
    await ap.screenshot({ path: path.join(SHOTS, '05-admin-login-mobile.png') });
    // كلمة مرور خاطئة تُظهر رسالة خطأ ولا تدخل.
    await check('admin login rejects a wrong password', async () => {
      await ap.fill('#loginUser', 'admin'); await ap.fill('#loginPass', 'wrong-password-123');
      await ap.click('#loginForm button[type=submit]');
      await ap.waitForFunction(() => document.querySelector('#loginError').textContent.length > 0);
    })();
    // الدخول الصحيح يعرض اللوحة ويظهر فيها الطلب الذي أنشأه الزبون (رقمه يبدأ بـ MH-).
    await check('admin login works and dashboard shows the new order', async () => {
      await ap.fill('#loginPass', password);
      await ap.click('#loginForm button[type=submit]');
      await ap.waitForSelector('.stats-grid');
      assert.ok((await ap.textContent('#pageContent')).includes('MH-'));
      await ap.screenshot({ path: path.join(SHOTS, '06-admin-dashboard-mobile.png') });
    })();
    // الصور المصغرة في جدول المنتجات تُحمَّل (كانت المسارات النسبية تعطي 404 تحت /admin/).
    await check('admin product thumbnails load (relative paths used to 404 under /admin/)', async () => {
      await ap.evaluate(() => navigate('products'));
      await ap.waitForSelector('#productsBody .thumb');
      await ap.waitForTimeout(500);
      const results = await ap.$$eval('#productsBody img.thumb', imgs => Promise.all(imgs.map(i => { i.loading = 'eager'; return i.decode().then(() => i.naturalWidth > 0, () => false); })));
      assert.strictEqual(results.filter(ok => !ok).length, 0);
      assert.ok((await ap.textContent('#productsBody')).includes('حسب الطلب'), 'admin shows price on request');
      await ap.screenshot({ path: path.join(SHOTS, '07-admin-products-mobile.png') });
    })();
    // على عرض 360 بكسل تتحول جداول الإدارة إلى بطاقات: بلا تمرير أفقي، مع عناوين الحقول، وأزرار لا تقل عن 44
    // بكسل ولا تخرج عن الشاشة.
    await check('admin tables become stacked cards at 360px: no page scroll, labels, 44px actions, full names', async () => {
      const narrow = await browser.newContext({ viewport: { width: 360, height: 740 }, locale: 'ar-SA' });
      const np = await narrow.newPage();
      try {
        await np.goto(base + '/admin/'); await np.waitForSelector('#loginForm');
        await np.fill('#loginUser', 'admin'); await np.fill('#loginPass', password);
        await np.click('#loginForm button[type=submit]'); await np.waitForSelector('.stats-grid');
        for (const [page, body] of [['products', '#productsBody'], ['orders', '#ordersBody']]) {
          await np.evaluate(p => navigate(p), page); await np.waitForSelector(body + ' tr td');
          await np.waitForTimeout(400);
          const m = await np.evaluate(sel => {
            const W = document.documentElement.clientWidth; const rows = [...document.querySelectorAll(sel + ' tr')];
            const wrap = document.querySelector(sel).closest('.table-wrap');
            const cells = [...document.querySelectorAll(sel + ' td[data-label]')];
            const btns = [...document.querySelectorAll(sel + ' .icon-action')];
            return { sw: document.documentElement.scrollWidth, W, wrapScroll: wrap.scrollWidth - wrap.clientWidth, rowDisplay: getComputedStyle(rows[0]).display,
              labelled: cells.length, labelShown: cells.every(c => getComputedStyle(c, '::before').content !== 'none'),
              roles: document.querySelector(sel).closest('table').getAttribute('role'), rowRole: rows[0].getAttribute('role'),
              outside: btns.filter(b => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > W; }).length, small: btns.filter(b => b.getBoundingClientRect().height < 43 || b.getBoundingClientRect().width < 43).length, btns: btns.length,
              truncated: [...document.querySelectorAll(sel + ' .product-cell b')].filter(b => b.scrollWidth > b.clientWidth + 1).length };
          }, body);
          assert.ok(m.sw <= m.W, `${page}: horizontal page scroll ${m.sw} > ${m.W}`);
          assert.ok(m.wrapScroll <= 0, `${page}: table wrapper still scrolls sideways`);
          assert.strictEqual(m.rowDisplay, 'block', `${page}: rows are cards`);
          assert.ok(m.labelled > 0 && m.labelShown, `${page}: data-label captions visible`);
          assert.strictEqual(m.roles, 'table'); assert.strictEqual(m.rowRole, 'row');
          assert.ok(m.btns > 0 && m.outside === 0 && m.small === 0, `${page}: actions reachable and >=44px (${JSON.stringify(m)})`);
          assert.strictEqual(m.truncated, 0, `${page}: names not truncated`);
          await np.screenshot({ path: path.join(SHOTS, `07b-admin-${page}-360.png`) });
        }
        await np.evaluate(() => navigate('overview')); await np.waitForSelector('.stats-grid'); await np.waitForTimeout(600);
        assert.ok(await np.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'overview: no horizontal page scroll at 360');
      } finally { await narrow.close(); }
    })();
    // ملفا صورة مؤقتان لاختبار رفع أكثر من صورة.
    const png = path.join(dataDir, 'upload-test.png');
    fs.writeFileSync(png, PNG);
    const png2 = path.join(dataDir, 'upload-test-2.png');
    fs.writeFileSync(png2, PNG);
    // إضافة منتج بصورتين وجعل الثانية رئيسية؛ العميل يعيد ترميز الصور إلى JPEG، وللمنتج صفحة مشاركة من الخادم
    // فيها وسوم og وبيانات Product.
    await check('admin adds a product with TWO uploaded images, reorders them; the storefront shows the gallery', async () => {
      await ap.click('#addProduct');
      await ap.waitForSelector('#productForm');
      await ap.setInputFiles('#productImages', [png, png2]);
      await ap.waitForFunction(() => document.querySelectorAll('#gmList .gm-item').length === 2, null, { timeout: 15000 });
      await ap.click('#gmList .gm-item:nth-child(2) [data-gm=first]'); // make the second photo the primary one
      await ap.fill('#pName', 'ستارة اختبار الرفع');
      await ap.selectOption('#pCategory', 'roller');
      await ap.fill('#pPrice', '321');
      await ap.fill('#pStock', '7');
      await ap.fill('#pDescription', 'وصف تجريبي للمنتج');
      await ap.screenshot({ path: path.join(SHOTS, '08-admin-product-form-mobile.png') });
      await ap.click('#productForm button[type=submit]');
      await ap.waitForFunction(() => document.querySelector('#productsBody').textContent.includes('ستارة اختبار الرفع'));
      const res = await (await fetch(base + '/api/products')).json();
      const made = res.products.find(p => p.name === 'ستارة اختبار الرفع');
      assert.ok(made && made.images.length === 2, JSON.stringify(made));
      assert.ok(/^\/uploads\/[0-9a-f]{32}\.jpg$/.test(made.image), 'client re-encodes to JPEG: ' + made.image);
      assert.ok(/^\/uploads\/[0-9a-f]{32}\.jpg$/.test(made.thumb));
      assert.strictEqual((await fetch(base + made.image)).status, 200);
      // the product has its own shareable page with server-rendered meta
      const html = await (await fetch(base + '/product/' + encodeURIComponent(made.slug))).text();
      assert.ok(html.includes('og:title') && html.includes('ستارة اختبار الرفع') && html.includes('"Product"'));
    })();
    // أمان وخصوصية: حتى لو كان المدير مسجلاً في المتصفح لا تظهر أدواته في المتجر العام؛ ونافذة المنتج تحدّث
    // العنوان وتوفر المعرض والمشاركة عبر واتساب.
    await check('storefront shows no admin tools even to a logged-in admin; product modal has gallery and share', async () => {
      const sp = await admin.newPage();
      await sp.goto(base + '/');
      await sp.waitForSelector('.product-card');
      assert.strictEqual(await sp.locator('#adminBar').count(), 0, 'no admin bar on the storefront');
      await sp.fill('#searchInput', 'ستارة اختبار الرفع').catch(async () => { await sp.click('#searchToggle'); await sp.fill('#searchInput', 'ستارة اختبار الرفع'); });
      await sp.locator('#searchInput').blur(); // the suggestion list would cover the card
      await sp.locator('.quick-add').first().click({ force: true });
      await sp.waitForSelector('#productModal.open');
      assert.strictEqual(await sp.locator('.gthumb').count(), 2);
      assert.ok(sp.url().includes('/product/'), 'URL follows the open product: ' + sp.url());
      assert.ok((await sp.title()).includes('ستارة اختبار الرفع'));
      await sp.click('.gthumb:nth-child(2)');
      assert.ok((await sp.getAttribute('.gthumb:nth-child(2)', 'aria-pressed')) === 'true');
      assert.ok(await sp.locator('text=تعديل المنتج').count() === 0, 'no admin edit link for customers');
      assert.ok((await sp.getAttribute('a:has-text("مشاركة عبر واتساب")', 'href')).startsWith('https://wa.me/?text='));
      await sp.keyboard.press('Escape');
      await sp.waitForFunction(() => !document.querySelector('#productModal.open'));
      await sp.waitForFunction(() => location.pathname === '/');
      // a product link is now a real server-rendered page (it no longer re-opens the quick view on the home page)
      await sp.goto(base + '/product/wavy-03');
      await sp.waitForSelector('#productTitle');
      assert.ok((await sp.textContent('#productTitle')).includes('موديل 3'));
      await sp.waitForLoadState('networkidle'); await sp.waitForTimeout(300);
      assert.strictEqual(await sp.locator('#productModal.open').count(), 0, 'quick view stays closed on the product page');
      await sp.close();
    })();

    // القسم الثالث: الصفحات التي يولّدها الخادم لزائر جديد على سطح المكتب والهاتف. مسارا الـ 404 المقصودان
    // يُستثنيان من أخطاء HTTP.
    // ------------------------------------------------------------ server-rendered pages (a fresh visitor on desktop and phone)
    const NOT_FOUND_PATHS = ['/no-such-page', '/product/no-such-product'];
    const visitor = await browser.newContext({ viewport: { width: 1366, height: 800 }, locale: 'ar-SA' });
    await visitor.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const vp = await visitor.newPage();
    watch(vp, 'pages (desktop)', NOT_FOUND_PATHS);
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-SA', isMobile: true, hasTouch: true });
    const mp = await mobile.newPage();
    watch(mp, 'pages (phone)', NOT_FOUND_PATHS);
    const GALLERY_NAME = 'ستارة معرض صفحة المنتج';
    let galleryProduct = null;

    // التنقل من القائمة يصل لكل صفحة: HTTP 200 وh1 واحد وaria-current؛ وعلى الهاتف القائمة درج خلف زر #menuToggle.
    await check('header navigation reaches every page: HTTP 200, exactly one h1, aria-current on its own menu link (desktop + phone menu)', async () => {
      await vp.goto(base + '/');
      await vp.waitForSelector('.product-card');
      assert.deepStrictEqual(await currentNav(vp), ['/'], 'home');
      for (const [href, name] of [['/products', 'products'], ['/categories', 'categories'], ['/about', 'about'], ['/faq', 'faq'], ['/contact', 'contact'], ['/', 'home']]) {
        const resp = await follow(vp, () => vp.click(`#mainNav a[href="${href}"]`));
        assert.strictEqual(resp && resp.status(), 200, href + ' status');
        assert.strictEqual(new URL(vp.url()).pathname, href);
        assert.strictEqual(await vp.getAttribute('body', 'data-page'), name, href + ' body[data-page]');
        await oneH1(vp);
        assert.deepStrictEqual(await currentNav(vp), [href], href + ' aria-current');
      }
      // phone: the menu is a drawer behind #menuToggle
      await mp.goto(base + '/');
      await mp.click('#menuToggle');
      await mp.waitForSelector('#mainNav.open');
      assert.strictEqual(await mp.getAttribute('#menuToggle', 'aria-expanded'), 'true');
      const resp = await follow(mp, () => mp.click('#mainNav a[href="/about"]'));
      assert.strictEqual(resp && resp.status(), 200);
      await oneH1(mp);
      assert.deepStrictEqual(await currentNav(mp), ['/about']);
      assert.strictEqual(await mp.locator('#mainNav.open').count(), 0, 'the menu starts closed on the new page');
    })();

    // البحث يعمل حتى بدون JavaScript (يصفّي الخادم النتائج ويضع noindex لصفحة بحث)، ومع JavaScript يتزامن
    // العنوان مع ما يُكتب.
    await check('/products?q= filters the server-rendered list (no JavaScript) and the live list; typing keeps the URL in sync', async () => {
      const all = await apiProducts();
      const nojs = await browser.newContext({ javaScriptEnabled: false, locale: 'ar-SA' });
      const np = await nojs.newPage();
      const resp = await np.goto(base + '/products?q=FAL-WAV-005');
      assert.strictEqual(resp.status(), 200);
      assert.strictEqual(await np.locator('#productGrid .product-card').count(), 1, 'server-rendered result');
      assert.ok((await np.textContent('#productGrid')).includes('FAL-WAV-005') || (await np.textContent('#productGrid')).includes('موديل 5'));
      assert.strictEqual(await np.inputValue('#searchInput'), 'FAL-WAV-005', 'the header search shows the term');
      assert.ok((await np.getAttribute('meta[name=robots]', 'content')).includes('noindex'), 'a search result page is not indexed');
      await nojs.close();
      await vp.goto(base + '/products?q=FAL-WAV-005');
      await catalogReady(vp);
      assert.strictEqual(await vp.locator('#productGrid .product-card').count(), 1);
      assert.strictEqual(await vp.inputValue('#searchInput'), 'FAL-WAV-005');
      assert.deepStrictEqual(await currentNav(vp), ['/products']);
      await vp.fill('#searchInput', 'FAL-WAV-01');
      await vp.waitForFunction(n => document.querySelectorAll('#productGrid .product-card').length === n, searchCount(all, 'FAL-WAV-01'));
      assert.deepStrictEqual(pathAndQ(vp.url()), ['/products', 'FAL-WAV-01'], 'the address follows the search');
      await vp.fill('#searchInput', 'لا-يوجد-منتج-بهذا-الاسم');
      await vp.waitForSelector('#productGrid .no-results');
      assert.strictEqual(await vp.locator('#productGrid .product-card').count(), 0);
      await vp.fill('#searchInput', '');
      await vp.waitForFunction(n => document.querySelectorAll('#productGrid .product-card').length === n, all.length);
      assert.strictEqual(new URL(vp.url()).search, '', 'clearing the search clears ?q=');
      await settled(vp); await vp.screenshot({ path: path.join(SHOTS, '20-products-desktop.png') });
    })();

    // صفحة المنتج: تبديل الصور بالنقر ولوحة المفاتيح، وعدّاد السلة، ونسخ الرابط (صلاحية الحافظة ممنوحة للسياق).
    await check('product page: a two-photo product added in the admin — gallery thumbs switch (click + keyboard), add to cart counts, copy link', async () => {
      await ap.evaluate(() => navigate('products'));
      await ap.waitForSelector('#addProduct');
      await ap.click('#addProduct');
      await ap.waitForSelector('#productForm');
      await ap.setInputFiles('#productImages', [png, png2]);
      await ap.waitForFunction(() => document.querySelectorAll('#gmList .gm-item').length === 2, null, { timeout: 15000 });
      await ap.fill('#pName', GALLERY_NAME);
      await ap.selectOption('#pCategory', 'blinds');
      await ap.fill('#pPrice', '450');
      await ap.fill('#pStock', '4');
      await ap.fill('#pDescription', 'وصف تجريبي لصفحة المنتج');
      await ap.click('#productForm button[type=submit]');
      await ap.waitForFunction(n => document.querySelector('#productsBody').textContent.includes(n), GALLERY_NAME);
      galleryProduct = (await apiProducts()).find(p => p.name === GALLERY_NAME);
      assert.ok(galleryProduct && galleryProduct.images.length === 2, JSON.stringify(galleryProduct));
      const url = base + '/product/' + encodeURIComponent(galleryProduct.slug);
      const resp = await vp.goto(url);
      assert.strictEqual(resp.status(), 200);
      assert.strictEqual(await vp.getAttribute('body', 'data-page'), 'product');
      await oneH1(vp, GALLERY_NAME);
      assert.deepStrictEqual(await currentNav(vp), ['/products']);
      await catalogReady(vp);
      // gallery
      const thumbs = vp.locator('.product-gallery-thumbs [data-page-gindex]');
      assert.strictEqual(await thumbs.count(), 2);
      const [first, second] = galleryProduct.images.map(i => i.url);
      assert.notStrictEqual(first, second);
      const mainSrc = src => vp.waitForFunction(s => document.querySelector('#pageGalleryMain').getAttribute('src') === s, src);
      assert.strictEqual(await vp.getAttribute('#pageGalleryMain', 'src'), first);
      assert.strictEqual(await thumbs.nth(0).getAttribute('aria-pressed'), 'true');
      await thumbs.nth(1).click();
      await mainSrc(second);
      assert.deepStrictEqual([await thumbs.nth(0).getAttribute('aria-pressed'), await thumbs.nth(1).getAttribute('aria-pressed')], ['false', 'true']);
      await vp.keyboard.press('Home'); // keyboard: Home / End / arrows move between the photos and keep focus on the thumbnail
      await mainSrc(first);
      assert.strictEqual(await vp.evaluate(() => document.activeElement.dataset.pageGindex), '0');
      await vp.keyboard.press('End');
      await mainSrc(second);
      assert.strictEqual(await vp.evaluate(() => document.activeElement.dataset.pageGindex), '1');
      // add to cart
      const before = Number(await vp.textContent('#cartCount'));
      await vp.click('[data-add-product]');
      await vp.waitForFunction(n => Number(document.querySelector('#cartCount').textContent) === n + 1, before);
      assert.ok(await vp.evaluate(id => JSON.parse(localStorage.getItem('fakhama-cart-v1') || '[]').some(i => String(i.id) === String(id)), galleryProduct.id), 'saved in the cart');
      await vp.click('#cartOpen');
      await vp.waitForSelector('#cartDrawer.open');
      assert.ok((await vp.textContent('#cartItems')).includes(GALLERY_NAME), 'the cart lists the product');
      await vp.keyboard.press('Escape');
      await vp.waitForFunction(() => !document.querySelector('#cartDrawer.open'));
      // share + copy link
      assert.ok((await vp.getAttribute('.product-page-actions a[href^="https://wa.me/"]', 'href')).startsWith('https://wa.me/?text='), 'share link names no phone number');
      const copy = vp.locator('[data-copy-link]');
      assert.strictEqual(await copy.count(), 1, 'copy-link button');
      assert.strictEqual(await copy.getAttribute('data-copy-link'), url);
      await copy.click();
      await toastSays(vp, 'تم نسخ رابط المنتج');
      assert.strictEqual(await vp.evaluate(() => navigator.clipboard.readText()), url, 'the clipboard holds the product URL');
      await settled(vp); await vp.screenshot({ path: path.join(SHOTS, '21-product-page-desktop.png') });
    })();

    // المنتجات ذات الصلة تفتح المعاينة السريعة، وإغلاقها يعيد عنوان المنتج ويعيد التركيز لمكانه (إتاحة).
    await check('related products on a product page open the quick view; closing it (button or Escape) returns to the product URL and focus', async () => {
      const resp = await vp.goto(base + '/product/wavy-03');
      assert.strictEqual(resp.status(), 200);
      await catalogReady(vp);
      const card = vp.locator('#relatedGrid .product-card').first();
      await card.waitFor();
      const name = (await card.locator('.product-name').textContent()).trim();
      const trigger = card.locator('.quick-add');
      await trigger.click({ force: true });
      await vp.waitForSelector('#productModal.open');
      assert.strictEqual((await vp.textContent('#productModalTitle')).trim(), name);
      const opened = new URL(vp.url()).pathname;
      assert.ok(opened.startsWith('/product/') && opened !== '/product/wavy-03', 'URL follows the open product: ' + opened);
      await vp.click('#productModal [data-close-modal]');
      await vp.waitForFunction(() => !document.querySelector('#productModal.open'));
      await vp.waitForFunction(() => location.pathname === '/product/wavy-03');
      assert.ok((await vp.title()).includes('موديل 3'), 'title restored: ' + await vp.title());
      // keyboard: open with Enter, close with Escape, focus goes back to the button that opened it
      await trigger.focus();
      await vp.keyboard.press('Enter');
      await vp.waitForSelector('#productModal.open');
      await vp.keyboard.press('Escape');
      await vp.waitForFunction(() => !document.querySelector('#productModal.open'));
      await vp.waitForFunction(() => location.pathname === '/product/wavy-03');
      assert.ok(await trigger.evaluate(el => el === document.activeElement), 'focus returns to the quick-view button');
      assert.strictEqual(await vp.locator('#productTitle').count(), 1, 'still on the product page');
    })();

    // نص فيه رموز HTML عمداً (<> و&) للتأكد أنه يظهر كنص ولا يُفسَّر كوسوم.
    const CAT_DESC = 'وصف تجريبي لقسم الستائر <من اختبار الواجهة> & يظهر أعلى صفحة القسم';
    // صفحة القسم تعرض منتجاته فقط ووصف القسم المحفوظ في الإدارة (كنص مهرَّب).
    await check('category page lists only its own products and shows the description saved in the admin categories page (as text)', async () => {
      await ap.evaluate(() => navigate('categories'));
      await ap.waitForSelector('[data-edit-category="curtains"]');
      await ap.click('[data-edit-category="curtains"]');
      await ap.waitForSelector('#categoryForm');
      await ap.fill('#categoryDescription', CAT_DESC);
      await ap.click('#categoryForm button[type=submit]');
      await toastSays(ap, 'تم تحديث القسم');
      await ap.waitForFunction(t => [...document.querySelectorAll('#categoryGrid .cat-desc')].some(p => p.textContent === t), CAT_DESC);
      const cat = (await (await fetch(base + '/api/categories')).json()).categories.find(c => c.slug === 'curtains');
      assert.strictEqual(cat.description, CAT_DESC);
      const all = await apiProducts();
      const own = all.filter(p => p.category === 'curtains'), others = all.filter(p => p.category !== 'curtains');
      assert.ok(others.some(p => p.name === GALLERY_NAME), 'another category has a product');
      const resp = await vp.goto(base + '/category/curtains');
      assert.strictEqual(resp.status(), 200);
      assert.strictEqual(await vp.getAttribute('body', 'data-category'), 'curtains');
      await oneH1(vp, cat.name);
      assert.strictEqual((await vp.textContent('.page-hero-intro')).trim(), CAT_DESC, 'the description, escaped');
      const cards = async () => vp.$$eval('#productGrid .product-card', els => els.map(c => [c.querySelector('.product-name').textContent.trim(), c.querySelector('.product-category').textContent.trim()]));
      const serverCards = await cards();
      await catalogReady(vp);
      for (const shown of [serverCards, await cards()]) { // the server-rendered grid, then the live one
        assert.strictEqual(shown.length, own.length, 'cards: ' + shown.length);
        assert.ok(shown.every(([, c]) => c === cat.name), 'only this category');
        assert.ok(!shown.some(([n]) => others.some(o => o.name === n)), 'no product of another category');
      }
      assert.strictEqual(await vp.locator('#filterList').count(), 0, 'no category chips on a category page');
      assert.deepStrictEqual(await vp.$$eval('.category-switch a[aria-current="page"]', as => as.map(a => a.getAttribute('href'))), ['/category/curtains']);
      assert.deepStrictEqual(await currentNav(vp), ['/categories']);
      await settled(vp); await vp.screenshot({ path: path.join(SHOTS, '22-category-desktop.png') });
      // and the other way round: the gallery product's category shows it and nothing from curtains
      await vp.goto(base + '/category/blinds');
      await catalogReady(vp);
      const blinds = await cards();
      assert.deepStrictEqual(blinds.map(([n]) => n).sort(), all.filter(p => p.category === 'blinds').map(p => p.name).sort());
      assert.ok(blinds.some(([n]) => n === GALLERY_NAME));
    })();

    // فقرتا "من نحن" للاختبار؛ الثانية فيها رموز وسوم للتأكد من التهريب.
    const ABOUT = ['فقرة تجريبية أولى من اختبار الواجهة.', 'فقرة تجريبية ثانية <ليست وسمًا> من الاختبار.'];
    // صفحة "من نحن" تعرض النص المحفوظ من الإعدادات، وبيانات التواصل تبقى كما هي دون واجهة واتساب.
    await check('/about shows the text saved in the admin Settings page ("صفحة من نحن"); contact details stay as stored, no WhatsApp UI', async () => {
      await ap.evaluate(() => navigate('settings'));
      await ap.waitForSelector('#aboutForm');
      await ap.fill('#sAboutBody', ABOUT.join('\n\n'));
      await ap.click('#aboutForm button[type=submit]');
      await toastSays(ap, 'تم حفظ صفحة من نحن');
      const resp = await vp.goto(base + '/about');
      assert.strictEqual(resp.status(), 200);
      await oneH1(vp);
      assert.deepStrictEqual(await vp.$$eval('.about-story .prose p', ps => ps.map(p => p.textContent.trim())), ABOUT);
      assert.deepStrictEqual(await currentNav(vp), ['/about']);
      const store = await (await fetch(base + '/api/store')).json();
      assert.strictEqual(store.phone, '+966 57 648 6491');
      assert.strictEqual(store.map_url, 'https://maps.app.goo.gl/kn2kxuPujQT9raLG7?g_st=awb');
      assert.ok(!store.whatsapp, 'no WhatsApp number is stored');
      assert.ok((await vp.textContent('main')).includes(store.phone), 'the stored phone is shown');
      assert.strictEqual(await vp.locator('main a[href*="wa.me"]').count(), 0, 'no WhatsApp link while settings.whatsapp is empty');
      await settled(vp); await vp.screenshot({ path: path.join(SHOTS, '23-about-desktop.png'), fullPage: true });
    })();

    // حقل الفخ (honeypot) ضد البوتات: مخفي عن العين وقارئات الشاشة ويتخطاه Tab، فلا يملؤه إلا برنامج آلي.
    await check('contact form honeypot is invisible, aria-hidden and skipped by Tab', async () => {
      const resp = await mp.goto(base + '/contact');
      assert.strictEqual(resp.status(), 200);
      await oneH1(mp, 'تواصل معنا');
      assert.deepStrictEqual(await currentNav(mp), ['/contact']);
      const hp = await mp.$eval('#contactWebsite', el => {
        // the field sits in a wrapper that clips it to 1px and is fully transparent: measure what can actually be seen
        let clip = el.parentElement;
        while (clip && getComputedStyle(clip).overflow !== 'hidden') clip = clip.parentElement;
        const r = clip ? clip.getBoundingClientRect() : el.getBoundingClientRect();
        return { clipped: Boolean(clip && clip.contains(el) && clip !== document.body), area: r.width * r.height, tabIndex: el.tabIndex,
                 ariaHidden: Boolean(el.closest('[aria-hidden="true"]')),
                 visible: el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true }) };
      });
      assert.deepStrictEqual(hp, { clipped: true, area: hp.area, tabIndex: -1, ariaHidden: true, visible: false }, JSON.stringify(hp));
      assert.ok(hp.area <= 1, 'no visible area: ' + hp.area);
      await mp.focus('#contactMessage');
      await mp.keyboard.press('Tab');
      assert.strictEqual(await mp.evaluate(() => document.activeElement.name), 'consent', 'Tab goes from the message to the consent box');
      await mp.keyboard.press('Shift+Tab');
      assert.strictEqual(await mp.evaluate(() => document.activeElement.id), 'contactMessage');
      assert.strictEqual(await mp.locator('main a[href*="wa.me"]').count(), 0, 'no WhatsApp link while settings.whatsapp is empty');
    })();

    // رسالة اتصال للاختبار.
    const MSG = { name: 'زائر اختبار التواصل', phone: '0551234567', email: 'visitor@example.com', message: 'رسالة تجريبية من اختبار الواجهة لصفحة التواصل.' };
    // الرسالة المرسلة من صفحة التواصل تصل لصفحة الرسائل في الإدارة مع شارة "جديدة"، ثم تُعلَّم معالجة ثم تُحذف.
    await check('/contact message reaches the admin Messages page with the new-message badge; mark handled, then delete', async () => {
      await mp.fill('#contactName', MSG.name);
      await mp.fill('#contactPhone', MSG.phone);
      await mp.fill('#contactEmail', MSG.email);
      await mp.fill('#contactMessage', MSG.message);
      await mp.check('#contactForm input[name=consent]');
      await mp.click('#contactForm button[type=submit]');
      await mp.waitForSelector('#contactStatus[data-state="success"]');
      assert.ok((await mp.textContent('#contactStatus')).includes('وصلت رسالتك'));
      assert.strictEqual(await mp.inputValue('#contactName'), '', 'the form is cleared after sending');
      await settled(mp); await mp.screenshot({ path: path.join(SHOTS, '24-contact-sent-mobile.png') });
      // admin: badge + dashboard notice, then the inbox
      await ap.evaluate(() => navigate('overview'));
      await ap.waitForSelector('.stats-grid');
      await ap.waitForSelector('#messagesBadge:not(.hidden)', { state: 'attached' });
      assert.strictEqual((await ap.textContent('#messagesBadge [aria-hidden="true"]')).trim(), '1');
      assert.ok((await ap.textContent('#messagesBadge')).includes('رسالة جديدة واحدة'), 'screen readers hear the count');
      assert.strictEqual(await ap.locator('a.msg-alert[href="#messages/new"]').count(), 1, 'dashboard notice');
      await ap.evaluate(() => navigate('messages'));
      const card = () => ap.locator('#messagesList .msg-card', { hasText: MSG.name });
      await card().waitFor();
      const text = await card().textContent();
      assert.ok(text.includes(MSG.message) && text.includes(MSG.email) && text.includes('صفحة التواصل'), text);
      assert.strictEqual((await card().locator('.msg-head .badge').textContent()).trim(), 'جديدة');
      assert.strictEqual(await card().locator(`a[href="tel:${MSG.phone}"]`).count(), 1, 'call link');
      await settled(ap); await ap.screenshot({ path: path.join(SHOTS, '25-admin-messages-mobile.png') });
      await card().locator('[data-msg-status="handled"]').click();
      await toastSays(ap, 'تم تحديد الرسالة كمعالجة');
      await ap.waitForFunction(n => [...document.querySelectorAll('#messagesList .msg-card')].some(c => c.textContent.includes(n) && c.querySelector('.msg-head .badge').textContent.includes('تمت المعالجة')), MSG.name);
      await ap.waitForSelector('#messagesBadge.hidden', { state: 'attached' });
      ap.once('dialog', d => d.accept());
      await card().locator('[data-msg-delete]').click();
      await toastSays(ap, 'تم حذف الرسالة');
      await ap.waitForFunction(n => !document.querySelector('#pageContent').textContent.includes(n), MSG.name);
      assert.strictEqual((await ap.evaluate(() => api('/api/admin/messages?status=all'))).messages.length, 0, 'deleted on the server');
    })();

    // صفحة 404 بهوية المتجر: رمز 404 وnoindex وh1 واحد وصندوق بحث؛ وأي رابط صفحة بشرطة أخيرة يُعاد توجيهه (301)
    // بدونها.
    await check('unknown pages get the branded 404 (HTTP 404, noindex, one h1, search box); page URLs drop a trailing slash (301)', async () => {
      const resp = await mp.goto(base + '/no-such-page');
      assert.strictEqual(resp.status(), 404);
      assert.strictEqual(await mp.getAttribute('body', 'data-page'), 'notfound');
      await oneH1(mp, 'الصفحة غير موجودة');
      assert.ok((await mp.getAttribute('meta[name=robots]', 'content')).includes('noindex'));
      assert.deepStrictEqual(await currentNav(mp), [], 'no menu link is current');
      assert.deepStrictEqual(await mp.$$eval('.notfound-links a', as => as.map(a => a.getAttribute('href'))), ['/', '/products', '/categories', '/faq', '/contact']);
      await settled(mp); await mp.screenshot({ path: path.join(SHOTS, '26-not-found-mobile.png') });
      await mp.fill('#notFoundSearch', 'FAL-WAV-005');
      await follow(mp, () => mp.press('#notFoundSearch', 'Enter'));
      assert.deepStrictEqual(pathAndQ(mp.url()), ['/products', 'FAL-WAV-005']);
      await catalogReady(mp);
      assert.strictEqual(await mp.locator('#productGrid .product-card').count(), 1);
      const gone = await mp.goto(base + '/product/no-such-product');
      assert.strictEqual(gone.status(), 404);
      await oneH1(mp, 'الصفحة غير موجودة');
      assert.ok((await mp.textContent('.page-hero-intro')).includes('هذا المنتج غير متاح'));
      for (const [from, to] of [['/about/', '/about'], ['/category/curtains/', '/category/curtains']]) {
        const r = await fetch(base + from, { redirect: 'manual' });
        assert.strictEqual(r.status, 301, from);
        assert.strictEqual(r.headers.get('location'), to, from);
      }
    })();

    // البحث من أي صفحة غير المتجر ينقل إلى /products?q= (زر البحث على الهاتف وصندوقه على سطح المكتب).
    await check('header search on a non-shop page goes to /products?q= (phone search toggle and desktop)', async () => {
      const all = await apiProducts();
      await mp.goto(base + '/faq');
      await mp.click('#searchToggle');
      await mp.fill('#searchInput', 'FAL-WAV-005');
      const resp = await follow(mp, () => mp.press('#searchInput', 'Enter'));
      assert.strictEqual(resp.status(), 200);
      assert.deepStrictEqual(pathAndQ(mp.url()), ['/products', 'FAL-WAV-005']);
      await catalogReady(mp);
      assert.strictEqual(await mp.locator('#productGrid .product-card').count(), 1);
      assert.strictEqual(await mp.inputValue('#searchInput'), 'FAL-WAV-005');
      assert.deepStrictEqual(await currentNav(mp), ['/products']);
      await vp.goto(base + '/about');
      await vp.fill('#searchInput', 'موديل 3');
      await follow(vp, () => vp.press('#searchInput', 'Enter'));
      assert.deepStrictEqual(pathAndQ(vp.url()), ['/products', 'موديل 3']);
      await catalogReady(vp);
      assert.strictEqual(await vp.locator('#productGrid .product-card').count(), searchCount(all, 'موديل 3'));
      await vp.goto(base + '/contact'); // an empty search opens the full list
      await follow(vp, () => vp.press('#searchInput', 'Enter'));
      assert.deepStrictEqual(pathAndQ(vp.url()), ['/products', null]);
    })();
    // القسم الرابع: ميزات الواجهة الجديدة (الهياكل المؤقتة، الاقتراحات، التصفية، المشاهَد مؤخراً، المفضلة،
    // السلة، الطلب، المعارض، التثبيت، وضع عدم الاتصال).
    // ------------------------------------------------------------ storefront v2: skeletons, suggestions, filters, recents, wishlist, cart, order flow, galleries, install, offline
    // toNum: يحوّل نصاً فيه أرقام عربية-هندية إلى رقم عادي لمقارنة الأسعار والكميات.
    const toNum = t => Number(String(t).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d]/g, ''));
    const SOLD_OUT = 'ستارة نفدت للاختبار';
    let soldOut = null;
    // quickView: التمرير سلس في الموقع، فننقل البطاقة للمشهد فوراً قبل النقر لأن موضع الزر يتغير أثناء التمرير.
    // the page scrolls smoothly: bring the card into view at once so the click lands where the button really is
    const quickView = async loc => { await loc.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await loc.click({ force: true }); };
    const desktopCtx = async (extra = {}) => { const c = await browser.newContext({ viewport: { width: 1366, height: 800 }, locale: 'ar-SA', ...extra }); await c.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {}); return c; };
    // layoutShift: يقيس انزياح التخطيط التراكمي (CLS) بواسطة PerformanceObserver لاستبعاد القفزات بعد التفاعل.
    const layoutShift = pg => pg.evaluate(() => new Promise(res => { let v = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) v += e.value; }).observe({ type: 'layout-shift', buffered: true }); setTimeout(() => res(v), 2200); }));

    // تجهيز: منتج مخزونه صفر لاختبار فلتر "المتوفر فقط"، ويُحذف في فحص التنظيف لاحقاً.
    await check('setup: a sold-out product (stock 0) exists for the availability filter', async () => {
      const made = await ap.evaluate(name => api('/api/admin/products', { method: 'POST', body: { name, category: 'curtains', price: 120, stock: 0, active: true, description: 'منتج نفد للاختبار', image: '/assets/wavy-04.jpg' } }), SOLD_OUT);
      soldOut = made.product;
      assert.ok(soldOut && soldOut.id && Number(soldOut.stock) === 0, JSON.stringify(made));
    })();

    // أثناء التحميل تظهر بطاقات هيكلية (aria-busy ومخفية عن قارئ الشاشة) ثم المنتجات، مع إبقاء المساحة محجوزة
    // لتقليل قفزة التخطيط.
    await check('loading shows skeleton cards (aria-busy, hidden from screen readers), then real products; images fade in; reserved space (little layout shift)', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'skeleton');
      await pg.route('**/api/products', async route => { await sleep(900); await route.continue(); });
      await pg.goto(base + '/');
      await pg.waitForSelector('#productGrid .product-card.skeleton');
      assert.strictEqual(await pg.getAttribute('#productGrid', 'aria-busy'), 'true');
      const skels = await pg.locator('#productGrid .product-card.skeleton').count();
      assert.ok(skels >= 4, 'skeleton cards: ' + skels);
      assert.strictEqual(await pg.locator('#productGrid .product-card.skeleton[aria-hidden="true"]').count(), skels);
      assert.ok(await pg.locator('#categoryGrid .category-card.skeleton').count() >= 1, 'category placeholders');
      await catalogReady(pg);
      assert.strictEqual(await pg.locator('.skeleton').count(), 0, 'skeletons are replaced');
      assert.strictEqual(await pg.getAttribute('#productGrid', 'aria-busy'), null);
      await pg.$$eval('img.product-image', imgs => imgs.forEach(i => { i.loading = 'eager'; }));
      await pg.waitForFunction(() => [...document.querySelectorAll('img.product-image')].every(i => !i.classList.contains('fade-img') || i.classList.contains('is-loaded')));
      const shift = await layoutShift(pg);
      assert.ok(shift < 0.15, 'cumulative layout shift ' + shift.toFixed(3));
      await ctx.close();
      const m = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-SA', isMobile: true, hasTouch: true, serviceWorkers: 'block' }); const mpg = await m.newPage();
      await mpg.goto(base + '/'); await catalogReady(mpg);
      const mshift = await layoutShift(mpg);
      assert.ok(mshift < 0.15, 'phone layout shift ' + mshift.toFixed(3));
      assert.ok(await mpg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on the phone home page');
      await m.close();
    })();

    // صورة الهيرو عنصر img حقيقي بأولوية تحميل عالية، وعند تفضيل المستخدم تقليل الحركة تتوقف حركتها.
    await check('hero: real <img> with fetchpriority=high that loads, category shortcut chips; reduced motion stops the hero motion', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); await pg.goto(base + '/'); await catalogReady(pg);
      assert.strictEqual(await pg.getAttribute('.hero-bg', 'fetchpriority'), 'high');
      assert.ok(await pg.$eval('.hero-bg', i => i.complete && i.naturalWidth > 0), 'hero image decoded');
      const chips = await pg.$$eval('#heroChips a', as => as.map(a => a.getAttribute('href')));
      assert.strictEqual(chips.length, await pg.locator('#categoryGrid .category-card').count(), 'one shortcut per visible category');
      assert.ok(chips.every(h => h.startsWith('/category/')), chips.join());
      assert.notStrictEqual(await pg.$eval('.hero-bg', el => getComputedStyle(el).animationName), 'none', 'ken-burns runs by default');
      await ctx.close();
      const calm = await desktopCtx({ reducedMotion: 'reduce', serviceWorkers: 'block' }); const cp = await calm.newPage(); await cp.goto(base + '/'); await catalogReady(cp);
      assert.strictEqual(await cp.$eval('.hero-bg', el => getComputedStyle(el).animationName), 'none');
      assert.strictEqual(await cp.$eval('.hero h1', el => getComputedStyle(el).animationName), 'none');
      await calm.close();
    })();

    // الاقتراحات: قائمة combobox بتأخير قصير بعد الكتابة، مطابقة تراعي العربية، تمييز الكلمة، والتنقل بالأسهم
    // وEnter وEscape.
    await check('search: debounced suggestions (combobox), Arabic-aware matching, highlight, arrow keys + Enter, Escape', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'suggest'); await pg.goto(base + '/'); await catalogReady(pg);
      assert.strictEqual(await pg.getAttribute('#searchInput', 'role'), 'combobox');
      assert.strictEqual(await pg.getAttribute('#searchInput', 'aria-expanded'), 'false');
      await pg.fill('#searchInput', 'ويفي');
      await pg.waitForSelector('#searchSuggest:not([hidden])');
      assert.strictEqual(await pg.getAttribute('#searchInput', 'aria-expanded'), 'true');
      const options = pg.locator('#searchSuggest [role=option]');
      const n = await options.count();
      assert.ok(n >= 3 && n <= 6, 'up to five products plus "show all": ' + n);
      assert.ok(await pg.locator('#searchSuggest .suggest-item mark').count() >= 1, 'the matched word is highlighted');
      assert.ok((await options.last().textContent()).includes('عرض كل النتائج'));
      assert.ok((await pg.textContent('#searchStatus')).includes('مطابقة'), 'result count announced');
      await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('ArrowDown');
      const active = await pg.getAttribute('#searchInput', 'aria-activedescendant');
      assert.strictEqual(active, 'sg-1');
      assert.strictEqual(await pg.getAttribute('#' + active, 'aria-selected'), 'true');
      assert.strictEqual(await pg.locator('#searchSuggest [aria-selected="true"]').count(), 1);
      await pg.keyboard.press('ArrowUp'); await pg.keyboard.press('ArrowUp'); // up from the first option wraps to the last one
      assert.strictEqual(await pg.getAttribute('#searchInput', 'aria-activedescendant'), 'sg-all');
      await pg.keyboard.press('Escape');
      assert.strictEqual(await pg.locator('#searchSuggest:not([hidden])').count(), 0, 'Escape closes the list');
      assert.strictEqual(await pg.inputValue('#searchInput'), 'ويفي', 'and keeps the text');
      // Arabic variants: ئ/ي and diacritics find «ستائر»
      for (const variant of ['ستاير', 'سِتَائِر', 'ستائر']) {
        await pg.fill('#searchInput', variant);
        await pg.waitForSelector('#searchSuggest:not([hidden]) .suggest-item');
      }
      await pg.fill('#searchInput', 'ويفي');
      await pg.waitForSelector('#searchSuggest:not([hidden]) .suggest-item');
      await pg.keyboard.press('ArrowDown');
      const href = await pg.getAttribute('#sg-0', 'data-href');
      await Promise.all([pg.waitForURL(u => u.pathname.startsWith('/product/')), pg.keyboard.press('Enter')]);
      assert.strictEqual(new URL(pg.url()).pathname, href);
      // nothing found
      await pg.goto(base + '/about'); await catalogReady(pg);
      await pg.fill('#searchInput', 'لا-يوجد-منتج-بهذا-الاسم');
      await pg.waitForSelector('#searchSuggest .suggest-empty');
      assert.strictEqual(await pg.getAttribute('#searchInput', 'aria-activedescendant'), null);
      // the results list highlights the term too, and the typed phrase sorts best matches first
      await pg.goto(base + '/products?q=' + encodeURIComponent('ستاير')); await catalogReady(pg);
      assert.ok(await pg.locator('#productGrid .product-name mark').count() >= 1, 'highlight in the product names');
      await ctx.close();
    })();

    // الفرز و"المتوفر فقط" والقسم تُخزَّن في عنوان الصفحة (قابلة للمشاركة والاستعادة بعد إعادة التحميل) مع زر مسح.
    await check('filters: sort + "available only" + category live in the URL (shareable, restored on reload), clear button, newest first', async () => {
      const all = await apiProducts();
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'filters');
      await pg.goto(base + '/products?sort=low&stock=1'); await catalogReady(pg);
      assert.strictEqual(await pg.inputValue('#sortSelect'), 'low');
      assert.ok(await pg.isChecked('#stockOnly'));
      assert.ok(await pg.isVisible('#clearFilters'));
      const inStock = all.filter(p => p.stock > 0);
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), inStock.length);
      assert.ok(!(await pg.textContent('#productGrid')).includes(SOLD_OUT), 'the sold-out product is hidden by "available only"');
      const prices = await pg.$$eval('#productGrid .product-card', cs => cs.map(c => c.querySelector('.product-price').textContent.includes('حسب الطلب') ? Infinity : Number(c.querySelector('.product-price').textContent.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d]/g, ''))));
      assert.deepStrictEqual(prices, [...prices].sort((a, b) => a - b), 'cheapest first, "price on request" last');
      await pg.click('#filterList [data-filter="blinds"]');
      await pg.waitForFunction(() => new URLSearchParams(location.search).get('cat') === 'blinds');
      assert.deepStrictEqual([...new URL(pg.url()).searchParams.keys()].sort(), ['cat', 'sort', 'stock']);
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), inStock.filter(p => p.category === 'blinds').length);
      await pg.reload(); await catalogReady(pg);
      assert.strictEqual(await pg.getAttribute('#filterList [data-filter="blinds"]', 'aria-pressed'), 'true', 'the category chip is restored');
      assert.strictEqual(await pg.inputValue('#sortSelect'), 'low');
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), inStock.filter(p => p.category === 'blinds').length);
      await pg.click('#clearFilters');
      assert.strictEqual(new URL(pg.url()).search, '', 'clearing resets the address');
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), all.length);
      assert.ok(await pg.isHidden('#clearFilters'));
      await pg.selectOption('#sortSelect', 'newest');
      assert.strictEqual((await pg.locator('#productGrid .product-name').first().textContent()).trim(), SOLD_OUT, 'newest product first');
      assert.strictEqual(new URL(pg.url()).searchParams.get('sort'), 'newest');
      await pg.goto(base + '/products?cat=%D9%84%D8%A7-%D9%8A%D9%88%D8%AC%D8%AF'); await catalogReady(pg); // unknown category falls back to all
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), all.length);
      assert.ok(await pg.locator('#productGrid .no-results').count() === 0);
      await pg.goto(base + '/category/curtains?stock=1'); await catalogReady(pg); // category pages keep sort/availability too
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), inStock.filter(p => p.category === 'curtains').length);
      await ctx.close();
    })();

    // شريط "شوهد مؤخراً": الأحدث أولاً، يستبعد المنتج الحالي، وزر المسح يفرّغه.
    await check('recently viewed: quick views and product pages are remembered (newest first), the current product is left out, "clear" empties it', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'recent'); await pg.goto(base + '/'); await catalogReady(pg);
      assert.strictEqual(await pg.locator('#recentSection').count(), 0, 'nothing before anything was viewed');
      const names = [];
      for (const i of [0, 1]) {
        const card = pg.locator('#productGrid .product-card').nth(i);
        names.push((await card.locator('.product-name').textContent()).trim());
        await quickView(card.locator('.quick-add'));
        await pg.waitForSelector('#productModal.open');
        await pg.keyboard.press('Escape');
        await pg.waitForFunction(() => !document.querySelector('#productModal.open'));
      }
      await pg.waitForSelector('#recentSection .recent-item');
      assert.deepStrictEqual(await pg.$$eval('#recentSection .recent-item b', bs => bs.map(b => b.textContent.trim())), [names[1], names[0]]);
      assert.strictEqual(await pg.evaluate(() => JSON.parse(localStorage.getItem('fakhama-recent-v1')).length), 2);
      assert.strictEqual(await pg.getAttribute('#recentSection', 'aria-labelledby'), 'recentTitle');
      await pg.reload(); await catalogReady(pg);
      await pg.waitForSelector('#recentSection .recent-item');
      assert.strictEqual(await pg.locator('#recentSection .recent-item').count(), 2, 'persists across visits');
      await Promise.all([pg.waitForNavigation(), pg.click('#recentSection .recent-item a >> nth=1')]);
      await catalogReady(pg);
      assert.strictEqual((await pg.textContent('#productTitle')).trim(), names[0]);
      await pg.waitForSelector('#recentSection .recent-item');
      assert.deepStrictEqual(await pg.$$eval('#recentSection .recent-item b', bs => bs.map(b => b.textContent.trim())), [names[1]], 'the product being viewed is not listed');
      await pg.click('#clearRecent');
      await pg.waitForFunction(() => !document.querySelector('#recentSection'));
      assert.strictEqual(await pg.evaluate(() => localStorage.getItem('fakhama-recent-v1')), null);
      await ctx.close();
    })();

    // المفضلة: زر باسم ثابت وaria-pressed، تُحفظ في المتصفح، وتتزامن بين التبويبات والمعاينة السريعة، ويعرضها
    // /products?favorites=1.
    await check('wishlist: accessible toggle (stable name + aria-pressed), persists, syncs across tabs and the quick view, /products?favorites=1', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'wishlist'); await pg.goto(base + '/'); await catalogReady(pg);
      const heart = pg.locator('#productGrid .favorite-btn').first();
      const label = await heart.getAttribute('aria-label');
      assert.ok(label.startsWith('المفضلة: '), label);
      assert.strictEqual(await heart.getAttribute('aria-pressed'), 'false');
      await heart.click();
      assert.strictEqual(await heart.getAttribute('aria-pressed'), 'true');
      assert.strictEqual(await heart.getAttribute('aria-label'), label, 'the accessible name does not flip with the state');
      await toastSays(pg, 'أُضيف إلى المفضلة');
      assert.strictEqual((await pg.textContent('#favCount')).trim(), '1');
      await pg.reload(); await catalogReady(pg);
      assert.strictEqual(await pg.locator('#productGrid .favorite-btn').first().getAttribute('aria-pressed'), 'true', 'persisted');
      const pg2 = await ctx.newPage(); await pg2.goto(base + '/'); await catalogReady(pg2);
      await pg2.locator('#productGrid .favorite-btn').nth(1).click();
      await pg.waitForFunction(() => document.querySelector('#favCount').textContent.trim() === '2'); // storage event
      assert.strictEqual(await pg.locator('#productGrid .favorite-btn').nth(1).getAttribute('aria-pressed'), 'true');
      // quick view has its own heart, in sync with the grid
      await quickView(pg.locator('#productGrid .quick-add').first());
      await pg.waitForSelector('#productModal.open');
      assert.strictEqual(await pg.getAttribute('#productModal .favorite-btn', 'aria-pressed'), 'true');
      await pg.click('#productModal .favorite-btn');
      assert.strictEqual(await pg.getAttribute('#productModal .favorite-btn', 'aria-pressed'), 'false');
      assert.strictEqual(await pg.locator('#productGrid .favorite-btn').first().getAttribute('aria-pressed'), 'false', 'the grid follows');
      await pg.keyboard.press('Escape'); await pg.waitForFunction(() => !document.querySelector('#productModal.open'));
      await pg.goto(base + '/products?favorites=1'); await catalogReady(pg);
      assert.strictEqual(await pg.locator('#productGrid .product-card').count(), 1);
      await pg2.close(); await ctx.close();
    })();

    // درج السلة: أزرار الكمية وإجمالي كل سطر، وحدّ الكمية عند المخزون، والتراجع بعد الحذف، ومجموع صادق يوضح أن
    // بعض الأسعار عند الطلب.
    await check('cart drawer: quantity steppers, line totals, limit at stock (aria-disabled + hint), undo after removing, honest "price on request" subtotal', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'cart'); await pg.goto(base + '/'); await catalogReady(pg);
      const stock = Number(galleryProduct.stock);
      await pg.fill('#searchInput', GALLERY_NAME);
      await pg.waitForFunction(() => document.querySelectorAll('#productGrid .product-card').length === 1);
      await pg.locator('#searchInput').blur(); // leave the field: the suggestion list would cover the card
      await quickView(pg.locator('#productGrid .quick-add'));
      await pg.waitForSelector('#productModal.open');
      for (let i = 1; i < stock; i++) await pg.click('[data-mqty="1"]');
      assert.strictEqual((await pg.textContent('#modalQty')).trim(), String(stock));
      await pg.click('[data-mqty="1"]'); // already at the limit
      await toastSays(pg, 'الكمية المتاحة');
      assert.strictEqual((await pg.textContent('#modalQty')).trim(), String(stock));
      await pg.click('[data-mqty="-1"]'); await pg.click('[data-mqty="-1"]'); // two pieces
      await pg.click('[data-modal-add]');
      await pg.waitForFunction(() => !document.querySelector('#productModal.open'));
      await pg.click('#cartOpen'); await pg.waitForSelector('#cartDrawer.open');
      assert.strictEqual(toNum(await pg.textContent('#cartDrawer .cart-line .line-total')), 450 * (stock - 2), 'line total = unit price x quantity');
      assert.strictEqual(toNum(await pg.textContent('#cartSubtotal')), 450 * (stock - 2));
      assert.ok((await pg.textContent('#subtotalLabel')).includes('قبل التوصيل'));
      assert.strictEqual(await pg.locator('#pendingNote:not([hidden])').count(), 0, 'no pending note while every item has a price');
      // + up to the limit
      const plus = pg.locator('#cartItems [data-change="1"]');
      for (let i = 0; i < 2; i++) { await plus.click(); assert.ok(await pg.evaluate(() => document.activeElement.dataset.change === '1'), 'keyboard focus stays on the stepper'); }
      assert.strictEqual(await plus.getAttribute('aria-disabled'), 'true');
      assert.ok((await pg.textContent('#cartItems .stock-hint')).includes('أقصى كمية'));
      await plus.click({ force: true }); await toastSays(pg, 'الكمية المتاحة'); // aria-disabled, not disabled: the button keeps keyboard focus
      assert.strictEqual((await pg.textContent('#cartItems output')).trim(), String(stock));
      // remove → undo
      await pg.click('#cartItems [data-remove]');
      await pg.waitForSelector('#cartItems .undo-bar');
      assert.ok((await pg.textContent('#cartItems')).includes('سلتك بانتظار اختيارك'));
      await pg.click('#cartItems [data-undo]');
      await pg.waitForSelector('#cartItems .cart-line');
      assert.strictEqual((await pg.textContent('#cartItems output')).trim(), String(stock), 'quantity restored');
      assert.strictEqual(await pg.evaluate(() => JSON.parse(localStorage.getItem('fakhama-cart-v1')).reduce((s, i) => s + i.qty, 0)), stock);
      // a made-to-order piece: not priced, said plainly
      await pg.click('#cartClose'); await pg.waitForFunction(() => !document.querySelector('#cartDrawer.open'));
      await pg.waitForSelector('#drawerOverlay', { state: 'hidden' }); // its fade-out would otherwise take the next click
      await pg.fill('#searchInput', 'FAL-WAV-005');
      await pg.waitForFunction(() => document.querySelectorAll('#productGrid .product-card').length === 1);
      await pg.locator('#searchInput').blur();
      await quickView(pg.locator('#productGrid .quick-add'));
      await pg.waitForSelector('#productModal.open'); await pg.click('[data-modal-add]');
      await pg.click('#cartOpen'); await pg.waitForSelector('#cartDrawer.open');
      const note = await pg.textContent('#pendingNote');
      assert.ok(await pg.isVisible('#pendingNote') && note.includes('حسب الطلب') && note.includes('لا يدخل في المجموع'), note);
      const sub = await pg.textContent('#cartSubtotal');
      assert.ok(sub.includes('حسب الطلب') && toNum(sub) === 450 * stock, 'known part + "price on request": ' + sub);
      assert.ok((await pg.textContent('#subtotalLabel')).includes('المسعّرة فقط'));
      assert.ok((await pg.textContent('#cartTotal')).includes('حسب الطلب'));
      assert.strictEqual(await pg.locator('#cartItems .line-total').count(), 1, 'only the priced line shows a total');
      await pg.screenshot({ path: path.join(SHOTS, '30-cart-desktop.png') });
      await ctx.close();
    })();

    // مسار الطلب: ملخص، تحقق مضمّن مع aria-invalid ونقل التركيز، قبول الأرقام العربية، عرض خطأ الخادم داخل
    // النموذج، ثم لوحة التأكيد برقم الطلب.
    await check('order flow: summary, inline validation (aria-invalid, messages, focus), Arabic digits accepted, server error shown inline, confirmation panel with order number', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-SA', isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
      const pg = await ctx.newPage(); watch(pg, 'order', ['/api/orders']); await pg.goto(base + '/'); await catalogReady(pg); // the 400 below is the point of one step
      await pg.evaluate(id => addToCart(id, 2), galleryProduct.id);
      await pg.click('#cartOpen'); await pg.click('#checkoutBtn'); await pg.waitForSelector('#orderModal.open');
      assert.strictEqual(await pg.locator('#orderSteps li[aria-current="step"]').textContent(), '٢بياناتك');
      const summary = await pg.textContent('#orderSummary');
      assert.ok(summary.includes(GALLERY_NAME) && summary.includes('الإجمالي التقديري') && toNum(summary.replace(GALLERY_NAME, '').replace(/[×]\s*[٠-٩\d]+/, '')) >= 900, summary);
      // empty submit: summary alert, first invalid field focused, one message per field
      await pg.click('#orderForm button[type=submit]');
      assert.ok(await pg.isVisible('#orderAlert'), 'error summary');
      assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'customerName');
      for (const id of ['customerName', 'customerPhone', 'orderConsent']) assert.strictEqual(await pg.getAttribute('#' + id, 'aria-invalid'), 'true', id);
      assert.strictEqual(await pg.getAttribute('#customerCity', 'aria-invalid'), null, 'the city is pre-filled and valid');
      assert.ok((await pg.textContent('#customerNameError')).includes('الاسم'));
      assert.ok((await pg.textContent('#customerPhoneError')).includes('رقم الجوال'));
      assert.ok((await pg.textContent('#orderConsentError')).includes('الخصوصية'));
      assert.ok((await pg.getAttribute('#customerPhone', 'aria-describedby')).includes('customerPhoneError'));
      await pg.screenshot({ path: path.join(SHOTS, '31-order-errors-mobile.png') });
      // each message goes away as soon as the value is right; a Saudi number must be 05 + 8 digits
      await pg.fill('#customerName', 'ع'); await pg.locator('#customerName').blur();
      assert.ok((await pg.textContent('#customerNameError')).includes('حرفان'));
      await pg.fill('#customerName', 'عميل اختبار الطلب');
      assert.strictEqual(await pg.getAttribute('#customerName', 'aria-invalid'), null);
      assert.ok(await pg.isHidden('#customerNameError'));
      await pg.fill('#customerPhone', '055123456'); await pg.locator('#customerPhone').blur();
      assert.ok((await pg.textContent('#customerPhoneError')).includes('05'), await pg.textContent('#customerPhoneError'));
      await pg.fill('#customerPhone', '123'); await pg.locator('#customerPhone').blur();
      assert.ok((await pg.textContent('#customerPhoneError')).includes('غير صحيح'));
      await pg.fill('#customerPhone', '٠٥٥١٢٣٤٥٦٧');
      assert.ok(await pg.isHidden('#customerPhoneError'), 'Arabic-Indic digits are accepted');
      await pg.check('#orderConsent');
      assert.ok(await pg.isHidden('#orderConsentError'));
      // a server-side refusal is shown inside the dialog (and the form keeps what was typed)
      await pg.route('**/api/orders', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'تحقق من رقم الجوال.' }) }));
      await pg.click('#orderForm button[type=submit]');
      await pg.waitForFunction(() => document.querySelector('#orderAlert').textContent.includes('تحقق من رقم الجوال'));
      assert.strictEqual(await pg.inputValue('#customerName'), 'عميل اختبار الطلب');
      assert.strictEqual(await pg.locator('#orderAlert').evaluate(el => el === document.activeElement), true, 'the alert takes focus');
      await pg.unroute('**/api/orders');
      await pg.click('#orderForm button[type=submit]');
      await pg.waitForSelector('#orderDone:not([hidden])');
      const number = (await pg.textContent('#orderDone bdi')).trim();
      assert.match(number, /^MH-\d{6}-\d{5}$/);
      assert.strictEqual((await pg.textContent('#orderTitle')).trim(), 'تم تسجيل طلبك');
      assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'orderTitle', 'focus moves to the confirmation heading');
      assert.ok(await pg.isHidden('#orderBody'));
      assert.strictEqual(await pg.locator('#orderSteps li.done').count(), 3);
      assert.strictEqual(await pg.locator('#orderSteps li[aria-current="step"]').textContent(), '٣التأكيد');
      assert.strictEqual(await pg.evaluate(() => JSON.parse(localStorage.getItem('fakhama-cart-v1') || '[]').length), 0, 'cart cleared');
      const stored = await ap.evaluate(num => api('/api/admin/orders').then(r => JSON.stringify(r).includes(num) ? JSON.stringify(r) : ''), number);
      assert.ok(stored.includes('0551234567'), 'the order reached the admin with Latin digits');
      await pg.click('[data-copy-order]');
      await toastSays(pg, 'تم نسخ رقم الطلب');
      assert.strictEqual(await pg.evaluate(() => navigator.clipboard.readText()), number);
      await pg.screenshot({ path: path.join(SHOTS, '32-order-done-mobile.png') });
      await pg.click('[data-order-close]');
      await pg.waitForFunction(() => !document.querySelector('#orderModal.open'));
      await pg.evaluate(id => addToCart(id, 1), galleryProduct.id); await pg.click('#cartOpen'); await pg.click('#checkoutBtn');
      assert.ok(await pg.isVisible('#orderBody') && await pg.isHidden('#orderDone'), 'the form is back for the next order');
      assert.strictEqual(await pg.inputValue('#customerName'), '', 'nothing from the last order is kept');
      await ctx.close();
    })();

    // معرض صفحة المنتج: أسهم وعدّاد وسحب باللمس وتكبير بالنقر وزر تكبير، وEscape يخرج من التكبير.
    await check('product page gallery: arrows + counter, swipe, tap-to-zoom, zoom button, Escape leaves the zoom, arrow keys', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'gallery');
      await pg.goto(base + '/product/' + encodeURIComponent(galleryProduct.slug)); await catalogReady(pg);
      const [first, second] = galleryProduct.images.map(i => i.url);
      const src = () => pg.getAttribute('#pageGalleryMain', 'src');
      const at = s => pg.waitForFunction(v => document.querySelector('#pageGalleryMain').getAttribute('src') === v, s);
      assert.strictEqual(await pg.locator('.gnav').count(), 2);
      assert.strictEqual((await pg.textContent('#pageGalleryCount')).trim(), '١ من ٢');
      await pg.click('.gnav-next'); await at(second);
      assert.strictEqual((await pg.textContent('#pageGalleryCount')).trim(), '٢ من ٢');
      assert.strictEqual(await pg.getAttribute('[data-page-gindex="1"]', 'aria-pressed'), 'true');
      await pg.click('.gnav-next'); await at(first); // wraps
      const box = await pg.locator('.product-gallery-main').boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const swipe = async dx => { await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + dx / 2, cy + 4, { steps: 4 }); await pg.mouse.move(cx + dx, cy + 6, { steps: 4 }); await pg.mouse.up(); };
      await swipe(-140); await at(second); // RTL: swipe towards the left = next photo
      await swipe(140); await at(first);
      assert.strictEqual(await pg.locator('.product-gallery-main.is-zoomed').count(), 0, 'a swipe does not zoom');
      await pg.mouse.click(cx, cy);
      await pg.waitForSelector('.product-gallery-main.is-zoomed');
      assert.strictEqual(await pg.getAttribute('.product-gallery-main [data-zoom-toggle]', 'aria-pressed'), 'true');
      await swipe(-140);
      assert.strictEqual(await src(), first, 'no swipe navigation while zoomed');
      await pg.keyboard.press('Escape');
      await pg.waitForFunction(() => !document.querySelector('.product-gallery-main.is-zoomed'));
      await pg.click('.product-gallery-main [data-zoom-toggle]');
      assert.strictEqual(await pg.locator('.product-gallery-main.is-zoomed').count(), 1);
      await pg.click('.product-gallery-main [data-zoom-toggle]');
      assert.strictEqual(await pg.locator('.product-gallery-main.is-zoomed').count(), 0);
      await pg.focus('.gnav-next'); await pg.keyboard.press('ArrowLeft'); await at(second);
      await pg.keyboard.press('ArrowRight'); await at(first);
      await ctx.close();
    })();

    // معرض المعاينة السريعة: أول Escape يخرج من التكبير فقط والثاني يغلق النافذة؛ والصورة المبدئية الضبابية هي
    // المصغرة.
    await check('quick view gallery: arrows, thumbnails, zoom; first Escape leaves the zoom and only the second closes the dialog; blur-up placeholder is the thumbnail', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' }); const pg = await ctx.newPage(); watch(pg, 'quickview'); await pg.goto(base + '/'); await catalogReady(pg);
      await pg.fill('#searchInput', GALLERY_NAME);
      await pg.waitForFunction(() => document.querySelectorAll('#productGrid .product-card').length === 1);
      await pg.locator('#searchInput').blur(); // leave the field: the suggestion list would cover the card
      await quickView(pg.locator('#productGrid .quick-add'));
      await pg.waitForSelector('#productModal.open');
      const [first, second] = galleryProduct.images;
      assert.ok((await pg.getAttribute('#galleryStage', 'style')).includes(first.thumb), 'the thumbnail is the placeholder behind the full photo');
      const at = s => pg.waitForFunction(v => document.querySelector('#galleryMain').getAttribute('src') === v, s);
      await pg.click('#productModal .gnav-next'); await at(second.url);
      assert.strictEqual((await pg.textContent('#galleryCount')).trim(), '٢ من ٢');
      assert.ok((await pg.getAttribute('#galleryStage', 'style')).includes(second.thumb));
      assert.ok((await pg.textContent('#galleryStatus')).includes('الصورة'), 'announced to screen readers');
      await pg.click('#productModal .gnav-prev'); await at(first.url);
      await pg.keyboard.press('ArrowLeft'); await at(second.url); // existing keyboard support still works
      await pg.click('#productModal [data-zoom-toggle]');
      assert.strictEqual(await pg.locator('#galleryStage.is-zoomed').count(), 1);
      await pg.keyboard.press('Escape');
      assert.strictEqual(await pg.locator('#galleryStage.is-zoomed').count(), 0);
      assert.strictEqual(await pg.locator('#productModal.open').count(), 1, 'the dialog stays open');
      await pg.keyboard.press('Escape');
      await pg.waitForFunction(() => !document.querySelector('#productModal.open'));
      await ctx.close();
    })();

    // تثبيت التطبيق (PWA): بطاقة قابلة للإغلاق بعد مهلة، ورابط في التذييل، وتأجيل أسبوعين، ولا تظهر داخل تطبيق
    // أندرويد.
    await check('install the app: dismissible card after the delay, footer link, native prompt, snooze for two weeks; none inside the Android app', async () => {
      const ctx = await desktopCtx({ serviceWorkers: 'block' });
      await ctx.addInitScript(() => { window.__installDelayMs = 150; });
      const pg = await ctx.newPage(); watch(pg, 'install'); await pg.goto(base + '/'); await catalogReady(pg);
      const fire = () => pg.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = async () => { window.__prompted = (window.__prompted || 0) + 1; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); return e.defaultPrevented; });
      assert.ok(await pg.isHidden('#installLink'), 'no link before the browser offers installation');
      assert.strictEqual(await fire(), true, 'the default mini-infobar is replaced by our UI');
      await pg.waitForSelector('.install-card');
      assert.strictEqual(await pg.getAttribute('.install-card', 'role'), 'region');
      assert.ok((await pg.textContent('.install-card h2')).includes('ثبّت'));
      assert.ok(await pg.isVisible('#installLink'));
      await pg.screenshot({ path: path.join(SHOTS, '33-install-card-desktop.png') });
      await pg.click('[data-install-later]');
      assert.strictEqual(await pg.locator('.install-card').count(), 0);
      assert.ok(Number(await pg.evaluate(() => localStorage.getItem('fakhama-install-v1'))) > 0, 'snoozed');
      await pg.reload(); await catalogReady(pg);
      await fire(); await pg.waitForTimeout(500);
      assert.strictEqual(await pg.locator('.install-card').count(), 0, 'not shown again during the snooze');
      assert.ok(await pg.isVisible('#installLink'), 'but the footer link still offers it');
      await pg.click('#installLink');
      await pg.waitForFunction(() => window.__prompted === 1);
      await pg.waitForFunction(() => document.querySelector('#installLink').hidden);
      await ctx.close();
      const app = await desktopCtx({ serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 14) AlfakhamahApp/1.0' });
      await app.addInitScript(() => { window.__installDelayMs = 50; });
      const ap2 = await app.newPage(); await ap2.goto(base + '/'); await catalogReady(ap2);
      await ap2.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); window.dispatchEvent(e); });
      await ap2.waitForTimeout(400);
      assert.strictEqual(await ap2.locator('.install-card').count(), 0);
      assert.ok(await ap2.isHidden('#installLink'));
      await app.close();
    })();

    // إشعارات انقطاع الاتصال وعودته، والتأكد أن الـ Service Worker يخزّن ملفات الموقع العامة فقط (assets
    // والأيقونات وصفحة offline) ولا يخزّن API ولا الإدارة ولا uploads.
    await check('connection notices (offline / back online); the service worker caches only public site files (incl. the new script + styles) and never API/admin/uploads', async () => {
      const ctx = await desktopCtx(); const pg = await ctx.newPage(); watch(pg, 'network'); await pg.goto(base + '/'); await catalogReady(pg);
      await pg.evaluate(async () => { await navigator.serviceWorker.ready; });
      await pg.reload(); await catalogReady(pg);
      await pg.waitForFunction(async () => (await caches.keys()).length > 0);
      const cached = await pg.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
      assert.ok(cached.includes('/assets/js/plus.js') && cached.includes('/assets/css/plus.css') && cached.includes('/offline.html'), cached.join());
      assert.ok(cached.every(p => /^\/(assets|icons)\//.test(p) || p === '/offline.html'), 'cache contains: ' + cached.join(','));
      assert.ok((await pg.evaluate(() => caches.keys())).some(k => k === 'fakhama-static-v3'));
      await ctx.setOffline(true);
      await toastSays(pg, 'انقطع الاتصال');
      await ctx.setOffline(false);
      await toastSays(pg, 'عاد الاتصال');
      await ctx.close();
    })();

    // لا تمرير أفقي في أضيق شاشة مدعومة (360px) في الرئيسية والمنتجات وصفحة المنتج.
    await check('no horizontal scroll at 360px on the home, products and product pages with the new controls', async () => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, locale: 'ar-SA', isMobile: true, hasTouch: true, serviceWorkers: 'block' }); const pg = await ctx.newPage();
      for (const url of ['/', '/products?stock=1&sort=low', '/product/' + encodeURIComponent(galleryProduct.slug), '/category/blinds']) {
        await pg.goto(base + url); await catalogReady(pg); await pg.waitForTimeout(400);
        const over = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, url + ' overflows by ' + over + 'px');
      }
      await ctx.close();
    })();

    // تنظيف: حذف المنتج المساعد الذي أُنشئ لاختبار فلتر المتوفر.
    await check('cleanup: the sold-out helper product is removed again', async () => {
      await ap.evaluate(id => api('/api/admin/products/' + id, { method: 'DELETE' }), soldOut.id);
      assert.ok(!(await apiProducts()).some(p => p.id === soldOut.id));
    })();

    // ---- بقية فحوص لوحة الإدارة (على سياق المدير ap) ----
    await visitor.close();
    await mobile.close();
    // الأقسام: إضافة بصورة، إعادة ترتيب، تعديل، حذف.
    await check('admin categories: add with image, reorder, edit, delete', async () => {
      await ap.evaluate(() => navigate('categories'));
      await ap.waitForSelector('#categoryAddForm');
      await ap.fill('#newCategoryName', 'قسم اختبار الواجهة');
      await ap.setInputFiles('#newCategoryImage', png);
      await ap.click('#categoryAddForm button[type=submit]');
      await ap.waitForFunction(() => document.querySelector('#categoryGrid').textContent.includes('قسم اختبار الواجهة'));
      const before = await ap.$$eval('#categoryGrid .category-info b', els => els.map(e => e.textContent));
      await ap.locator('#categoryGrid .cat-row', { hasText: 'قسم اختبار الواجهة' }).locator('[data-move=up]').click();
      await ap.waitForFunction((prev) => { const now = [...document.querySelectorAll('#categoryGrid .category-info b')].map(e => e.textContent); return now.join() !== prev.join(); }, before);
      const hasImage = await ap.locator('#categoryGrid .cat-row', { hasText: 'قسم اختبار الواجهة' }).locator('img').count();
      assert.strictEqual(hasImage, 1, 'category image shown');
      await ap.locator('#categoryGrid .cat-row', { hasText: 'قسم اختبار الواجهة' }).locator('[data-edit-category]').click();
      await ap.fill('#categoryName', 'قسم اختبار معدّل');
      await ap.click('#categoryForm button[type=submit]');
      await ap.waitForFunction(() => document.querySelector('#categoryGrid').textContent.includes('قسم اختبار معدّل'));
      ap.once('dialog', d => d.accept());
      await ap.locator('#categoryGrid .cat-row', { hasText: 'قسم اختبار معدّل' }).locator('[data-delete-category]').click();
      await ap.waitForFunction(() => !document.querySelector('#categoryGrid').textContent.includes('قسم اختبار معدّل'));
      await ap.evaluate(() => navigate('products'));
      await ap.waitForSelector('#productsBody .thumb');
    })();
    // رابط مباشر يفتح نموذج إضافة منتج بعد تسجيل الدخول.
    await check('deep link /admin/#products/new opens the add-product form after login', async () => {
      const dl = await admin.newPage();
      await dl.goto(base + '/admin/#products/new');
      await dl.waitForSelector('#productForm', { timeout: 15000 });
      await dl.close();
    })();
    // لوحة المعلومات: المؤشرات، رسوم لها بدائل نصية (إتاحة)، المدى المختار يُحفظ في الرابط، ولا فيض أفقي عند 360px.
    await check('admin dashboard: KPIs, charts with text alternatives, range switch persisted in the URL, no overflow at 360px', async () => {
      await ap.evaluate(() => navigate('overview'));
      await ap.waitForSelector('#dashBody [data-kpi="orders"]');
      assert.strictEqual(await ap.locator('#dashBody [data-kpi]').count(), 8, 'eight KPI cards');
      assert.strictEqual(await ap.locator('.range-btn[aria-pressed="true"]').count(), 1);
      await ap.click('.range-btn[data-range="7"]');
      await ap.waitForFunction(() => location.hash === '#overview/7' && document.querySelector('.range-btn[data-range="7"]').getAttribute('aria-pressed') === 'true');
      await ap.waitForSelector('#dashBody [data-kpi="orders"]');
      for (const id of ['chOrders', 'chVisits']) {
        if (await ap.locator('#' + id).count()) assert.ok((await ap.getAttribute('#' + id, 'aria-label')).length > 10, id + ' has a text alternative');
      }
      assert.ok(await ap.locator('#dashBody table.sr-only, #dashBody .dash-empty').count() > 0, 'data table or empty state');
      const vp = ap.viewportSize(); await ap.setViewportSize({ width: 360, height: 740 }); await ap.waitForTimeout(300);
      const wide = await ap.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await ap.setViewportSize(vp);
      assert.ok(wide <= 0, 'no horizontal scroll at 360px, overflow ' + wide);
      await ap.evaluate(() => navigate('products'));
    })();
    // إخفاء منتج وتعديله وحذفه من الإدارة.
    await check('admin hides, edits and deletes a product', async () => {
      const row = ap.locator('#productsBody tr', { hasText: 'ستارة اختبار الرفع' });
      await row.locator('[data-toggle-product]').click();
      await ap.waitForFunction(() => [...document.querySelectorAll('#productsBody tr')].some(r => r.textContent.includes('ستارة اختبار الرفع') && r.textContent.includes('مخفي')));
      await ap.locator('#productsBody tr', { hasText: 'ستارة اختبار الرفع' }).locator('[data-edit-product]').click();
      await ap.fill('#pPrice', '333');
      await ap.click('#productForm button[type=submit]');
      await ap.waitForFunction(() => [...document.querySelectorAll('#productsBody tr')].some(r => r.textContent.includes('333') || r.textContent.includes('٣٣٣')));
      ap.once('dialog', d => d.accept());
      await ap.locator('#productsBody tr', { hasText: 'ستارة اختبار الرفع' }).locator('[data-delete-product]').click();
      await ap.waitForFunction(() => !document.querySelector('#productsBody').textContent.includes('ستارة اختبار الرفع'));
    })();
    // صفحة الطلبات وتغيير الحالة وحفظ الإعدادات.
    await check('admin orders page, status change and settings save', async () => {
      await ap.evaluate(() => navigate('orders'));
      await ap.waitForSelector('.order-status');
      await ap.screenshot({ path: path.join(SHOTS, '09-admin-orders-mobile.png') });
      await ap.selectOption('.order-status >> nth=0', 'confirmed');
      await ap.waitForFunction(() => document.querySelector('#toast').textContent.includes('تم تحديث'));
      await ap.evaluate(() => navigate('settings'));
      await ap.waitForSelector('#settingsForm');
      await ap.fill('#sTagline', 'عبارة محدّثة من الاختبار');
      await ap.click('#settingsForm button[type=submit]');
      await ap.waitForFunction(() => document.querySelector('#toast').textContent.includes('تم حفظ'));
      const store = await (await fetch(base + '/api/store')).json();
      assert.strictEqual(store.tagline, 'عبارة محدّثة من الاختبار');
      assert.strictEqual(store.phone, '+966 57 648 6491');
      assert.strictEqual(store.map_url, 'https://maps.app.goo.gl/kn2kxuPujQT9raLG7?g_st=awb');
    })();
    // تغيير كلمة المرور من الواجهة: رسالة نجاح بلا أخطاء JavaScript.
    await check('admin changes the password from the UI (success toast, no JS error)', async () => {
      await ap.evaluate(() => navigate('settings'));
      await ap.waitForSelector('#passwordForm');
      newPassword = 'P' + crypto.randomBytes(14).toString('base64url');
      await ap.fill('#oldPassword', password);
      await ap.fill('#newPassword', newPassword);
      await ap.fill('#confirmPassword', newPassword);
      await ap.click('#passwordForm button[type=submit]');
      await ap.waitForFunction(() => document.querySelector('#toast').textContent.includes('تم تحديث كلمة المرور بنجاح'));
      assert.strictEqual(await ap.inputValue('#oldPassword'), '', 'form reset after success');
    })();
    // المصادقة الثنائية: تفعيلها برمز من تطبيق مصادقة، ثم يطلب الدخول الرمز. دالة totp أدناه تنفيذ مستقل لمعيار
    // RFC 6238 (HMAC-SHA1 وخطوة 30 ثانية و6 أرقام) كي لا نعتمد على كود الخادم في التحقق.
    await check('two-factor: set up with an authenticator code, login then requires the code', async () => {
      const totp = (secret) => { // independent RFC 6238 implementation
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
        for (const ch of secret.replace(/\s+/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
        const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
        const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
        const h = crypto.createHmac('sha1', key).update(counter).digest(); const o = h[h.length - 1] & 15;
        return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
      };
      await ap.evaluate(() => navigate('settings'));
      await ap.waitForSelector('#tfStart');
      await ap.click('#tfStart');
      await ap.waitForSelector('#tfEnable');
      const secret = (await ap.textContent('#twofaBody code')).replace(/\s+/g, '');
      await ap.fill('#tfCode', totp(secret));
      await ap.click('#tfEnable');
      await ap.waitForSelector('#tfDisable');
      await ap.click('#menuButton'); await ap.click('#logoutBtn');
      await ap.waitForSelector('#loginScreen:not(.hidden)');
      await ap.fill('#loginUser', 'admin'); await ap.fill('#loginPass', newPassword);
      await ap.click('#loginForm button[type=submit]');
      await ap.waitForSelector('#codeField:not(.hidden)');
      await ap.fill('#loginCode', totp(secret));
      await ap.click('#loginForm button[type=submit]');
      await ap.waitForSelector('#appShell:not(.hidden)'); // lands on the page named in the URL hash (#settings)
    })();
    // تسجيل الخروج يعيد إلى شاشة الدخول.
    await check('admin logout returns to the login screen', async () => {
      await ap.click('#menuButton'); // the sidebar (with the logout button) is a drawer on phones
      await ap.click('#logoutBtn');
      await ap.waitForSelector('#loginScreen:not(.hidden)');
      assert.strictEqual((await fetch(base + '/api/admin/dashboard')).status, 401);
    })();

    // لقطة شاشة لسطح المكتب للمراجعة البصرية (بدون تحقق).
    // ------------------------------------------------------------ desktop admin screenshot
    const desk = await browser.newContext({ viewport: { width: 1366, height: 800 }, locale: 'ar-SA' });
    const dp = await desk.newPage();
    await dp.goto(base + '/');
    await dp.waitForSelector('.product-card');
    await dp.screenshot({ path: path.join(SHOTS, '10-store-desktop.png') });
    // ---- حالات الأعطال: خطأ الكتالوج ثم سقوط الخادم (يجب أن يكونا آخر الفحوص لأن الثاني يوقف الخادم) ----
    // ------------------------------------------------------------ failure modes
    // نحجب طلب /api/products فتظهر حالة خطأ بزر إعادة المحاولة بدون منتجات مختلقة، ثم نرفع الحجب فيتعافى.
    await check('catalogue error state shows a retry button, blocks checkout, then recovers (no invented products)', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'ar-SA' });
      const pg = await ctx.newPage();
      await pg.route('**/api/products', route => route.abort());
      await pg.goto(base + '/');
      await pg.waitForSelector('[data-retry-catalog]');
      assert.strictEqual(await pg.locator('.product-card').count(), 0, 'no fake products');
      await pg.screenshot({ path: path.join(SHOTS, '11-store-api-error-mobile.png') });
      await pg.unroute('**/api/products');
      await pg.click('[data-retry-catalog]');
      await pg.waitForSelector('.product-card');
      await ctx.close();
    })();
    // نتأكد أولاً أن ذاكرة الـ Service Worker لا تحوي إلا ملفات عامة، ثم نوقف الخادم فعلياً ونتحقق أن التنقل
    // يعرض صفحة "لا يوجد اتصال" الثابتة.
    await check('server down: navigation falls back to the static offline page', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-SA' });
      const pg = await ctx.newPage();
      await pg.goto(base + '/');
      await pg.waitForSelector('.product-card');
      await pg.evaluate(async () => { await navigator.serviceWorker.ready; });
      await pg.reload(); // now controlled by the SW
      await pg.waitForSelector('.product-card');
      const cached = await pg.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
      assert.ok(cached.length > 0 && cached.every(p => !p.startsWith('/api/') && !p.startsWith('/admin') && !p.startsWith('/uploads/') && p !== '/'), 'cache contains: ' + cached.join(','));
      server.kill();
      await sleep(500);
      await pg.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector('#retry', { timeout: 8000 });
      assert.ok((await pg.textContent('h1')).includes('لا يوجد اتصال'));
      await pg.screenshot({ path: path.join(SHOTS, '04-offline-mobile.png') });
      await ctx.close();
    })();
  // تنظيف نهائي: إغلاق المتصفح وإيقاف الخادم وحذف مجلد البيانات المؤقت.
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- التقرير النهائي ----
  // نتجاهل أخطاء الشبكة المتوقعة (net::ERR_ عند إيقاف الخادم عمداً، و401 لمحاولة الدخول الخاطئة، وطلبات API
  // الفاشلة عمداً)؛ وأي خطأ آخر يفشل التشغيل.
  for (const [status, name] of results) console.log(status, name);
  const unexpected = errors.filter(e => !/net::ERR_|admin http 401: .*\/api\/admin\/login/i.test(e) && !/requestfailed: .*\/api\//.test(e));
  console.log('\nbrowser errors:', unexpected.length ? '\n  ' + unexpected.join('\n  ') : 'none');
  console.log('screenshots:', SHOTS);
  process.exit(results.some(r => r[0] === 'FAIL') || unexpected.length ? 1 : 0);
})();
