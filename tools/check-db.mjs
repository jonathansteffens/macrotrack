import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('mobile/assets/foods.db', { readOnly: true });
const q = (label, sql, ...p) => {
  console.log('--- ' + label);
  for (const r of db.prepare(sql).all(...p)) console.log(JSON.stringify(r));
};
q('chicken breast roasted', `SELECT name, kcal, protein, carbs, fat, portions_json FROM foods
   WHERE name_norm LIKE '%chicken%' AND name_norm LIKE '%breast%' AND name_norm LIKE '%roasted%' AND name_norm LIKE '%meat only%' LIMIT 3`);
q('egg whole raw', `SELECT name, kcal, protein, fat FROM foods
   WHERE name_norm LIKE '%egg%whole%raw%' LIMIT 3`);
q('foundation sample', `SELECT name, kcal, protein, data_type FROM foods WHERE data_type='foundation' LIMIT 3`);
q('null macros count', `SELECT COUNT(*) AS missing_protein FROM foods WHERE protein IS NULL`);
q('meta', 'SELECT * FROM meta');
