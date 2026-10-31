/**
 * Люди (владелец, 2026-10-31): один человек на рекламу и приветку сразу — его
 * узнают по @username, как бы ни писали имя, а без username — по имени среди
 * тех, у кого username неизвестен. Если человека узнать не вышло, владелец
 * правит руками: переименовать, поправить @, объединить двоих, указать, чья
 * сделка, — и сверка с аналитикой этого не перезаписывает.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createPerson, getPerson, listPeople, mergePeople, parseContact, personFor, personLabel, renamePerson } from '../src/people.js';
import { listDeals, setDealPerson, syncDeals, type AnalyticsDeal } from '../src/ads.js';
import { createWelcome, listWelcome, updateWelcome } from '../src/welcome.js';

const T = Date.UTC(2026, 9, 31, 9);
const deal = (ref: string, contact: string): AnalyticsDeal => ({
  ref, kind: ref.startsWith('buy') ? 'buy' : 'sale', date: '2026-10-05', slot: 'evening', buyKind: 'post',
  status: 'done', amount: 1000, contact, channels: ['SATAN GAMES'],
});

test('разбор контакта', () => {
  assert.deepEqual(parseContact('Иван (@ivan)'), { name: 'Иван', username: 'ivan' });
  assert.deepEqual(parseContact('@Ivan'), { name: '@Ivan', username: 'ivan' }, 'имени нет — показываем username как написан');
  assert.deepEqual(parseContact('Иван'), { name: 'Иван', username: null });
  assert.deepEqual(parseContact('  Иван   Петров  '), { name: 'Иван Петров', username: null });
  assert.deepEqual(parseContact('Иван @Ivan_Petrov'), { name: 'Иван', username: 'ivan_petrov' });
  assert.deepEqual(parseContact('https://t.me/ivan_p'), { name: '@ivan_p', username: 'ivan_p' });
  assert.deepEqual(parseContact('Ваня (@abc)'), { name: 'Ваня (@abc)', username: null }, 'короче четырёх знаков — не username');
  assert.equal(parseContact(''), null);
  assert.equal(parseContact('   '), null);
  assert.equal(parseContact(undefined), null);

  assert.equal(personLabel({ name: 'Иван', username: 'ivan' }), 'Иван (@ivan)');
  assert.equal(personLabel({ name: '@Ivan', username: 'ivan' }), '@Ivan');
  assert.equal(personLabel({ name: 'Иван', username: null }), 'Иван');
});

test('человек по контакту: по username, без него — по имени среди людей без username', () => {
  const db = openDb(':memory:');
  const ivan = personFor(db, 'Иван (@ivan)', T)!;
  assert.equal(personFor(db, '@IVAN', T), ivan, 'регистр username не важен');
  assert.equal(personFor(db, 'Ваня (@ivan)', T), ivan, 'имя пишут как придётся — узнаём по username');
  const petr = personFor(db, 'Пётр', T)!;
  assert.equal(personFor(db, 'пётр', T), petr, 'имя — без учёта регистра, и по-русски тоже');
  assert.notEqual(personFor(db, 'Иван', T), ivan, '«Иван» без @ — не обязательно @ivan');
  assert.equal(personFor(db, '', T), null);
  assert.throws(() => createPerson(db, ' ', T), /кто это/);
  assert.equal(createPerson(db, '@ivan', T), ivan, 'заведение руками не задваивает знакомого');
  assert.equal(listPeople(db).length, 3);
});

test('реклама и приветка одного человека — один человек; правки владельца сверка не перезаписывает', async () => {
  const db = openDb(':memory:');
  let list = [deal('sale:1', 'Иван (@ivan)'), deal('buy:2', '@Ivan'), deal('sale:3', ''), deal('sale:4', 'Мария')];
  const deps = { fetchDeals: async () => list, since: Date.UTC(2026, 9, 1) };
  await syncDeals(db, deps, T);
  const person = (ref: string) => listDeals(db).find((d) => d.ref === ref)!.personId;
  const ivan = person('sale:1')!;
  assert.equal(person('buy:2'), ivan, 'продажа и закуп у одного человека');
  assert.equal(person('sale:3'), null, 'без контакта — без человека');

  const w = createWelcome(db, { contact: 'ivan (@IVAN)', price: '5', startedOn: '2026-10-01' }, T);
  assert.equal(listWelcome(db)[0]!.personId, ivan, 'приветка — тот же человек');
  assert.throws(() => createWelcome(db, { contact: '', price: '5', startedOn: '2026-10-01' }, T), /кто покупатель/);
  assert.throws(() => createWelcome(db, { personId: 999, price: '5', startedOn: '2026-10-01' }, T), /такого человека нет/);

  // владелец поправил, чья сделка; новая сверка с тем же контактом её не возвращает
  const maria = person('sale:4')!;
  setDealPerson(db, 'sale:1', maria);
  list = list.map((d) => (d.ref === 'sale:3' ? { ...d, contact: 'Мария' } : d));
  await syncDeals(db, deps, T);
  assert.equal(person('sale:1'), maria, 'назначенного руками не трогаем');
  assert.equal(person('sale:3'), maria, 'контакт появился — человек назначен');
  assert.throws(() => setDealPerson(db, 'sale:1', 999), /такого человека нет/);

  // размещение — другому человеку по выбору
  updateWelcome(db, w, { personId: maria }, T);
  assert.equal(listWelcome(db)[0]!.contact, 'Мария');
  updateWelcome(db, w, { contact: '@ivan' }, T);
  assert.equal(listWelcome(db)[0]!.personId, ivan);
});

test('переименовать, поправить @ и объединить', () => {
  const db = openDb(':memory:');
  const a = personFor(db, 'Ваня', T)!;
  const b = personFor(db, 'Иван (@ivan)', T)!;
  const w = createWelcome(db, { personId: a, price: '5', startedOn: '2026-10-01' }, T);

  renamePerson(db, a, { name: 'Ваня П.' });
  assert.equal(listWelcome(db)[0]!.contact, 'Ваня П.', 'приветка показывает новое имя');
  assert.throws(() => renamePerson(db, a, { username: '@ivan' }), /уже у «Иван» — объедините/);
  assert.throws(() => renamePerson(db, a, { username: 'а б' }), /не username/);
  assert.throws(() => renamePerson(db, a, { name: ' ' }), /нужно имя/);
  renamePerson(db, a, { username: '@Vanya_P' });
  assert.equal(getPerson(db, a).username, 'vanya_p');
  renamePerson(db, a, { username: '' });
  assert.equal(getPerson(db, a).username, null);

  assert.throws(() => mergePeople(db, a, a), /один и тот же/);
  mergePeople(db, b, a);
  assert.throws(() => getPerson(db, b), /такого человека нет/);
  assert.equal(getPerson(db, a).username, 'ivan', 'username объединённого переходит, если своего не было');
  assert.equal(listWelcome(db).find((d) => d.id === w)!.contact, 'Ваня П. (@ivan)');
  assert.equal(personFor(db, '@ivan', T), a, 'по username теперь находится объединённый');
});
