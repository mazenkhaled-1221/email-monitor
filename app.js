// 4M Email Monitor — نسخة متعددة الحسابات (HTML/CSS/JS فقط، بدون سيرفر)
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
const POLL_MS = 30000;
const KEY = '4m_email_monitor_v2';
const $ = s => document.querySelector(s);

// ---------- التخزين ----------
const emptyDb = () => ({ v: 3, companies: [], messages: [], accounts: [], cache: {}, nextId: 1,
  settings: { clientId: '', reportEmail: '', lastReport: '', sound: true } });
let db = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) { const e = emptyDb(); const o = { ...e, ...d, settings: { ...e.settings, ...d.settings } };
      if (d.v !== 3) { o.cache = {}; o.v = 3; } return o; }
  } catch (e) {}
  return emptyDb();
}
function save() { localStorage.setItem(KEY, JSON.stringify(db)); }

// ---------- أدوات ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = ms => { const d = new Date(ms); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const extractEmail = from => { const m = String(from).match(/<([^>]+)>/); return (m ? m[1] : String(from)).trim().toLowerCase(); };
const b64 = s => { let x = ''; new TextEncoder().encode(s).forEach(c => x += String.fromCharCode(c)); return btoa(x); };
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const companyName = id => (db.companies.find(c => c.id === id) || {}).name || '—';
// ضع الـ Client ID هنا مرة واحدة (بين علامتي التنصيص). لو تركته فارغًا ستظهر خانة له في الصفحة.
const CLIENT_ID = '';
const cid = () => CLIENT_ID || db.settings.clientId;
const validId = s => /^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(s);

function toast(text) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 9000);
}

// ---------- الصوت والتنبيهات ----------
let ac = null;
function unlockAudio() {
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {}
}
document.addEventListener('click', unlockAudio);
function beep(force) {
  if ((!db.settings.sound && !force) || !ac) return;
  [0, 0.28, 0.56].forEach(t => {
    const o = ac.createOscillator(), g = ac.createGain(), s = ac.currentTime + t;
    o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.22); o.start(s); o.stop(s + 0.25);
  });
}
const baseTitle = document.title; let unseen = 0;
function flashTitle(n) { unseen += n; document.title = `(${unseen}) رسالة جديدة — 4M`; }
function clearFlash() { unseen = 0; document.title = baseTitle; }
window.addEventListener('focus', clearFlash);
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearFlash(); });
function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  else toast(title + ' — ' + body);
}

// ---------- الربط مع Google (عدة حسابات) ----------
const tokens = {}; // email -> {t, exp}
const live = email => !!tokens[email] && Date.now() < tokens[email].exp;
let tokenClient = null, pending = [], polling = false, lastSilent = 0;

function initAuth() {
  if (!window.google || !google.accounts || !cid()) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid(),
    scope: SCOPES,
    callback: async r => {
      if (r.error) { toast('تعذر الربط: ' + r.error); render(); return next(); }
      try {
        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + r.access_token } });
        const email = ((await res.json()).emailAddress || '').toLowerCase();
        if (!email) throw 0;
        tokens[email] = { t: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 };
        if (!db.accounts.some(a => a.email === email)) db.accounts.push({ email });
        save(); render(); poll();
      } catch (e) { toast('تعذر قراءة الحساب بعد الربط.'); }
      next();
    },
    error_callback: () => { render(); next(); }
  });
  return true;
}
function request(email, prompt) {
  if (!tokenClient && !initAuth()) { toast('تعذر تحميل مكتبة Google أو لم يُحفظ Client ID.'); return; }
  const o = { prompt }; if (email) o.login_hint = email;
  tokenClient.requestAccessToken(o);
}
function next() { const e = pending.shift(); if (e) request(e, 'none'); }
function reconnectSilently() {
  if (pending.length || Date.now() - lastSilent < 300000) return;
  lastSilent = Date.now();
  pending = db.accounts.map(a => a.email).filter(e => !live(e)); next();
}

async function gmail(email, path, opt = {}) {
  const k = tokens[email]; if (!k) throw new Error('الحساب غير متصل');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    ...opt, headers: { Authorization: 'Bearer ' + k.t, 'Content-Type': 'application/json' } });
  if (r.status === 401) { delete tokens[email]; render(); throw new Error('انتهت الجلسة'); }
  if (!r.ok) throw new Error('Gmail error ' + r.status);
  return r.json();
}

// ---------- المزامنة ----------
async function pollAccount(acc, map) {
  const cache = db.cache[acc] = db.cache[acc] || {};
  const list = await gmail(acc, 'messages?q=' + encodeURIComponent('in:inbox newer_than:7d') + '&maxResults=500');
  const ids = (list.messages || []).map(m => m.id), idSet = new Set(ids);
  const missing = ids.filter(id => !cache[id]);
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(missing.slice(i, i + 5).map(async id => {
      const m = await gmail(acc, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const h = n => ((m.payload?.headers || []).find(x => x.name.toLowerCase() === n) || {}).value || '';
      cache[id] = { from: h('from'), subject: h('subject'), ms: +m.internalDate || Date.now(), snippet: m.snippet || '' };
    }));
  }
  Object.keys(cache).forEach(id => { if (!idSet.has(id)) delete cache[id]; });
  const known = new Set(db.messages.map(m => m.id)), out = [];
  for (const [id, m] of Object.entries(cache)) {
    const cid = map[extractEmail(m.from)], key = acc + ':' + id;
    if (!cid || known.has(key)) continue;
    out.push({ id: key, acc, companyId: cid, sender: m.from, subject: m.subject, ms: m.ms, snippet: m.snippet,
      url: `https://mail.google.com/mail/u/${encodeURIComponent(acc)}/#all/${id}`, reviewed: false });
  }
  return out;
}

async function poll(manual) {
  if (polling) return;
  render();
  const accs = db.accounts.map(a => a.email);
  if (accs.some(e => !live(e))) reconnectSilently();
  const liveAccs = accs.filter(live);
  if (!liveAccs.length) { if (manual) toast('اربط حساب Gmail أولاً.'); return; }
  if (!db.companies.some(c => c.active)) { if (manual) toast('لا توجد عناوين مفعّلة للمراقبة.'); return; }
  polling = true; $('#btnSync').disabled = true;
  const map = {}; db.companies.filter(c => c.active).forEach(c => map[c.email.toLowerCase()] = c.id);
  const fresh = [];
  for (const acc of liveAccs) {
    try { fresh.push(...await pollAccount(acc, map)); }
    catch (e) { if (manual) toast(acc + ': ' + e.message); }
  }
  fresh.sort((a, b) => a.ms - b.ms).forEach(m => db.messages.unshift(m));
  save(); render();
  if (fresh.length) {
    fresh.forEach(m => notify('رسالة من ' + companyName(m.companyId), m.subject || 'رسالة جديدة'));
    beep(); if (document.hidden || !document.hasFocus()) flashTitle(fresh.length);
  }
  if (manual) toast('المزامنة تمت؛ الرسائل الجديدة: ' + fresh.length);
  try { await dailyReport(); } catch (e) {}
  polling = false; $('#btnSync').disabled = false;
}

// ---------- التقرير اليومي ----------
async function dailyReport() {
  const now = new Date(), today = ymd(now), to = db.settings.reportEmail;
  if (!to || db.settings.lastReport === today || now.getHours() < 17) return;
  const from = db.accounts.map(a => a.email).find(live); if (!from) return;
  const rows = db.messages.filter(m => ymd(new Date(m.ms)) === today);
  const lines = ['تقرير متابعة البريد اليومي - ' + today, '',
    ...rows.map(m => `${companyName(m.companyId)} | ${m.sender} | ${m.subject} | ${fmt(m.ms)} | ${m.acc || ''}`)];
  if (!rows.length) lines.push('لا توجد رسائل مسجلة اليوم.');
  const subject = 'تقرير البريد اليومي - ' + today;
  const body = b64(lines.join('\n')).match(/.{1,76}/g).join('\r\n');
  const mime = ['To: ' + to, 'Subject: =?UTF-8?B?' + b64(subject) + '?=', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
  try {
    await gmail(from, 'messages/send', { method: 'POST', body: JSON.stringify({ raw: b64url(mime) }) });
    db.settings.lastReport = today; save(); toast('تم إرسال التقرير اليومي.');
  } catch (e) { toast('فشل إرسال التقرير: ' + e.message); }
}

// ---------- العرض ----------
function render() {
  const today = ymd(new Date()), total = db.accounts.length, on = db.accounts.filter(a => live(a.email)).length;
  $('#sCompanies').textContent = db.companies.length;
  $('#sToday').textContent = db.messages.filter(m => ymd(new Date(m.ms)) === today).length;
  $('#sUnread').textContent = db.messages.filter(m => !m.reviewed).length;
  $('#sStatus').textContent = on + ' / ' + total;
  $('#statusTop').textContent = total ? `متصل ${on} من ${total}` : 'لا يوجد حساب متصل';

  $('#tAccounts').innerHTML = db.accounts.map(a => `<tr><td><span class="ltr">${esc(a.email)}</span></td>
    <td>${live(a.email) ? 'متصل' : 'غير متصل'}</td>
    <td><button data-act="reauth" data-email="${esc(a.email)}">إعادة ربط</button>
    <button class="danger" data-act="rmacc" data-email="${esc(a.email)}">إزالة</button></td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">لا توجد حسابات مربوطة بعد.</td></tr>';

  const cs = [...db.companies].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  $('#tCompanies').innerHTML = cs.map(c => `<tr><td>${esc(c.name)}</td><td><span class="ltr">${esc(c.email)}</span></td>
    <td>${c.active ? 'مفعّل' : 'موقوف'}</td>
    <td><button data-act="toggle" data-id="${c.id}">${c.active ? 'إيقاف المراقبة' : 'تفعيل المراقبة'}</button>
    <button class="danger" data-act="del" data-id="${c.id}">حذف</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">لا توجد عناوين بعد.</td></tr>';

  $('#tMessages').innerHTML = db.messages.slice(0, 100).map(m => `<tr class="${m.reviewed ? '' : 'new'}">
    <td>${esc(companyName(m.companyId))}</td><td><span class="ltr">${esc(m.sender)}</span></td><td>${esc(m.subject)}</td>
    <td><span class="ltr">${esc(m.acc || '—')}</span></td><td>${fmt(m.ms)}</td>
    <td><a target="_blank" rel="noopener" data-act="open" data-id="${esc(m.id)}" href="${esc(m.url)}">فتح Gmail</a></td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">لا توجد رسائل بعد.</td></tr>';
}

// ---------- الأحداث ----------
$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#cName').value.trim(), email = $('#cEmail').value.trim().toLowerCase();
  if (db.companies.some(c => c.email.toLowerCase() === email)) return toast('البريد مسجل بالفعل.');
  db.companies.push({ id: db.nextId++, name, email, active: true });
  save(); render(); $('#cEmail').value = ''; toast('تمت إضافة البريد.');
});
$('#tCompanies').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = +b.dataset.id;
  if (b.dataset.act === 'toggle') { const c = db.companies.find(x => x.id === id); c.active = !c.active; }
  else if (confirm('حذف عنوان المرسل؟')) db.companies = db.companies.filter(x => x.id !== id);
  save(); render();
});
$('#tAccounts').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const email = b.dataset.email;
  if (b.dataset.act === 'reauth') request(email, '');
  else if (confirm('إزالة الحساب من المراقبة؟')) {
    db.accounts = db.accounts.filter(a => a.email !== email); delete tokens[email]; delete db.cache[email]; save(); render();
  }
});
$('#tMessages').addEventListener('click', e => {
  const a = e.target.closest('a[data-act="open"]'); if (!a) return;
  const m = db.messages.find(x => x.id === a.dataset.id); if (m) { m.reviewed = true; save(); setTimeout(render, 0); }
});
$('#reportForm').addEventListener('submit', e => {
  e.preventDefault(); db.settings.reportEmail = $('#reportEmail').value.trim(); save(); toast('تم حفظ عنوان التقرير.');
});
$('#btnSaveClient').addEventListener('click', () => {
  const v = $('#clientId').value.trim();
  if (!validId(v)) return toast('ده مش Client ID صحيح. لازم يبدأ برقم وينتهي بـ .apps.googleusercontent.com (وليس إيميل).');
  db.settings.clientId = v; tokenClient = null; save(); toast('تم حفظ Client ID.');
});
$('#btnConnect').addEventListener('click', () => {
  unlockAudio();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  if (!validId(cid())) return toast('لم يتم إعداد Client ID بعد.');
  const hint = $('#accEmail').value.trim().toLowerCase();
  request(hint || null, hint ? '' : 'select_account');
  $('#accEmail').value = '';
});
$('#soundOn').addEventListener('change', e => { db.settings.sound = e.target.checked; save(); });
$('#btnTestSound').addEventListener('click', () => { unlockAudio(); setTimeout(() => beep(true), 100); });
$('#btnSync').addEventListener('click', () => poll(true));
$('#btnExport').addEventListener('click', () => {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['الشركة', 'المرسل', 'الموضوع', 'الحساب', 'التاريخ', 'مقتطف', 'رابط Gmail'],
    ...db.messages.map(m => [companyName(m.companyId), m.sender, m.subject, m.acc || '', fmt(m.ms), m.snippet, m.url])];
  download('email_monitor.csv', '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
});
$('#btnBackup').addEventListener('click', () => download('email_monitor_backup.json', JSON.stringify({ ...db, cache: {} }), 'application/json'));
$('#btnRestore').addEventListener('click', () => $('#fileRestore').click());
$('#fileRestore').addEventListener('change', async e => {
  try {
    const d = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(d.companies) || !Array.isArray(d.messages)) throw 0;
    const base = emptyDb(); db = { ...base, ...d, v: 3, accounts: d.accounts || [], cache: {}, settings: { ...base.settings, ...d.settings } };
    save(); init(); toast('تم استرجاع النسخة. أعد ربط الحسابات.');
  } catch (err) { toast('ملف النسخة غير صالح.'); }
  e.target.value = '';
});
function download(name, content, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- التشغيل ----------
function init() {
  $('#clientId').value = db.settings.clientId; $('#reportEmail').value = db.settings.reportEmail;
  $('#soundOn').checked = db.settings.sound; $('#clientCard').hidden = !!CLIENT_ID; render();
}
init();
window.addEventListener('load', () => {
  setTimeout(() => { if (validId(cid()) && db.accounts.length) reconnectSilently(); }, 800);
  setInterval(() => poll(false), POLL_MS);
});
