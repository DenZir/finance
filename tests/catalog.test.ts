/**
 * Свои виды и проекты: заводятся, переименовываются, убираются в архив.
 * Заведённые при установке можно только переименовать — импорты находят их по
 * коду, и переименованная «Приватка» по-прежнему получает оплаты привата.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  categoryIdByCode, createCategory, createProject, listCatalog, listCategories, listOperations, listProjects, monthRange,
  partnerDebts, projectIdByCode, updateCategory, updateProject,
} from '../src/ledger.js';
import { importBotprivat } from '../src/import/botprivat.js';

const T = Date.UTC(2026, 9, 20, 9);

test('виды и проекты владельца', async () => {
  const db = openDb(':memory:');
  const taxi = createCategory(db, { kind: 'expense', name: '  Такси  ' });
  assert.equal(listCategories(db).find((c) => c.id === taxi)?.name, 'Такси');
  assert.throws(() => createCategory(db, { kind: 'expense', name: 'такси' }), /уже есть/);
  createCategory(db, { kind: 'income', name: 'Такси' }); // у дохода свой список
  assert.throws(() => createCategory(db, { kind: 'x', name: 'А' }), /дохода или расхода/);
  assert.throws(() => createCategory(db, { kind: 'income', name: ' ' }), /нужно название/);

  // переименованная «Приватка» — всё та же для импорта
  const privat = categoryIdByCode(db, 'privat')!;
  updateCategory(db, privat, { name: 'Приватный канал' });
  updateProject(db, projectIdByCode(db, 'privat')!, { name: 'MARIN 18+' });
  await importBotprivat(db, {
    fetchOrders: async () => ({ orders: [{ orderId: 'o1', provider: 'platega', amount: 299, paidAt: T, tariffName: 'месяц' }], more: false }),
    fetchRate: async () => 100,
    since: T - 1000,
  }, T);
  const op = listOperations(db, ...(Object.values(monthRange('2026-10')) as [number, number]))[0]!;
  assert.equal(op.categoryId, privat);
  assert.equal(listProjects(db).find((p) => p.id === op.projectId)?.name, 'MARIN 18+');

  // заведённый — не в архив; свой — в архив и обратно
  assert.throws(() => updateCategory(db, privat, { archived: true }), /нужен импорту или боту/);
  updateCategory(db, taxi, { archived: true });
  assert.equal(listCategories(db).some((c) => c.id === taxi), false, 'из выбора пропал');
  assert.equal(listCatalog(db).categories.find((c) => c.id === taxi)?.archived, true, 'в каталоге — в архиве');
  createCategory(db, { kind: 'expense', name: 'Такси' }); // имя архивного свободно
  assert.throws(() => updateCategory(db, taxi, { archived: false }), /уже есть/, 'вернуть нельзя, пока имя занято');

  // свой проект с партнёром; доля меняется
  const shop = createProject(db, { name: 'Магазин', partnerPct: '30' });
  assert.equal(partnerDebts(db).find((p) => p.projectId === shop)?.pct, 30);
  updateProject(db, shop, { partnerPct: '' });
  assert.equal(partnerDebts(db).some((p) => p.projectId === shop), false, 'без партнёра — нет долга');
  assert.throws(() => updateProject(db, projectIdByCode(db, 'vpn')!, { archived: true }), /нужен импорту/);
  assert.equal(listCatalog(db).projects.find((p) => p.code === 'privat')?.used, 1);
});
