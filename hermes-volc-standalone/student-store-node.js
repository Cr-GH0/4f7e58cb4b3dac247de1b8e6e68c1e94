import { readFile, writeFile, rename } from 'node:fs/promises';
import { STUDENT_LIMIT, newAccountCode } from './student-store.js';

// One server process owns this file. Multi-instance deployments use D1.
export function fileStudentStore(path, makeCode = newAccountCode) {
  let queue = Promise.resolve();
  const read = async () => {
    try { const data = JSON.parse(await readFile(path, 'utf8')); for (const row of data.students) row.account_code ??= String(1000 + row.id); return data; }
    catch (error) { if (error.code === 'ENOENT') return { nextId: 1, students: [] }; throw error; }
  };
  const mutate = fn => {
    const work = queue.catch(() => {}).then(async () => {
      const data = await read(); const result = fn(data);
      await writeFile(path + '.tmp', JSON.stringify(data), 'utf8');
      await rename(path + '.tmp', path); return result;
    });
    queue = work; return work;
  };
  return {
    get: async id => (await read()).students.find(x => x.id === id) ?? null,
    byCode: async code => (await read()).students.find(x => x.account_code === code) ?? null,
    createStudent: name => mutate(data => {
      if (data.students.filter(x => x.role !== 'teacher').length >= STUDENT_LIMIT) return null;
      let code;
      for (let attempt=0;attempt<50;attempt++) { const candidate=makeCode(); if (!data.students.some(x=>x.account_code===candidate)) { code=candidate; break; } }
      if (!code) throw new Error('Could not assign an account number. Please try again.');
      const row = { id: data.nextId++, account_code:code, enrollment_key: null, name, recovery_hash: null, voiceprint_id: null, role: 'student', created_at: new Date().toISOString() };
      data.students.push(row); return row;
    }),
    ensureTeacher: name => mutate(data => {
      const existing = data.students.find(x => x.account_code === name && x.role === 'teacher');
      if (existing) return existing;
      const row = { id: data.nextId++, account_code: name, name, role: 'teacher', voiceprint_id: null, created_at: new Date().toISOString() };
      data.students.push(row); return row;
    }),
    rename: (id, name) => mutate(data => { const row = data.students.find(x => x.id === id); if (row) row.name = name; return row; }),
  };
}
