import { TEACHER_NAMES } from './student-api.js';

export const STUDENT_LIMIT = 50;
export const newAccountCode = () => String(1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
// D1 has no role column; teacher rows are the ones whose account_code is a teacher name.
const notTeacher = TEACHER_NAMES.length ? `account_code NOT IN (${TEACHER_NAMES.map(() => '?').join(', ')})` : '1 = 1';

export function d1StudentStore(db, makeCode = newAccountCode) {
  if (!db) throw new Error('Student storage is unavailable.');
  const get = id => db.prepare('SELECT * FROM mimi_students WHERE id = ?').bind(id).first();
  const countStudents = async () => (await db.prepare(`SELECT COUNT(*) AS total FROM mimi_students WHERE ${notTeacher}`).bind(...TEACHER_NAMES).first()).total;
  return {
    get,
    byCode: code => db.prepare('SELECT * FROM mimi_students WHERE account_code = ?').bind(code).first(),
    async createStudent(name) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const row = await db.prepare(`INSERT INTO mimi_students (enrollment_key, name, recovery_hash, created_at, account_code)
          SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM mimi_students WHERE ${notTeacher}) < ?
          ON CONFLICT DO NOTHING RETURNING *`).bind(null, name, null, new Date().toISOString(), makeCode(), ...TEACHER_NAMES, STUDENT_LIMIT).first();
        if (row) return row;
        if (await countStudents() >= STUDENT_LIMIT) return null;
      }
      throw new Error('Could not assign an account number. Please try again.');
    },
    async ensureTeacher(name) {
      const existing = await db.prepare('SELECT * FROM mimi_students WHERE account_code = ?').bind(name).first();
      if (existing) return existing;
      const row = await db.prepare(`INSERT INTO mimi_students (enrollment_key, name, recovery_hash, created_at, account_code)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`).bind(null, name, null, new Date().toISOString(), name).first();
      return row ?? await db.prepare('SELECT * FROM mimi_students WHERE account_code = ?').bind(name).first();
    },
    rename: (id, name) => db.prepare('UPDATE mimi_students SET name = ? WHERE id = ? RETURNING *').bind(name, id).first(),
  };
}
