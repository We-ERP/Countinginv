/* ==========================================================
   عدّاد الكائنات - المنطق (script.js)
   ========================================================== */

/* ========================= إعداد Tailwind ========================= */
// يتنفذ بعد تحميل CDN الخاص بـ Tailwind (السكربت متحمل في head)
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

/* ========================= أدوات عامة ========================= */
const $ = s => document.querySelector(s);

// يهرب الرموز الخطرة قبل ما تتحط في الـ HTML
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// إشعارات منبثقة
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

// شاشة التحميل فوق منطقة العرض
function showBusy(text) {
  $('#busyText').textContent = text;
  $('#busy').classList.remove('hidden');
  $('#busy').classList.add('flex');
}
function hideBusy() {
  $('#busy').classList.add('hidden');
  $('#busy').classList.remove('flex');
}

// تنزيل ملف من المتصفح
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// أي خطأ غير متوقع يظهر كإشعار بدل ما يوقف الصفحة بصمت
window.addEventListener('unhandledrejection', () => toast('حصل خطأ غير متوقع', 'error'));

/* ========================= الثيم (ليل / نهار) ========================= */
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

/* ========================= محرك الكشف ========================= */
const state = {
  model: null,
  mode: null,          // 'image' | 'video' | 'cam'
  active: false,       // هل فيه لوب شغال
  running: true,       // العد شغال ولا متوقف مؤقتاً
  threshold: 0.5,
  raw: [],             // آخر نتايج الموديل بدون فلترة
  summary: null,
  stream: null,
  objectUrl: null,
  sig: ''
};

const stage = $('#stage');
const ctx = stage.getContext('2d');
const base = document.createElement('canvas');   // نسخة من الإطار الحالي
const video = $('#video');

// تحميل الموديل مرة واحدة فقط
async function ensureModel() {
  if (state.model) return state.model;
  if (typeof cocoSsd === 'undefined') {
    throw new Error('مكتبة الذكاء الاصطناعي ما اتحمّلتش، اتأكد من النت وحدّث الصفحة');
  }
  showBusy('بنحمّل الموديل الذكي لأول مرة...');
  try {
    state.model = await cocoSsd.load();
    return state.model;
  } finally {
    hideBusy();
  }
}

function setSize(w, h) {
  base.width = stage.width = w;
  base.height = stage.height = h;
  stage.classList.remove('hidden');
  $('#placeholder').classList.add('hidden');
}

// إيقاف أي مصدر شغال (كاميرا أو فيديو أو صورة)
function stopSource() {
  state.active = false;
  state.mode = null;
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
}

function clearAll() {
  stopSource();
  state.raw = [];
  state.summary = null;
  stage.classList.add('hidden');
  $('#placeholder').classList.remove('hidden');
  updateStats([]);
}

// معالجة صورة أو فيديو مرفوع
async function handleFile(file) {
  if (!file) return;
  const isImg = file.type.startsWith('image/');
  const isVid = file.type.startsWith('video/');

  if (!isImg && !isVid) { toast('الملف ده مش صورة ولا فيديو مدعوم', 'error'); return; }
  if (file.size > 80 * 1024 * 1024) { toast('الملف كبير أوي، الحد 80 ميجا', 'error'); return; }

  stopSource();
  state.objectUrl = URL.createObjectURL(file);

  try {
    if (isImg) {
      await ensureModel();
      showBusy('بنعدّ اللي في الصورة...');
      const img = new Image();
      img.src = state.objectUrl;
      await img.decode();
      setSize(img.naturalWidth, img.naturalHeight);
      base.getContext('2d').drawImage(img, 0, 0);
      state.mode = 'image';
      state.raw = await state.model.detect(base, 100, 0.05);
      render();
    } else {
      await ensureModel();
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
      loop();
    }
  } catch (err) {
    toast(err.message || 'تعذر معالجة الملف', 'error');
    stopSource();
  } finally {
    hideBusy();
  }
}

// تشغيل كاميرا الموبايل أو اللابتوب
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
    loop();
  } catch (err) {
    toast(err.message || 'تعذر تشغيل الكاميرا', 'error');
    stopSource();
  } finally {
    hideBusy();
  }
}

// لوب الفيديو والكاميرا
async function loop() {
  if (!state.active) return;
  if (video.readyState >= 2 && video.videoWidth) {
    base.getContext('2d').drawImage(video, 0, 0, base.width, base.height);
    if (state.running) {
      try {
        state.raw = await state.model.detect(base, 50, 0.1);
      } catch (err) {
        console.warn('detect failed', err);
      }
    }
    render();
  }
  requestAnimationFrame(loop);
}

// لون ثابت لكل نوع كائن
function colorFor(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 85% 55%)`;
}

// رسم الإطار + المربعات + تحديث الإحصائيات
function render() {
  if (!stage.width) return;
  ctx.drawImage(base, 0, 0);

  const list = state.raw.filter(p => p.score >= state.threshold);
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

    const label = `${p.class} ${Math.round(p.score * 100)}%`;
    const tw = ctx.measureText(label).width + 12;
    const ty = Math.max(0, y - size - 8);
    ctx.fillStyle = c;
    ctx.fillRect(x, ty, tw, size + 8);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 6, ty + 4);
  });

  updateStats(list);
}

// تحديث العداد والبطاقات
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
            <span class="h-3 w-3 rounded-full" style="background:${colorFor(name)}"></span>${esc(name)}
          </div>
          <span class="text-lg font-extrabold tabular-nums">${n}</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
          <div class="h-full rounded-full" style="width:${(n / total * 100).toFixed(0)}%;background:${colorFor(name)}"></div>
        </div>
      </div>`).join('')
    : `<p class="rounded-2xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700">مفيش حاجة متعدّة لحد دلوقتي</p>`;
}

/* ========================= التصدير ========================= */
function exportCSV() {
  if (!state.summary || !state.summary.total) { toast('مفيش نتايج تتصدّر', 'error'); return; }
  const { counts, total, avg, list } = state.summary;

  const rows = [['label', 'count']];
  Object.entries(counts).forEach(([k, v]) => rows.push([k, v]));
  rows.push(['TOTAL', total], ['AVG_CONFIDENCE', (avg * 100).toFixed(2) + '%']);
  rows.push([]);
  rows.push(['detail_label', 'confidence', 'x', 'y', 'width', 'height']);
  list.forEach(p => rows.push([p.class, (p.score * 100).toFixed(2) + '%', ...p.bbox.map(v => Math.round(v))]));

  // BOM عشان Excel يقرأ العربي صح
  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `count-${stamp()}.csv`);
  toast('الـ CSV اتصدّر', 'ok');
}

// لقطة شاشة بالصورة + شريط الملخص
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
  const line = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   ·   ') || 'لا توجد كائنات';
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
loadSession();
