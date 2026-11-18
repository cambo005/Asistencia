const app = document.getElementById('app');
let pollTimer = null, currentClass = null, currentSession = null, creating = false;
let me = null, mode = 'login', role = 'estudiante';
let stream = null, scanTimer = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const brand = () => `
  <div class="brand"><div class="logo">▣</div>
  <div><h1>Presente</h1><small>Asistencia por QR</small></div></div>`;

async function init() {
  try { me = await api('/api/me'); } catch { me = null; }
  render();
}

function render() {
  stopCam();
  clearInterval(pollTimer);
  if (!me) return authView();
  if (me.role === 'maestro') return teacherView();
  studentView();
}

// ---------- Inicio de sesión / registro ----------
function authView() {
  const reg = mode === 'register';
  app.innerHTML = brand() + `
    <div class="card">
      <h2>${reg ? 'Crear Cuenta' : 'Iniciar Sesión'}</h2>
      <p>${reg ? 'Regístrate para empezar.' : 'Entra con tu nombre y contraseña.'}</p>
      ${reg ? `<div class="tabs">
        <button class="tab ${role === 'estudiante' ? 'on' : ''}" data-r="estudiante">👤 Estudiante</button>
        <button class="tab ${role === 'maestro' ? 'on' : ''}" data-r="maestro">🎓 Maestro</button>
      </div>` : ''}
      <label>Nombre</label>
      <input id="n" placeholder="Tu nombre" autocomplete="username">
      <label>Contraseña</label>
      <input id="p" type="password" placeholder="Mínimo 6 caracteres">
      <div class="err" id="e"></div>
      <button class="btn" id="go">${reg ? 'Crear cuenta' : 'Entrar'}</button>
      <a class="link" id="sw">${reg ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate'}</a>
    </div>`;

  app.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
    role = b.dataset.r;
    const n = document.getElementById('n').value;
    authView();
    document.getElementById('n').value = n;
  });
  document.getElementById('sw').onclick = () => { mode = reg ? 'login' : 'register'; authView(); };
  document.getElementById('go').onclick = async () => {
    try {
      const body = { name: document.getElementById('n').value, password: document.getElementById('p').value, role };
      me = await api(reg ? '/api/register' : '/api/login', 'POST', body);
      render();
    } catch (e) {
      document.getElementById('e').textContent = e.message;
    }
  };
}

const header = () => `
  <div class="top">
    <div><span>Hola,</span><h2>${esc(me.name)}</h2></div>
    <button class="out" id="out" aria-label="Salir">⇥</button>
  </div>`;

function bindLogout() {
  document.getElementById('out').onclick = async () => {
    await api('/api/logout', 'POST');
    me = null; mode = 'login';
    render();
  };
}

// ---------- Estudiante ----------
function studentView() {
  app.innerHTML = header() + `
    <button class="scan" id="sc">
      <div class="i">⬚</div><h3>Escanear QR</h3><p>Registra tu asistencia</p>
    </button>
    <div id="camBox"></div>
    <button class="ghost" id="man">⌨ Ingresar código manualmente</button>
    <div id="manBox"></div>
    <h3 class="sec">📅 Mi Asistencia</h3>
    <div id="list"><p class="muted">Aún no tienes registros.</p></div>`;
  bindLogout();
  loadHistory();

  document.getElementById('sc').onclick = startScan;
  document.getElementById('man').onclick = () => {
    document.getElementById('manBox').innerHTML = `
      <div class="card" style="margin-top:16px">
        <label style="margin-top:0">Código de la clase</label>
        <input id="cd" maxlength="8" placeholder="33C4D652" style="text-transform:uppercase">
        <button class="btn" id="ok">Registrar</button>
      </div>`;
    document.getElementById('ok').onclick = () => register(document.getElementById('cd').value);
  };
}

async function loadHistory() {
  const rows = await api('/api/my-attendance');
  document.getElementById('list').innerHTML = rows.length
    ? rows.map((r) => `
        <div class="row">
          <div><b>${esc(r.title)}</b><br>
          <small>${new Date(r.created_at).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })}</small></div>
          <b>✓</b>
        </div>`).join('')
    : '<p class="muted">Aún no tienes registros.</p>';
}

async function register(raw) {
  const match = String(raw || '').trim().toUpperCase().match(/[A-Z0-9]{8}$/);
  if (!match) return toast('Código inválido');
  try {
    const res = await api('/api/attend', 'POST', { code: match[0] });
    stopCam();
    document.getElementById('camBox').innerHTML = '';
    document.getElementById('manBox').innerHTML = '';
    toast('¡Asistencia registrada en ' + res.title + '!');
    loadHistory();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Cámara ----------
function stopCam() {
  clearInterval(scanTimer);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

async function startScan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return toast('No se pudo abrir la cámara. Usa el código manual.');
  }
  document.getElementById('camBox').innerHTML = '<video id="cam" playsinline muted></video>';
  const video = document.getElementById('cam');
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;

  scanTimer = setInterval(async () => {
    if (!video.videoWidth) return;
    try {
      let value = null;
      if (detector) {
        const found = await detector.detect(video);
        if (found.length) value = found[0].rawValue;
      } else if (window.jsQR) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const qr = jsQR(img.data, img.width, img.height);
        if (qr) value = qr.data;
      }
      if (value) { clearInterval(scanTimer); register(value); }
    } catch {}
  }, 300);
}

// ---------- Maestro ----------
const fmtDate = (t) => new Date(t).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('es', { timeStyle: 'short' });
const fmtShort = (t) => new Date(t).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });

function downloadCsv(name, attendees) {
  const rows = attendees.map((a) => `"${a.name.replace(/"/g, '""')}","${fmtShort(a.created_at)}"`);
  const csv = '\uFEFFNombre,Fecha\n' + rows.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name.replace(/[^\w\-]+/g, '_') + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

const attendeeRows = (list) => list.length
  ? list.map((a) => `<tr><td>${esc(a.name)}</td><td>${fmtShort(a.created_at)}</td></tr>`).join('')
  : '<tr><td colspan="2" style="text-align:center;color:#777;padding:32px">Nadie ha registrado asistencia todavía.</td></tr>';

const teacherHeader = () => `
  <div class="tb">
    <div class="ico">🎓</div>
    <div class="grow"><span>Maestro</span><h2>${esc(me.name)}</h2></div>
    <button class="out" id="out" aria-label="Salir">⇥</button>
  </div>`;

function teacherView() {
  clearInterval(pollTimer);
  const run = currentSession ? sessionDetail(currentClass, currentSession)
            : currentClass ? classDetail(currentClass)
            : classList();
  return run.catch((e) => {
    app.innerHTML = teacherHeader() + '<p class="err">' + esc(e.message) + '</p>';
    bindLogout();
  });
}

async function classList() {
  const classes = await api('/api/classes');
  app.innerHTML = teacherHeader() + `
    <div class="bar"><h3>Mis Clases</h3><button class="sm g" id="nw">＋ Nuevo</button></div>
    ${creating ? `<div style="display:flex;gap:12px;margin-bottom:22px">
      <input id="nn" placeholder="Ej. Matemáticas 3°B" style="flex:1">
      <button class="sm y" id="cr">Crear</button></div>` : ''}
    ${classes.map((c) => `
      <div class="cls" data-id="${c.id}">
        <h3>${esc(c.title)}<span>▦</span></h3>
        <div>📅 <b>${c.sessions}</b> sesiones · ${c.is_open ? '🟢 Abierto' : '⚪ Cerrado'}</div>
        <span class="chip">${c.code}</span>
      </div>`).join('') || (creating ? '' : '<p class="muted">Aún no tienes clases. Toca “Nuevo”.</p>')}`;
  bindLogout();

  document.getElementById('nw').onclick = () => { creating = !creating; classList(); };
  app.querySelectorAll('.cls').forEach((d) => d.onclick = () => { currentClass = d.dataset.id; teacherView(); });
  if (creating) {
    document.getElementById('nn').focus();
    document.getElementById('cr').onclick = async () => {
      try {
        const c = await api('/api/classes', 'POST', { title: document.getElementById('nn').value });
        creating = false; currentClass = c.id; teacherView();
      } catch (e) { toast(e.message); }
    };
  }
}

async function classDetail(id) {
  let c;
  try { c = await api('/api/classes/' + id); }
  catch (e) { currentClass = null; toast(e.message); return classList(); }

  app.innerHTML = `
    <div class="bar">
      <button class="sm sq" id="bk">←</button>
      <button class="sm sq" id="dl" style="color:#d00">🗑</button>
    </div>
    <h2 style="font-size:40px;font-weight:900;margin:0 0 6px;letter-spacing:-1px">${esc(c.title)}</h2>
    <p class="muted" style="margin:0 0 22px;font-size:18px">Muestra este QR a tus estudiantes.</p>
    <div class="card" style="text-align:center">
      <div class="pill" id="st"></div><br>
      <div id="qr" style="display:inline-block;background:#fff;padding:16px;border:3px solid var(--ink);border-radius:20px"></div>
      <div class="code">${c.code}</div>
      <button class="sm y" id="amp" style="margin-top:14px">⤢ Ampliar</button><br>
      <button class="sm" id="tg" style="margin-top:14px"></button>
    </div>
    <div id="live"></div>
    <h3 class="sec">📚 Historial</h3>
    <div id="hist"></div>`;

  new QRCode(document.getElementById('qr'), { text: c.code, width: 230, height: 230 });

  function paint(d) {
    c = d;
    document.getElementById('st').textContent = d.is_open
      ? '🟢 Abierto desde ' + fmtTime(d.opened_at) + ' · ' + fmtDate(d.opened_at)
      : '⚪ Registro cerrado';
    document.getElementById('tg').textContent = d.is_open ? 'Cerrar registro' : 'Abrir registro';

    const live = document.getElementById('live');
    if (d.is_open) {
      live.innerHTML = `
        <div class="bar" style="margin-top:34px">
          <h3>👥 Lista de hoy<span class="badge">${d.attendees.length}</span></h3>
          <button class="sm" id="csv">⭳ CSV</button>
        </div>
        <table><tr><th>Nombre del Estudiante</th><th>Fecha</th></tr><tbody>${attendeeRows(d.attendees)}</tbody></table>`;
      document.getElementById('csv').onclick = () =>
        downloadCsv(d.title + '-' + new Date(d.opened_at).toISOString().slice(0, 10), d.attendees);
    } else {
      live.innerHTML = '<p class="muted" style="margin-top:28px">Pulsa “Abrir registro” para empezar una nueva lista de asistencia.</p>';
    }

    const hist = document.getElementById('hist');
    hist.innerHTML = d.history.length
      ? d.history.map((s) => `
          <div class="row" data-s="${s.id}" style="cursor:pointer">
            <div><b>${fmtDate(s.opened_at)}</b><br>
            <small>${fmtTime(s.opened_at)} – ${fmtTime(s.closed_at)}</small></div>
            <b>👥 ${s.total}</b>
          </div>`).join('')
      : '<p class="muted">Aún no hay sesiones guardadas.</p>';
    hist.querySelectorAll('.row').forEach((r) => r.onclick = () => { currentSession = r.dataset.s; teacherView(); });
  }
  paint(c);

  pollTimer = setInterval(async () => {
    try { paint(await api('/api/classes/' + id)); } catch {}
  }, 3000);

  document.getElementById('bk').onclick = () => { currentClass = null; teacherView(); };
  document.getElementById('dl').onclick = async () => {
    if (!confirm('¿Eliminar esta clase? También se borrará TODO su historial de asistencias.')) return;
    await api('/api/classes/' + id, 'DELETE');
    currentClass = null; teacherView();
  };
  document.getElementById('tg').onclick = async () => {
    try {
      if (c.is_open) {
        if (!confirm('Al cerrar, nadie podrá registrarse y esta lista quedará guardada en el historial. ¿Cerrar?')) return;
        await api('/api/classes/' + id + '/close', 'POST');
      } else {
        await api('/api/classes/' + id + '/open', 'POST');
      }
      paint(await api('/api/classes/' + id));
    } catch (e) { toast(e.message); }
  };
  document.getElementById('amp').onclick = () => {
    const b = document.createElement('div');
    b.className = 'big';
    const size = Math.min(320, innerWidth - 60);
    b.innerHTML = `<h2 style="font-size:32px;margin:0">${esc(c.title)}</h2><div id="q2"></div>
      <div class="code">${c.code}</div><button class="sm">Cerrar</button>`;
    document.body.appendChild(b);
    new QRCode(b.querySelector('#q2'), { text: c.code, width: size, height: size });
    b.onclick = () => b.remove();
  };
}

// Sesión del historial: solo lectura
async function sessionDetail(classId, sid) {
  let s;
  try { s = await api('/api/classes/' + classId + '/sessions/' + sid); }
  catch (e) { currentSession = null; toast(e.message); return classDetail(classId); }

  app.innerHTML = `
    <div class="bar"><button class="sm sq" id="bk">←</button></div>
    <h2 style="font-size:36px;font-weight:900;margin:0 0 6px;letter-spacing:-1px">${esc(s.title)}</h2>
    <p class="muted" style="margin:0 0 6px;font-size:18px;text-transform:capitalize">${fmtDate(s.opened_at)}</p>
    <p class="muted" style="margin:0 0 22px">${fmtTime(s.opened_at)} – ${fmtTime(s.closed_at)} · Sesión cerrada 🔒</p>
    <div class="bar">
      <h3>👥 Asistentes<span class="badge">${s.attendees.length}</span></h3>
      <button class="sm" id="csv">⭳ CSV</button>
    </div>
    <table><tr><th>Nombre del Estudiante</th><th>Fecha</th></tr><tbody>${attendeeRows(s.attendees)}</tbody></table>`;

  document.getElementById('bk').onclick = () => { currentSession = null; teacherView(); };
  document.getElementById('csv').onclick = () =>
    downloadCsv(s.title + '-' + new Date(s.opened_at).toISOString().slice(0, 10), s.attendees);
}

init();