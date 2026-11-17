# Despair Downloader

Internal desktop tool (Electron, Windows) for despair-world.com admins/sub-admins
to upload anime episode video files directly to EarnVid, Doodstream and Voe in
parallel — bypassing the CORS limitations a browser-based upload hits, since
all three hosts are called from Electron's Node main process instead of a
renderer.

## Features
- Login with your despair-world.com admin/sub-admin account (email + password).
- Anime tab: search existing works, or create a new one via AniList.
- Upload tab: single episode or a whole folder (range of episode numbers),
  with automatic "already uploaded to X — replace?" checks per host.
- Operations tab: persisted table of every upload, per-host status/progress/
  error, with a per-host retry button.
- Runs in the system tray; uploads continue after the window is closed.
- Auto-updates via GitHub Releases.

## سجل التغييرات / Changelog

### 2.8.0
- **مسار الرفع المباشر**: تاب جديد يرسم مسار الرفع (جهازك ← الاستضافات الثلاث، أو جهازك ← السيرفر ← الاستضافات). الكرات المتحركة تتبع سرعة الرفع الحقيقية وتتوقف عند التعثر؛ المسار يتحول للأحمر عند الفشل مع سبب مقروء (والتفاصيل التقنية في التلميح) وللأخضر عند النجاح مع الرابط وزر النسخ. الطابور يظهر مصغّرًا تحت الحلقة الحالية. جدول العمليات القديم صار «سجل العمليات».
- **نسب حقيقية**: مرحلتان لكل استضافة: «إرسال» (بايتات مُرسلة فعلاً) ثم «معالجة» (نسبة EarnVid الحقيقية من file/encodings، وDoodstream/VOE بلا نسبة مزيفة حتى تجهز). اختفى سقف الـ 99%.
- **عقد الرفع الميتة**: إذا تعذّر الاتصال بعقدة الرفع (ETIMEDOUT وأخواتها) أو توقف الرفع 60 ثانية يُطلب سيرفر جديد ويُعاد الإرسال تلقائيًا (حتى 6 سيرفرات) مع مهلة اتصال 20 ثانية.
- **رفع عبر سيرفر Despair** (اختياري، معطّل افتراضيًا): نسخة واحدة على أجزاء 50MB قابلة للاستئناف، والسيرفر يرفع للاستضافات ثم يحذف الملف.
- **موثوقية**: مهلة لكل طلب للموقع، إلغاء الرفع يغلق الاتصالات والملفات، حفظ سجل العمليات بتأخير بدل الكتابة كل لحظة، تجديد التوكن أثناء الرفع الطويل، ومعالجة 429 في Doodstream.

## Setup
```
npm install
npm start
```
Enter your three host API keys once in Settings — they're stored locally.

## Build / release
```
npm run build      # local .exe, no publish
npm run release     # builds and publishes to GitHub Releases (needs GH_TOKEN env var)
```
