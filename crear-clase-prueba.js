const bcrypt = require('bcryptjs');
const db = require('./db');

let teacher = db.prepare("SELECT * FROM users WHERE role = 'maestro' LIMIT 1").get();
if (!teacher) {
  const info = db.prepare(
    "INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, 'maestro', ?)"
  ).run('Profe Prueba', bcrypt.hashSync('123456', 10), Date.now());
  teacher = { id: info.lastInsertRowid };
}

const code = Math.random().toString(16).slice(2, 10).toUpperCase().padEnd(8, '0');
db.prepare(
  'INSERT INTO classes (teacher_id, title, code, is_open, created_at) VALUES (?, ?, ?, 1, ?)'
).run(teacher.id, 'Clase de prueba', code, Date.now());

console.log('Código de la clase de prueba:', code);