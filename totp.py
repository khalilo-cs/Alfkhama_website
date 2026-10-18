# ------------------------------------------------------------------------------------------------------------------
# totp.py: المصادقة الثنائية (2FA) لحساب مدير المتجر برموز مؤقتة من ستة أرقام تتغير كل 30 ثانية.
# يستخدمه app.py في عدة أماكن: تفعيل 2FA (توليد سر + رابط otpauth لرمز QR)، وتأكيد الرمز عند التفعيل،
# والتحقق من الرمز أثناء تسجيل الدخول. السر يُخزَّن مع حساب المدير في قاعدة البيانات، ولا يُكتب في الشيفرة.
# المبدأ: يتشارك الخادم وتطبيق المصادقة السر نفسه، وكل منهما يحسب الرمز من (السر + الوقت الحالي) فيتطابقان.
# ------------------------------------------------------------------------------------------------------------------
"""RFC 6238 time-based one-time passwords (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).
Standard library only."""
# ---- الاستيرادات (مكتبة بايثون القياسية فقط) ----
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

# ---- الثوابت: عمر الرمز بالثواني وعدد أرقامه (القيم التي تفترضها تطبيقات المصادقة افتراضيًا) ----
STEP = 30
DIGITS = 6


# سر عشوائي جديد من مولّد آمن للأسرار (secrets) وليس random؛ يُرمَّز base32 لأن تطبيقات المصادقة تتوقع ذلك.
def new_secret() -> str:
    """160-bit random secret, base32 without padding (what authenticator apps expect)."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


# خوارزمية HOTP (RFC 4226): HMAC-SHA1 على عدّاد من 8 بايت، ثم «الاقتطاع الديناميكي»:
# آخر 4 بِتّات من الناتج تحدد موضع 4 بايت نأخذها، ونمسح أعلى بِتّ، ونأخذ باقي القسمة على 10^6.
# الحشو بعلامات = يعيد الطول إلى مضاعف 8 كما يتطلب b32decode بعد أن حذفناه عند التوليد.
def _hotp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** DIGITS)
    return f"{code:0{DIGITS}d}"


# رمز الوقت المعيّن (الافتراضي الآن): العدّاد = عدد فترات الـ30 ثانية منذ 1970. تُستخدم للاختبارات.
def code_at(secret: str, at: float | None = None) -> str:
    return _hotp(secret, int((time.time() if at is None else at) // STEP))


# التحقق من الرمز الذي كتبه المستخدم. نقبل الفترة الحالية وفترة قبلها وبعدها لتعويض اختلاف ساعة الهاتف عن الخادم.
# ملاحظة: هذه الدالة لا تمنع إعادة استخدام الرمز نفسه ولا تحدّ المحاولات؛ ذلك مسؤولية المستدعي (app.py).
def verify(secret: str, code: str, at: float | None = None, window: int = 1) -> bool:
    """Accepts the current code and `window` steps either side (clock drift). Constant-time comparison."""
    # نترك الأرقام فقط حتى لا يفشل الرمز بسبب مسافة كتبها المستخدم (مثل «123 456»).
    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(code) != DIGITS or not secret:
        return False
    counter = int((time.time() if at is None else at) // STEP)
    ok = False
    # نفحص كل الفترات دائمًا دون خروج مبكر، والمقارنة compare_digest، حتى لا يتسرب شيء من زمن التنفيذ.
    for delta in range(-window, window + 1):
        ok |= hmac.compare_digest(_hotp(secret, counter + delta), code)
    return ok


# رابط otpauth:// الذي يحوّله تطبيق المصادقة (عبر QR أو الإدخال) إلى حساب جديد؛ الاسم والمُصدر يُرمَّزان بـ quote.
def otpauth_uri(secret: str, account: str, issuer: str) -> str:
    return f"otpauth://totp/{quote(issuer)}:{quote(account)}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits={DIGITS}&period={STEP}"
