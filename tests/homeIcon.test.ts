/**
 * Иконка на главный экран iPhone (владелец, 2026-10-22): SVG-значок вкладки iOS
 * не читает и рисует вместо него букву «Д» на чёрном. Нужен PNG apple-touch-icon
 * без прозрачности, и отдаётся он без входа — iOS просит его сам.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/server.js';

test('иконка на главный экран: PNG 180×180 без альфы, без входа; страница на неё ссылается', async () => {
  const app = createApp({ db: openDb(':memory:'), config: { botToken: '1:x', botUsername: 'fin_test_bot', ownerIds: ['1'] }, fetchRate: async () => null });
  const srv = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/apple-touch-icon.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await res.arrayBuffer());
    // IHDR: ширина, высота, тип цвета 2 — RGB: прозрачные углы iOS залил бы чёрным
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], [180, 180, 2]);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Деньги">/);
  } finally {
    srv.close();
  }
});
