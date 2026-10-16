/* ==========================================================
   عدّاد الكائنات - المنطق (script.js) v2
   - COCO-SSD للكشف العام (أشخاص، عربيات، كراسي...)
   - MobileNet لاستخراج "بصمة" كل منطقة، وده اللي بيخلي التعلّم ممكن
   - الأمثلة اللي بتعلّمها بتتحفظ في IndexedDB على جهازك
   ========================================================== */

/* ========================= إعداد Tailwind ========================= */
if (window.tailwind) {
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        fontFamily: { sans: ['Cairo', 'system-ui', 'sans-serif'] }
      }
    }
  };
}

/* ========================= إعدادات ========================= */
const API_URL = 'https://script.google.com/macros/s/AKfycbyA5E1yFNTMr7Ea4Ocx6Tcj3w_cppg5RiN631CebVfZvItmegx-AgbJap4JbthIzWnWkg/exec';

const MAX_SCAN_WINDOWS = 160;   // أقصى عدد مناطق في التحليل العميق
const CROP_SIZE = 224;          // حجم المدخل لـ MobileNet
const CACHE_MS = 1500;          // مدة صلاحية نتيجة التعلّم في البث الحي

// أسماء عربية للأنواع المعروفة في COCO
const AR = {
  person: 'شخص', car: 'عربية', truck: 'شاحنة', bus: 'أتوبيس', motorcycle: 'موتوسيكل',
  bicycle: 'عجلة', airplane: 'طيارة', boat: 'مركب', train: 'قطر',
  chair: 'كرسي', couch: 'كنبة', bench: 'مقعد', 'dining table': 'ترابيزة',
  bottle: 'زجاجة', cup: 'كوباية', book: 'كتاب', laptop: 'لابتوب', tv: 'شاشة',
  'potted plant': 'نبتة', backpack: 'شنطة ضهر', handbag: 'شنطة', 'cell phone': 'موبايل'
};

const PRESETS = {
  all: null,
  people: ['person'],
  vehicles: ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'airplane', 'boat', 'train'],
  seating: ['chair', 'couch', 'bench'],
  learned: 'learned'
};

/* ========================= الإعدادات المحفوظة ========================= */
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('cnt_settings') || '{}'); } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem('cnt_settings', JSON.stringify(settings)); } catch {}
}
const settings = Object.assign(
  { autoCam: false, learnSim: 0.8, preset: 'all' },
  loadSettings()
);

/* ========================= أدوات عامة ========================= */
const $ = s => document.querySelector(s);

// يهرب الرموز الخطرة قبل ما تتحط في الـ HTML
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  const color = {
    info:  'bg-stone-900 text-white',
    ok:    'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white'
  }[type];
  el.className = `fade-in mb-2 rounded-xl px-4 py-3 text-sm font-bold shadow-lg ${color}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function showBusy(text) {
  $('#busyText').textContent = text;
  $('#busy').classList.remove('hidden');
  $('#busy').classList.add('flex');
}
function setBusyText(text) {
  $('#busyText').textContent = text;
}
function hideBusy() {
  $('#busy').classList.add('hidden');
  $('#busy').classList.remove('flex');
}

function setStatus(text, type = 'idle') {
  const p = $('#statusPill');
  p.textContent = text;
  p.className = `pill pill-${type}`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

window.addEventListener('unhandledrejection', () => toast('حصل خطأ غير متوقع', 'error'));

/* ========================= الثيم ========================= */
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  try { localStorage.setItem('cnt_theme', dark ? 'dark' : 'light'); } catch {}
}
{
  let saved = null;
  try { saved = localStorage.getItem('cnt_theme'); } catch {}
  applyTheme(saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
}
$('#themeBtn').onclick = () => applyTheme(!document.documentElement.classList.contains('dark'));

/* ========================= التبويبات ========================= */
function switchTab(t) {
  document.querySelectorAll('[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === t));
  $('#view-detect').classList.toggle('hidden', t !== 'detect');
  $('#view-admin').classList.toggle('hidden', t !== 'admin');
  if (t === 'admin') renderAdmin();
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

/* ========================= الاتصال بالسيرفر ========================= */
async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      // text/plain يتفادى مشكلة CORS preflight مع Apps Script
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload })
    });
  } catch {
    throw new Error('تعذر الاتصال بالسيرفر، اتأكد من النت');
  }
  let json;
  try { json = await res.json(); } catch { throw new Error('رد غير متوقع من السيرفر'); }
  if (!json.ok) throw new Error(json.error || 'حصل خطأ');
  return json.data;
}

/* ========================= الجلسة ========================= */
const session = { token: null, username: null, role: null };

function loadSession() {
  try { Object.assign(session, JSON.parse(sessionStorage.getItem('cnt_session') || '{}')); } catch {}
  updateBadge();
}
function saveSession(d) {
  Object.assign(session, { token: d.token, username: d.username, role: d.role });
  try { sessionStorage.setItem('cnt_session', JSON.stringify(session)); } catch {}
  updateBadge();
}
function clearSession() {
  Object.assign(session, { token: null, username: null, role: null });
  try { sessionStorage.removeItem('cnt_session'); } catch {}
  updateBadge();
}
function updateBadge() {
  const b = $('#userBadge');
  if (session.token) {
    b.textContent = `${session.username} · ${session.role === 'admin' ? 'أدمن' : 'مستخدم'}`;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

// طلب محمي: لو الجلسة خلصت بنفصل المستخدم تلقائياً
function authed(action, payload = {}) {
  return api(action, { token: session.token, ...payload }).catch(err => {
    if (/الجلسة|دخول/.test(err.message)) { clearSession(); renderAdmin(); }
    throw err;
  });
}

/* ========================= قاعدة التعلّم (IndexedDB) ========================= */
// كل مثال = بصمة المنطقة + اسم النوع + صورة مصغّرة
const DB_NAME = 'cnt_learn';
const STORE = 'examples';
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}

async function dbRun(mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => res(req.result);
    tx.onerror = () => rej(tx.error);
  });
}

const learn = { examples: [] };   // { id, label, emb: Float32Array, thumb }

async function loadExamples() {
  try {
    const rows = await dbRun('readonly', s => s.getAll());
    learn.examples = rows.map(r => ({
      id: r.id, label: r.label, emb: Float32Array.from(r.emb), thumb: r.thumb
    }));
  } catch (e) {
    console.warn('IndexedDB غير متاحة', e);
    learn.examples = [];
  }
  refreshLearnUI();
}

async function addExample(label, emb, thumb) {
  const row = { id: newId(), label, emb: Array.from(emb), thumb };
  try { await dbRun('readwrite', s => s.put(row)); }
  catch (e) { console.warn('تعذر الحفظ الدائم', e); }
  learn.examples.push({ id: row.id, label, emb: Float32Array.from(emb), thumb });
  refreshLearnUI();
}

async function clearExamples() {
  try { await dbRun('readwrite', s => s.clear()); } catch {}
  learn.examples = [];
  state.learnedCache = [];
  refreshLearnUI();
}

/* ========================= MobileNet (البصمة) ========================= */
const net = { model: null };
let netPromise = null;

function loadNet() {
  if (!netPromise) {
    netPromise = (async () => {
      if (typeof mobilenet === 'undefined') throw new Error('مكتبة التعلّم ما اتحمّلتش، اتأكد من النت');
      net.model = await mobilenet.load({ version: 2, alpha: 0.5 });
      return net.model;
    })().catch(err => { netPromise = null; throw err; });
  }
  return netPromise;
}

const cropCanvas = document.createElement('canvas');
cropCanvas.width = cropCanvas.height = CROP_SIZE;
const cropCtx = cropCanvas.getContext('2d');

// تطبيع المتجه عشان نحسب التشابه (cosine) بسهولة
function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// بصمة منطقة معينة من المصدر
async function embedFrom(src, x, y, w, h) {
  await loadNet();
  cropCtx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
  cropCtx.drawImage(src, x, y, w, h, 0, 0, CROP_SIZE, CROP_SIZE);
  const t = net.model.infer(cropCanvas, true);
  const v = await t.data();
  t.dispose();
  return normalize(v);
}

// أقرب مثال متعلّم للبصمة دي
function bestMatch(emb) {
  let best = { label: null, sim: 0 };
  for (const ex of learn.examples) {
    const s = cosine(emb, ex.emb);
    if (s > best.sim) best = { label: ex.label, sim: s };
  }
  return best;
}

function clampBox(box, W, H) {
  let [x, y, w, h] = box;
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(W - x, Math.round(w)));
  h = Math.max(1, Math.min(H - y, Math.round(h)));
  return [x, y, w, h];
}

async function classifyBox(src, bbox) {
  const b = clampBox(bbox, src.width, src.height);
  const emb = await embedFrom(src, ...b);
  return bestMatch(emb);
}

// تقليل التكرار: نفس النوع + تداخل كبير = مربع واحد
function iou(a, b) {
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (aw * ah + bw * bh - inter || 1);
}
function nms(list, thr) {
  const sorted = [...list].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const p of sorted) {
    if (!keep.some(k => k.class === p.class && iou(k.bbox, p.bbox) > thr)) keep.push(p);
  }
  return keep;
}

/* ========================= محرك الكشف ========================= */
const state = {
  model: null,         // COCO-SSD
  mode: null,          // 'image' | 'video' | 'cam'
  active: false,       // لوب شغال
  running: true,       // العد شغال ولا متوقف مؤقتاً
  frozen: false,       // الصورة متجمدة (للتعليم والتحليل)
  threshold: 0.5,
  raw: [],             // آخر النتايج بعد الفلترة الأولية
  summary: null,
  stream: null,
  objectUrl: null,
  sig: '',
  relabelBusy: false,
  learnedCache: [],    // نتايج التعلّم للبث الحي {bbox,label,sim,t}
  sceneBusy: false,
  lastSceneAt: 0,
  lastDesc: ''
};

const stage = $('#stage');
const ctx = stage.getContext('2d');
const base = document.createElement('canvas');   // نسخة من الإطار الحالي
const video = $('#video');

// ----- تحميل COCO-SSD -----
let cocoPromise = null;
function loadCoco() {
  if (!cocoPromise) {
    setStatus('بنحمّل الموديل الذكي...', 'busy');
    cocoPromise = (async () => {
      if (typeof cocoSsd === 'undefined') {
        throw new Error('مكتبة الذكاء الاصطناعي ما اتحمّلتش، اتأكد من النت وحدّث الصفحة');
      }
      state.model = await cocoSsd.load();
      setStatus('الموديل جاهز', 'ok');
      return state.model;
    })().catch(err => {
      cocoPromise = null;
      setStatus('فشل تحميل الموديل', 'err');
      throw err;
    });
  }
  return cocoPromise;
}

async function ensureModel(silent = false) {
  if (state.model) return state.model;
  if (!silent) showBusy('بنحمّل الموديل الذكي لأول مرة...');
  try { return await loadCoco(); }
  finally { if (!silent) hideBusy(); }
}

function setSize(w, h) {
  base.width = stage.width = w;
  base.height = stage.height = h;
  stage.classList.remove('hidden');
  $('#placeholder').classList.add('hidden');
}

function stopSource() {
  state.active = false;
  state.mode = null;
  state.frozen = false;
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  $('#modeLabel').textContent = 'جاهز';
  $('#freezeBtn').textContent = 'تجميد الصورة';
}

function clearAll() {
  stopSource();
  state.raw = [];
  state.summary = null;
  state.learnedCache = [];
  stage.classList.add('hidden');
  $('#placeholder').classList.remove('hidden');
  updateStats([]);
}

/* ========================= التحليل الأساسي للصور ========================= */
// COCO على الصورة كاملة + تعديل التسميات من التعلّم + فحص عميق بالمناطق
async function analyzeStill() {
  const coco = await state.model.detect(base, 100, 0.05);
  let list = coco.map(p => ({ class: p.class, score: p.score, bbox: p.bbox, learned: false }));

  if (learn.examples.length) {
    try {
      await loadNet();
      list = await relabelAll(list);
      setBusyText('بنفحص الصورة بالتفصيل...');
      const scanned = await deepScan(base);
      list = nms([...list, ...scanned], 0.5);
    } catch (e) {
      console.warn(e);
      toast('التعلّم مش شغال دلوقتي، اتأكد من النت', 'error');
    }
  }

  state.raw = list;
  render();
  describeNow();
}

// تعديل تسمية كل كشف COCO حسب الأمثلة المتعلّمة
async function relabelAll(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (i >= 60) { out.push(p); continue; }
    const m = await classifyBox(base, p.bbox);
    if (m.label && m.sim >= settings.learnSim) {
      out.push({ ...p, class: m.label, score: m.sim, learned: true });
    } else {
      out.push(p);
    }
  }
  return out;
}

// فحص الصورة بنوافذ متعددة الأحجام عشان يلاقي الأشياء الصغيرة
async function deepScan(src) {
  const W = src.width, H = src.height, minSide = Math.min(W, H);
  const wins = [];
  for (const f of [0.14, 0.22]) {
    const side = Math.round(minSide * f);
    const step = Math.max(6, Math.round(side * 0.75));
    for (let y = 0; y + side <= H; y += step) {
      for (let x = 0; x + side <= W; x += step) wins.push([x, y, side, side]);
    }
  }

  // لو عدد النوافذ كبير، نخفّف عشان الموبايل ما يتعبش
  let arr = wins;
  if (arr.length > MAX_SCAN_WINDOWS) {
    const k = Math.ceil(arr.length / MAX_SCAN_WINDOWS);
    arr = arr.filter((_, i) => i % k === 0);
  }

  const found = [];
  for (let i = 0; i < arr.length; i++) {
    const bbox = arr[i];
    const m = await classifyBox(src, bbox);
    if (m.label && m.sim >= settings.learnSim) {
      found.push({ class: m.label, score: m.sim, bbox, learned: true });
    }
    if (i % 8 === 0) setBusyText(`بنفحص الصورة بالتفصيل... ${Math.round(i / arr.length * 100)}%`);
  }
  return nms(found, 0.4);
}

/* ========================= معالجة الملفات ========================= */
async function handleFile(file) {
  if (!file) return;
  const isImg = file.type.startsWith('image/');
  const isVid = file.type.startsWith('video/');

  if (!isImg && !isVid) { toast('الملف ده مش صورة ولا فيديو مدعوم', 'error'); return; }
  if (file.size > 80 * 1024 * 1024) { toast('الملف كبير أوي، الحد 80 ميجا', 'error'); return; }

  stopSource();
  state.objectUrl = URL.createObjectURL(file);

  try {
    await ensureModel();

    if (isImg) {
      showBusy('بنعدّ اللي في الصورة...');
      const img = new Image();
      img.src = state.objectUrl;
      await img.decode();
      setSize(img.naturalWidth, img.naturalHeight);
      base.getContext('2d').drawImage(img, 0, 0);
      state.mode = 'image';
      $('#modeLabel').textContent = 'صورة';
      await analyzeStill();
    } else {
      video.src = state.objectUrl;
      video.muted = true;
      await new Promise((res, rej) => {
        video.onloadeddata = res;
        video.onerror = () => rej(new Error('الفيديو مش قابل للتشغيل'));
      });
      setSize(video.videoWidth, video.videoHeight);
      await video.play();
      state.mode = 'video';
      state.active = true;
      $('#modeLabel').textContent = 'فيديو مباشر';
      loop();
    }
  } catch (err) {
    toast(err.message || 'تعذر معالجة الملف', 'error');
    stopSource();
  } finally {
    hideBusy();
  }
}

/* ========================= الكاميرا ========================= */
async function startWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('المتصفح ده مش بيدعم الكاميرا، لازم HTTPS ومتصفح حديث', 'error');
    return;
  }
  stopSource();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false
    });
  } catch (err) {
    const map = {
      NotAllowedError: 'اتقفل الإذن للكاميرا، فعّله من إعدادات المتصفح',
      NotFoundError: 'مفيش كاميرا متوصلة بالجهاز',
      NotReadableError: 'الكاميرا مشغولة في تطبيق تاني'
    };
    toast(map[err.name] || 'تعذر تشغيل الكاميرا', 'error');
    return;
  }

  try {
    await ensureModel();
    const ready = new Promise(r => (video.onloadedmetadata = r));
    video.srcObject = state.stream;
    await ready;
    await video.play().catch(() => {});
    setSize(video.videoWidth, video.videoHeight);
    state.mode = 'cam';
    state.active = true;
    $('#modeLabel').textContent = 'كاميرا مباشرة';
    loop();
  } catch (err) {
    toast(err.message || 'تعذر تشغيل الكاميرا', 'error');
    stopSource();
  } finally {
    hideBusy();
  }
}

// تطبيق نتايج التعلّم السابقة على الكشف الجديد (بالتقاطع بين المربعات)
function applyCache(list) {
  const now = performance.now();
  state.learnedCache = state.learnedCache.filter(c => now - c.t < CACHE_MS);
  for (const p of list) {
    let best = null, bestIou = 0.5;
    for (const c of state.learnedCache) {
      const i = iou(c.bbox, p.bbox);
      if (i >= bestIou) { bestIou = i; best = c; }
    }
    if (best && best.label) {
      p.class = best.label;
      p.score = best.sim;
      p.learned = true;
    }
  }
  return list;
}

// تعديل التسميات في الخلفية للبث الحي (مش بيوقف اللوب)
function scheduleRelabel() {
  if (state.relabelBusy || !learn.examples.length || !net.model) return;
  const list = state.raw.filter(p => p.score >= 0.25).slice(0, 6);
  if (!list.length) return;

  state.relabelBusy = true;
  (async () => {
    const t = performance.now();
    const results = [];
    for (const p of list) {
      const m = await classifyBox(base, p.bbox);
      results.push({
        bbox: p.bbox,
        label: m.sim >= settings.learnSim ? m.label : null,
        sim: m.sim,
        t
      });
    }
    state.learnedCache.push(...results);
  })()
    .catch(e => console.warn(e))
    .finally(() => { state.relabelBusy = false; });
}

// لوب الفيديو والكاميرا
async function loop() {
  if (!state.active) return;

  if (!state.frozen && video.readyState >= 2 && video.videoWidth) {
    base.getContext('2d').drawImage(video, 0, 0, base.width, base.height);

    if (state.running && state.model) {
      try {
        const raw = await state.model.detect(base, 50, 0.1);
        state.raw = applyCache(raw.map(p => ({ class: p.class, score: p.score, bbox: p.bbox })));
        scheduleRelabel();
      } catch (err) {
        console.warn('detect failed', err);
      }
    }

    render();

    // وصف المشهد كل 4 ثواني تقريباً
    if (net.model && Date.now() - state.lastSceneAt > 4000) {
      state.lastSceneAt = Date.now();
      updateScene();
    }
  }
  requestAnimationFrame(loop);
}

/* ========================= الفلترة والرسم ========================= */
function passesPreset(p) {
  const k = settings.preset;
  if (k === 'all') return true;
  if (k === 'learned') return !!p.learned;
  return PRESETS[k].includes(p.class);
}

// لون ثابت لكل نوع كائن
function colorFor(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 85% 55%)`;
}

// رسم الإطار + المربعات + مستطيل التعليم المؤقت
function render(drawRect) {
  if (!stage.width) return;
  ctx.drawImage(base, 0, 0);

  const list = state.raw.filter(p => p.score >= state.threshold && passesPreset(p));
  const size = Math.max(14, Math.round(stage.width / 45));
  const line = Math.max(2, Math.round(stage.width / 400));

  ctx.font = `700 ${size}px Cairo, sans-serif`;
  ctx.textBaseline = 'top';

  list.forEach(p => {
    const [x, y, w, h] = p.bbox;
    const c = colorFor(p.class);
    ctx.lineWidth = line;
    ctx.strokeStyle = c;
    ctx.strokeRect(x, y, w, h);

    const mark = p.learned ? ' ✦' : '';
    const label = `${p.class}${mark} ${Math.round(p.score * 100)}%`;
    const tw = ctx.measureText(label).width + 12;
    const ty = Math.max(0, y - size - 8);
    ctx.fillStyle = c;
    ctx.fillRect(x, ty, tw, size + 8);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 6, ty + 4);
  });

  if (drawRect) {
    const [x, y, w, h] = drawRect;
    ctx.save();
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = line * 1.5;
    ctx.strokeStyle = '#fbbf24';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  updateStats(list);
}

/* ========================= الإحصائيات والوصف ========================= */
function updateStats(list) {
  const counts = {};
  let sum = 0;
  list.forEach(p => {
    counts[p.class] = (counts[p.class] || 0) + 1;
    sum += p.score;
  });
  const total = list.length;
  const avg = total ? sum / total : 0;
  state.summary = { counts, total, avg, list };

  $('#totalCount').textContent = total;
  $('#avgConf').textContent = total ? (avg * 100).toFixed(1) + '%' : '—';
  $('#classCount').textContent = Object.keys(counts).length;

  renderDescription();

  // إعادة رسم البطاقات بس لو التفصيل اتغير (عشان الأداء)
  const sig = JSON.stringify(counts);
  if (sig === state.sig) return;
  state.sig = sig;

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $('#classCards').innerHTML = entries.length
    ? entries.map(([name, n]) => `
      <div class="fade-in rounded-2xl border border-stone-200 p-3 dark:border-stone-800">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 font-bold">
            <span class="h-3 w-3 rounded-full" style="background:${colorFor(name)}"></span>${esc(AR[name] || name)}
          </div>
          <span class="text-lg font-extrabold tabular-nums">${n}</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
          <div class="h-full rounded-full" style="width:${(n / total * 100).toFixed(0)}%;background:${colorFor(name)}"></div>
        </div>
      </div>`).join('')
    : `<p class="rounded-2xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700">مفيش حاجة متعدّة لحد دلوقتي</p>`;
}

// جملة وصف عربية بتتبني من الأرقام
function buildSentence(counts, total) {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${AR[k] || k}`);
  return `في الإطار ${total} عنصر: ${parts.join('، ')}.`;
}

function renderDescription() {
  const s = state.summary;
  let text;
  if (s && s.total) text = buildSentence(s.counts, s.total);
  else if (state.mode) text = 'مفيش حاجة متعرّفة في الإطار دلوقتي.';
  else text = 'ارفع صورة أو شغّل الكاميرا عشان أوصف المشهد.';

  if (text !== state.lastDesc) {
    state.lastDesc = text;
    $('#describeText').textContent = text;
  }
}

// وصف عام للمشهد من MobileNet (مثلاً: shoe store، street)
async function updateScene() {
  if (!net.model || state.sceneBusy || !base.width) return;
  state.sceneBusy = true;
  try {
    const r = await net.model.classify(base, 1);
    const name = r[0] ? r[0].className.split(',')[0].trim() : '';
    $('#sceneText').textContent = name ? `المشهد غالباً: ${name}` : '';
  } catch (e) {
    console.warn(e);
  } finally {
    state.sceneBusy = false;
  }
}

function describeNow() {
  renderDescription();
  updateScene();
}

// واجهة التعلّم: الأنواع المحفوظة وعددها
function refreshLearnUI() {
  const counts = {};
  learn.examples.forEach(e => { counts[e.label] = (counts[e.label] || 0) + 1; });
  const labels = Object.keys(counts);

  $('#learnTotal').textContent = learn.examples.length;
  $('#learnChips').innerHTML = labels.length
    ? labels.map(l => `<button class="chip" data-chip="${esc(l)}">${esc(l)} <b>${counts[l]}</b></button>`).join('')
    : `<p class="text-xs text-stone-500 dark:text-stone-400">لسه مفيش أمثلة متعلّمة.</p>`;
  $('#labelList').innerHTML = labels.map(l => `<option value="${esc(l)}">`).join('');
}

/* ========================= التصدير ========================= */
function exportCSV() {
  if (!state.summary || !state.summary.total) { toast('مفيش نتايج تتصدّر', 'error'); return; }
  const { counts, total, avg, list } = state.summary;

  const rows = [['label', 'count']];
  Object.entries(counts).forEach(([k, v]) => rows.push([k, v]));
  rows.push(['TOTAL', total], ['AVG_CONFIDENCE', (avg * 100).toFixed(2) + '%']);
  rows.push([]);
  rows.push(['detail_label', 'confidence', 'x', 'y', 'width', 'height', 'learned']);
  list.forEach(p => rows.push([
    p.class, (p.score * 100).toFixed(2) + '%', ...p.bbox.map(v => Math.round(v)), p.learned ? 'yes' : 'no'
  ]));

  // BOM عشان Excel يقرأ العربي صح
  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `count-${stamp()}.csv`);
  toast('الـ CSV اتصدّر', 'ok');
}

// تصدير الأمثلة المتعلّمة (بصمات + صور مصغّرة) كنسخة احتياطية
function exportLearn() {
  if (!learn.examples.length) { toast('مفيش أمثلة نصدّرها', 'error'); return; }
  const data = {
    version: 2,
    exportedAt: new Date().toISOString(),
    examples: learn.examples.map(e => ({ label: e.label, emb: Array.from(e.emb), thumb: e.thumb }))
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `learned-${stamp()}.json`);
  toast('اتصدّرت الأمثلة', 'ok');
}

async function importLearn(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.examples)) throw new Error('الملف ده مش ملف أمثلة صحيح');
    let added = 0;
    for (const e of data.examples) {
      if (!e.label || !Array.isArray(e.emb)) continue;
      await addExample(e.label, Float32Array.from(e.emb), e.thumb || '');
      added++;
    }
    toast(`اتضاف ${added} مثال ✓`, 'ok');
  } catch (err) {
    toast(err.message || 'تعذر استيراد الملف', 'error');
  }
}

function screenshot() {
  if (!stage.width) { toast('ارفع صورة أو شغّل الكاميرا الأول', 'error'); return; }
  const { counts, total, avg } = state.summary || { counts: {}, total: 0, avg: 0 };

  const bar = Math.max(90, Math.round(stage.width * 0.09));
  const out = document.createElement('canvas');
  out.width = stage.width;
  out.height = stage.height + bar;
  const o = out.getContext('2d');

  o.drawImage(stage, 0, 0);
  o.fillStyle = '#1c1917';
  o.fillRect(0, stage.height, out.width, bar);

  o.fillStyle = '#ffffff';
  o.font = `800 ${Math.round(bar * 0.28)}px Cairo, sans-serif`;
  o.textBaseline = 'middle';
  o.fillText(`الإجمالي: ${total}   •   متوسط الثقة: ${total ? (avg * 100).toFixed(1) + '%' : '—'}`,
    bar * 0.3, stage.height + bar * 0.35);

  o.font = `600 ${Math.round(bar * 0.2)}px Cairo, sans-serif`;
  o.fillStyle = '#d6d3d1';
  const line = Object.entries(counts).map(([k, v]) => `${AR[k] || k}: ${v}`).join('   ·   ') || 'لا توجد كائنات';
  o.fillText(line, bar * 0.3, stage.height + bar * 0.72);

  out.toBlob(b => download(b, `screenshot-${stamp()}.png`), 'image/png');
  toast('اتحفظت اللقطة', 'ok');
}

// حفظ النتايج في جوجل شيت
async function saveToCloud() {
  if (!session.token) {
    toast('سجّل دخول من لوحة الإدارة الأول', 'error');
    switchTab('admin');
    return;
  }
  if (!state.summary || !state.summary.total) { toast('مفيش نتايج تتحفظ', 'error'); return; }

  const { total, avg, list, counts } = state.summary;
  const source = state.mode === 'cam' ? 'webcam' : state.mode === 'image' ? 'image' : 'video';
  const btn = $('#saveBtn');
  btn.disabled = true;

  try {
    await authed('saveRecord', {
      record: {
        source,
        totalCount: total,
        avgConfidence: +avg.toFixed(4),
        notes: Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' | ')
      },
      detections: list.map(p => ({
        label: p.class,
        confidence: +p.score.toFixed(4),
        x: Math.round(p.bbox[0]), y: Math.round(p.bbox[1]),
        w: Math.round(p.bbox[2]), h: Math.round(p.bbox[3])
      }))
    });
    toast('اتحفظ في جوجل شيت ✓', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ========================= التعليم بالسحب ========================= */
const teach = { on: false, drawing: false, start: null, rect: null };

function toCanvasPoint(e) {
  const r = stage.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * stage.width / r.width,
    y: (e.clientY - r.top) * stage.height / r.height
  };
}
function rectFrom(a, b) {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
}
function makeThumb(bbox) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  c.getContext('2d').drawImage(base, bbox[0], bbox[1], bbox[2], bbox[3], 0, 0, 96, 96);
  return c.toDataURL('image/jpeg', 0.7);
}

// حفظ منطقة كمثال لنوع معين
async function teachRegion(rect) {
  const label = $('#labelInput').value.trim();
  if (!label) { toast('اكتب اسم النوع الأول', 'error'); return; }

  const bbox = clampBox(rect, base.width, base.height);
  try {
    await loadNet();
    const emb = await embedFrom(base, ...bbox);
    await addExample(label, emb, makeThumb(bbox));
    toast(`اتعلّمت "${label}" ✓`, 'ok');
  } catch (err) {
    toast('تعذر حفظ المثال: ' + err.message, 'error');
  }
}

stage.addEventListener('pointerdown', e => {
  if (!teach.on || !stage.width) return;
  teach.drawing = true;
  teach.start = toCanvasPoint(e);
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', e => {
  if (!teach.drawing) return;
  teach.rect = rectFrom(teach.start, toCanvasPoint(e));
  render(teach.rect);
});
stage.addEventListener('pointerup', async e => {
  if (!teach.drawing) return;
  teach.drawing = false;
  const r = teach.rect;
  teach.rect = null;
  render();
  if (!r || r[2] < 12 || r[3] < 12) return;
  await teachRegion(r);
});

/* ========================= لوحة الأدمن ========================= */
const admin = { sheet: null, headers: [], rows: [] };
let editing = null;

function renderAdmin() {
  const logged = !!session.token;
  $('#loginCard').classList.toggle('hidden', logged);
  $('#adminArea').classList.toggle('hidden', !logged || session.role !== 'admin');
  $('#notAdmin').classList.toggle('hidden', !logged || session.role === 'admin');
  if (logged) $('#adminName').textContent = `${session.username} (${session.role === 'admin' ? 'أدمن' : 'مستخدم'})`;
  if (logged && session.role === 'admin') {
    loadSheets();
    loadUsers();
  }
}

async function loadSheets() {
  try {
    const sheets = await authed('listSheets');
    $('#sheetSelect').innerHTML = sheets.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    if (!admin.sheet || !sheets.some(s => s.name === admin.sheet)) admin.sheet = sheets[0]?.name || null;
    $('#sheetSelect').value = admin.sheet;
    await loadRows();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadRows() {
  if (!admin.sheet) return;
  $('#tableWrap').classList.add('opacity-50');
  try {
    const d = await authed('listRows', { sheet: admin.sheet });
    admin.headers = d.headers;
    admin.rows = d.rows;
    renderTable();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('#tableWrap').classList.remove('opacity-50');
  }
}

function renderTable() {
  const h = admin.headers;
  $('#tableHead').innerHTML =
    h.map(c => `<th class="whitespace-nowrap px-3 py-2 text-start text-xs font-extrabold uppercase tracking-wide text-stone-500">${esc(c)}</th>`).join('') +
    `<th class="px-3 py-2 text-start text-xs font-extrabold text-stone-500">إجراءات</th>`;

  $('#tableBody').innerHTML = admin.rows.length
    ? admin.rows.map(r => `
      <tr class="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-800/40">
        ${h.map(c => `<td class="max-w-[220px] truncate px-3 py-2 text-sm">${esc(r[c])}</td>`).join('')}
        <td class="whitespace-nowrap px-3 py-2">
          <div class="flex gap-2">
            <button class="btn btn-sky btn-sm" data-edit="${r._row}">تعديل</button>
            <button class="btn btn-rose btn-sm" data-del="${r._row}">حذف</button>
          </div>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="${h.length + 1}" class="p-8 text-center text-stone-500">الشيت فاضي</td></tr>`;

  $('#rowCount').textContent = admin.rows.length;
}

function openEditor(rowIndex) {
  editing = rowIndex ?? null;
  const row = editing ? admin.rows.find(r => r._row === editing) || {} : {};
  $('#editorTitle').textContent = editing ? `تعديل صف #${editing}` : `صف جديد في ${admin.sheet}`;

  $('#editorFields').innerHTML = admin.headers.map(h => {
    let val = editing ? (row[h] ?? '') : '';
    if (!editing && h === 'id') val = newId();
    if (!editing && h === 'createdAt') val = new Date().toISOString();
    const ro = editing && h === 'id' ? 'readonly' : '';
    return `
      <label class="block">
        <span class="mb-1 block text-xs font-bold text-stone-500">${esc(h)}</span>
        <input name="${esc(h)}" value="${esc(val)}" ${ro} class="field">
      </label>`;
  }).join('');

  $('#editor').classList.remove('hidden');
  $('#editor').classList.add('flex');
}

function closeEditor() {
  $('#editor').classList.add('hidden');
  $('#editor').classList.remove('flex');
}

async function deleteRow(rowIndex) {
  if (!confirm('متأكد إنك عايز تحذف الصف ده؟ الحذف مش هيرجع.')) return;
  try {
    await authed('deleteRow', { sheet: admin.sheet, rowIndex });
    toast('اتحذف', 'ok');
    await loadRows();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadUsers() {
  try {
    const users = await authed('listUsers');
    $('#usersBody').innerHTML = users.map(u => `
      <tr class="border-t border-stone-100 dark:border-stone-800">
        <td class="px-3 py-2 font-bold">${esc(u.username)}</td>
        <td class="px-3 py-2">
          <select data-role="${esc(u.id)}" class="field" style="width:auto;padding:.35rem .6rem">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>مستخدم</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>أدمن</option>
          </select>
        </td>
        <td class="px-3 py-2 text-xs text-stone-500">${esc(String(u.createdAt).slice(0, 10))}</td>
        <td class="px-3 py-2">
          <button class="btn btn-rose btn-sm" data-deluser="${esc(u.id)}" ${u.username === session.username ? 'disabled' : ''}>حذف</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="4" class="p-6 text-center text-stone-500">مفيش مستخدمين</td></tr>`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ========================= ربط الأحداث ========================= */

// ----- الكشف -----
$('#fileBtn').onclick = () => $('#fileInput').click();
$('#camPhotoBtn').onclick = () => $('#camInput').click();
$('#camBtn').onclick = () => startWebcam();
$('#fileInput').onchange = e => { handleFile(e.target.files[0]); e.target.value = ''; };
$('#camInput').onchange = e => { handleFile(e.target.files[0]); e.target.value = ''; };
$('#clearBtn').onclick = clearAll;
$('#snapBtn').onclick = screenshot;
$('#csvBtn').onclick = exportCSV;
$('#saveBtn').onclick = saveToCloud;

$('#freezeBtn').onclick = () => {
  if (!state.active) { toast('مفيش بث شغال لتجميده', 'error'); return; }
  state.frozen = !state.frozen;
  $('#freezeBtn').textContent = state.frozen ? 'استئناف البث' : 'تجميد الصورة';
  render();
};

// تحليل عميق: بيجمّد الإطار الحالي ويفحصه بالتفصيل
$('#deepBtn').onclick = async () => {
  if (!base.width) { toast('ارفع صورة أو شغّل الكاميرا الأول', 'error'); return; }
  if (state.active && !state.frozen) {
    state.frozen = true;
    $('#freezeBtn').textContent = 'استئناف البث';
  }
  if (!learn.examples.length) toast('علّم الموديل أول نوع عشان التحليل العميق يفرق', 'info');

  showBusy('بنحلل الصورة بالتفصيل...');
  try {
    await ensureModel(true);
    await analyzeStill();
    toast('التحليل خلص ✓', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideBusy();
  }
};

$('#pauseBtn').onclick = () => {
  state.running = !state.running;
  $('#pauseBtn').textContent = state.running ? 'إيقاف العد المؤقت' : 'استئناف العد';
  toast(state.running ? 'العد شغال' : 'العد متوقف مؤقتاً');
};

$('#threshold').oninput = e => {
  state.threshold = e.target.value / 100;
  $('#thresholdVal').textContent = e.target.value + '%';
  render();
};

// الفلاتر
function refreshPresetUI() {
  document.querySelectorAll('[data-preset]').forEach(b =>
    b.classList.toggle('active', b.dataset.preset === settings.preset));
}
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
  settings.preset = b.dataset.preset;
  saveSettings();
  refreshPresetUI();
  render();
});

// التشغيل التلقائي للكاميرا
$('#autoCam').checked = !!settings.autoCam;
$('#autoCam').onchange = e => {
  settings.autoCam = e.target.checked;
  saveSettings();
};

// ----- التعليم -----
$('#teachBtn').onclick = () => {
  if (!teach.on) {
    if (!base.width) { toast('ارفع صورة أو شغّل الكاميرا الأول', 'error'); return; }
    if (!$('#labelInput').value.trim()) {
      toast('اكتب اسم النوع الأول', 'error');
      $('#labelInput').focus();
      return;
    }
    teach.on = true;
    if (state.active) {
      state.frozen = true;
      $('#freezeBtn').textContent = 'استئناف البث';
    }
    loadNet().catch(() => toast('مكتبة التعلّم ما اتحمّلتش', 'error'));
  } else {
    teach.on = false;
    if (state.active) {
      state.frozen = false;
      $('#freezeBtn').textContent = 'تجميد الصورة';
    }
  }
  $('#teachBtn').textContent = teach.on ? 'إنهاء التعليم' : 'تعليم منطقة';
  $('#teachHint').classList.toggle('hidden', !teach.on);
  stage.classList.toggle('teach-on', teach.on);
  render();
};

$('#learnChips').onclick = e => {
  const b = e.target.closest('[data-chip]');
  if (!b) return;
  $('#labelInput').value = b.dataset.chip;
  settings.preset = 'learned';
  saveSettings();
  refreshPresetUI();
  render();
};

$('#learnSim').value = Math.round(settings.learnSim * 100);
$('#learnSimVal').textContent = $('#learnSim').value + '%';
$('#learnSim').oninput = e => {
  settings.learnSim = e.target.value / 100;
  $('#learnSimVal').textContent = e.target.value + '%';
  state.learnedCache = [];
  saveSettings();
};

$('#exportLearnBtn').onclick = exportLearn;
$('#importLearnBtn').onclick = () => $('#importLearnInput').click();
$('#importLearnInput').onchange = e => { importLearn(e.target.files[0]); e.target.value = ''; };
$('#clearLearnBtn').onclick = async () => {
  if (!learn.examples.length) { toast('مفيش تعلّم محفوظ أصلاً'); return; }
  if (!confirm('متأكد إنك عايز تمسح كل اللي اتعلّمه الموديل؟ الحذف مش هيرجع.')) return;
  await clearExamples();
  toast('اتمسح كل التعلّم', 'ok');
};

// سحب وإفلات الملفات
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault();
  dz.classList.add('drop-active');
}));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault();
  dz.classList.remove('drop-active');
}));
dz.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));

// ----- الأدمن -----
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const d = await api('login', { username: f.get('username'), password: f.get('password') });
    saveSession(d);
    e.target.reset();
    toast(`أهلاً ${d.username}`, 'ok');
    renderAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
};

$('#logoutBtn').onclick = async () => {
  try { await api('logout', { token: session.token }); } catch {}
  clearSession();
  toast('خرجت من حسابك');
  renderAdmin();
};

$('#refreshBtn').onclick = () => renderAdmin();

$('#sheetSelect').onchange = e => {
  admin.sheet = e.target.value;
  loadRows();
};

$('#addRowBtn').onclick = () => openEditor(null);

$('#tableBody').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.edit) openEditor(Number(b.dataset.edit));
  if (b.dataset.del) deleteRow(Number(b.dataset.del));
};

$('#editorClose').onclick = closeEditor;
$('#editorCancel').onclick = closeEditor;
$('#editor').onclick = e => { if (e.target.id === 'editor') closeEditor(); };

$('#editorForm').onsubmit = async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const btn = $('#editorSave');
  btn.disabled = true;
  try {
    if (editing) await authed('updateRow', { sheet: admin.sheet, rowIndex: editing, data });
    else await authed('addRow', { sheet: admin.sheet, data });
    closeEditor();
    toast('اتحفظ ✓', 'ok');
    await loadRows();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

$('#usersBody').onchange = async e => {
  if (!e.target.dataset.role) return;
  try {
    await authed('setUserRole', { id: e.target.dataset.role, role: e.target.value });
    toast('الصلاحية اتغيّرت', 'ok');
  } catch (err) {
    toast(err.message, 'error');
    loadUsers();
  }
};

$('#usersBody').onclick = async e => {
  const b = e.target.closest('button[data-deluser]');
  if (!b || !confirm('تحذف المستخدم ده؟')) return;
  try {
    await authed('deleteUser', { id: b.dataset.deluser });
    toast('اتحذف المستخدم', 'ok');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

$('#userForm').onsubmit = async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    await authed('createUser', data);
    e.target.reset();
    toast('المستخدم اتضاف', 'ok');
    loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
};

/* ========================= البداية ========================= */
function boot() {
  loadSession();
  refreshPresetUI();
  loadExamples();

  // تحميل الموديلات في الخلفية عشان تكون جاهزة وقت الاستخدام
  loadCoco().catch(() => {});
  loadNet().catch(() => {});

  if (settings.autoCam) startWebcam();
}
boot();
