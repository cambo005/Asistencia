require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, init } = require('./db');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'solo-para-desarrollo',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// Convierte los ? en $1, $2... para PostgreSQL
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const q = async (sql, params = []) => (await pool.query(toPg(sql), params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role });

// ---------- Cuentas ----------
app.post('/api/register', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role;

  if (!name) return res.status(400).json({ error: 'Escribe tu nombre.' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña necesita mínimo 6 caracteres.' });
  if (!['estudiante', 'maestro'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });

  if (await one('SELECT id FROM users WHERE name = ?', [name])) {
    return res.status(409).json({ error: 'Ese nombre ya está registrado.' });
  }

  const created = await one(
    'INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    [name, bcrypt.hashSync(password, 10), role, Date.now()]
  );
  req.session.userId = created.id;
  res.json(publicUser(await one('SELECT * FROM users WHERE id = ?', [created.id])));
}));

app.post('/api/login', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const user = await one('SELECT * FROM users WHERE name = ?', [name]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Nombre o contraseña incorrectos.' });
  }
  req.session.userId = user.id;
  res.json(publicUser(user));
}));

app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No has iniciado sesión.' });
  const user = await one('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
  res.json(publicUser(user));
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Permisos ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No has iniciado sesión.' });
  next();
}

const requireTeacher = wrap(async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'No has iniciado sesión.' });
  const user = await one('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user || user.role !== 'maestro') {
    return res.status(403).json({ error: 'Solo los maestros pueden hacer esto.' });
  }
  req.user = user;
  next();
});

const ownClass = (req) =>
  one('SELECT * FROM classes WHERE id = ? AND teacher_id = ?', [req.params.id, req.user.id]);

const openSession = (classId) =>
  one('SELECT * FROM sessions WHERE class_id = ? AND closed_at IS NULL', [classId]);

const attendeesOf = (sessionId) =>
  q(`SELECT u.name, a.created_at
     FROM attendance a JOIN users u ON u.id = a.student_id
     WHERE a.session_id = ? ORDER BY a.created_at ASC`, [sessionId]);

// ---------- Estudiante ----------
app.post('/api/attend', requireAuth, wrap(async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!user || user.role !== 'estudiante') {
    return res.status(403).json({ error: 'Solo los estudiantes registran asistencia.' });
  }

  const code = String(req.body.code || '').trim().toUpperCase();
  const cls = await one('SELECT * FROM classes WHERE code = ?', [code]);
  if (!cls) return res.status(404).json({ error: 'No existe una clase con ese código.' });

  const open = await openSession(cls.id);
  if (!open) return res.status(403).json({ error: 'El registro de esta clase está cerrado.' });

  const inserted = await one(
    `INSERT INTO attendance (session_id, student_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
    [open.id, user.id, Date.now()]
  );
  if (!inserted) {
    return res.status(409).json({ error: 'Ya registraste tu asistencia en esta sesión.' });
  }
  res.json({ title: cls.title });
}));

app.get('/api/my-attendance', requireAuth, wrap(async (req, res) => {
  res.json(await q(
    `SELECT c.title, a.created_at
     FROM attendance a
     JOIN sessions s ON s.id = a.session_id
     JOIN classes c ON c.id = s.class_id
     WHERE a.student_id = ?
     ORDER BY a.created_at DESC`, [req.session.userId]));
}));

// ---------- Maestro ----------
app.get('/api/classes', requireTeacher, wrap(async (req, res) => {
  const rows = await q(
    `SELECT c.id, c.title, c.code,
       EXISTS(SELECT 1 FROM sessions s WHERE s.class_id = c.id AND s.closed_at IS NULL) AS is_open,
       (SELECT COUNT(*) FROM sessions s WHERE s.class_id = c.id) AS sessions
     FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC`, [req.user.id]);
  res.json(rows.map((r) => ({ ...r, is_open: !!r.is_open })));
}));

app.post('/api/classes', requireTeacher, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Ponle un nombre a la clase.' });

  let code;
  do {
    code = crypto.randomBytes(4).toString('hex').toUpperCase();
  } while (await one('SELECT 1 FROM classes WHERE code = ?', [code]));

  const created = await one(
    'INSERT INTO classes (teacher_id, title, code, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    [req.user.id, title, code, Date.now()]
  );
  res.json({ id: created.id, title, code });
}));

app.get('/api/classes/:id', requireTeacher, wrap(async (req, res) => {
  const cls = await ownClass(req);
  if (!cls) return res.status(404).json({ error: 'Clase no encontrada.' });

  const open = await openSession(cls.id);
  const history = await q(
    `SELECT s.id, s.opened_at, s.closed_at,
       (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS total
     FROM sessions s WHERE s.class_id = ? AND s.closed_at IS NOT NULL
     ORDER BY s.opened_at DESC`, [cls.id]);

  res.json({
    id: cls.id, title: cls.title, code: cls.code,
    is_open: !!open,
    opened_at: open ? open.opened_at : null,
    attendees: open ? await attendeesOf(open.id) : [],
    history
  });
}));

app.post('/api/classes/:id/open', requireTeacher, wrap(async (req, res) => {
  const cls = await ownClass(req);
  if (!cls) return res.status(404).json({ error: 'Clase no encontrada.' });
  if (await openSession(cls.id)) return res.status(409).json({ error: 'Ya hay un registro abierto.' });
  await q('INSERT INTO sessions (class_id, opened_at, open_flag) VALUES (?, ?, 1)', [cls.id, Date.now()]);
  res.json({ ok: true });
}));

app.post('/api/classes/:id/close', requireTeacher, wrap(async (req, res) => {
  const cls = await ownClass(req);
  if (!cls) return res.status(404).json({ error: 'Clase no encontrada.' });
  const open = await openSession(cls.id);
  if (!open) return res.status(409).json({ error: 'El registro ya está cerrado.' });
  await q('UPDATE sessions SET closed_at = ?, open_flag = NULL WHERE id = ?', [Date.now(), open.id]);
  res.json({ ok: true });
}));

app.get('/api/classes/:id/sessions/:sid', requireTeacher, wrap(async (req, res) => {
  const cls = await ownClass(req);
  if (!cls) return res.status(404).json({ error: 'Clase no encontrada.' });
  const s = await one('SELECT * FROM sessions WHERE id = ? AND class_id = ?', [req.params.sid, cls.id]);
  if (!s) return res.status(404).json({ error: 'Sesión no encontrada.' });
  res.json({
    id: s.id, title: cls.title,
    opened_at: s.opened_at, closed_at: s.closed_at,
    attendees: await attendeesOf(s.id)
  });
}));

app.delete('/api/classes/:id', requireTeacher, wrap(async (req, res) => {
  const cls = await ownClass(req);
  if (!cls) return res.status(404).json({ error: 'Clase no encontrada.' });
  await q('DELETE FROM classes WHERE id = ?', [cls.id]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor. Intenta de nuevo.' });
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log('Servidor en http://localhost:' + PORT)))
  .catch((e) => { console.error('No se pudo conectar a la base de datos:', e.message); process.exit(1); });