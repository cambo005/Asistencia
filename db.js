require('dotenv').config();
const { Pool, types } = require('pg');

// BIGINT (OID 20) llega como texto por defecto; lo convertimos a número
// para que Date.now() y COUNT(*) funcionen igual que en MySQL.
types.setTypeParser(20, (v) => Number(v));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('estudiante','maestro')),
      created_at BIGINT NOT NULL
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      code CHAR(8) NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    )`);

  // open_flag vale 1 mientras la sesión está abierta y NULL al cerrarse.
  // El UNIQUE garantiza una sola sesión abierta por clase (los NULL no chocan).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      class_id INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      opened_at BIGINT NOT NULL,
      closed_at BIGINT NULL,
      open_flag SMALLINT NULL,
      CONSTRAINT one_open_session UNIQUE (class_id, open_flag)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      CONSTRAINT one_per_session UNIQUE (session_id, student_id)
    )`);
}

module.exports = { pool, init };