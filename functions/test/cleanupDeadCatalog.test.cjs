'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('firebase-admin/firestore');

const {
  classifyCatalog,
  assertSafe,
  serializeValue,
  deserializeValue,
} = require('../scripts/cleanupDeadCatalog.cjs');

function makeBaseInput(overrides = {}) {
  return {
    games: new Map(),
    products: new Map(),
    live: new Map(),
    openOrderGameIds: new Set(),
    openOrderProductIds: new Set(),
    alsoDelete: new Set(),
    keep: new Set(),
    ...overrides,
  };
}

test('classifyCatalog: elimina FazerCards, Inefable inactivo, huérfanos, CO ausentes/inactivos/retirados y cascarones', () => {
  const games = new Map([
    ['fz-topup-algo', { name: 'Algo', provider: 'fazercards', active: false, hiddenReason: 'provider_migrated' }],
    ['co-topup-live-ok', { name: 'Live Game', provider: 'centralone', active: true }],
    ['co-topup-out', { name: 'Out Game', provider: 'centralone', active: false, hiddenReason: 'out_of_stock' }],
    ['co-topup-removed', { name: 'Removed Game', provider: 'centralone', active: false, hiddenReason: 'provider_removed', providerRemoved: true }],
    ['mobile-legends', { name: 'Mobile Legends', provider: 'inefable', active: false }],
    ['honor-of-kings', { name: 'Honor of Kings', active: true }],
    ['roblox', { name: 'Roblox', active: false }],
    ['manual-empty', { name: 'Manual Vacío', manual: true, active: false }],
    ['streaming-netflix', { name: 'Netflix Manual', manual: false, active: true }],
  ]);

  const products = new Map([
    ['fz-p1', { gameId: 'fz-topup-algo', name: 'FZ P1', priceUsd: 1, active: false, providerRemoved: true }],
    ['co-live-1', {
      gameId: 'co-topup-live-ok',
      name: 'Live 1',
      provider: 'centralone',
      providerOfferId: 'offer-live',
      calls: [{ provider: 'centralone', packageId: 'offer-live', quantity: 1 }],
      priceUsd: 2.5,
      active: true,
    }],
    ['co-missing-sku', {
      gameId: 'co-topup-live-ok',
      name: 'Missing SKU',
      provider: 'centralone',
      providerOfferId: 'offer-missing',
      calls: [{ provider: 'centralone', packageId: 'offer-missing', quantity: 1 }],
      priceUsd: 2,
      active: false,
    }],
    ['co-inactive-sku', {
      gameId: 'co-topup-live-ok',
      name: 'Inactive SKU',
      provider: 'centralone',
      providerOfferId: 'offer-inactive',
      calls: [{ provider: 'centralone', packageId: 'offer-inactive', quantity: 1 }],
      priceUsd: 2,
      active: false,
    }],
    ['co-removed-sync', {
      gameId: 'co-topup-removed',
      name: 'Removed by sync',
      provider: 'centralone',
      providerOfferId: 'offer-live',
      calls: [{ provider: 'centralone', packageId: 'offer-live', quantity: 1 }],
      priceUsd: 2,
      active: false,
      providerRemoved: true,
    }],
    ['co-out-1', {
      gameId: 'co-topup-out',
      name: 'Agotado pero vivo',
      provider: 'centralone',
      providerOfferId: 'offer-oos',
      calls: [{ provider: 'centralone', packageId: 'offer-oos', quantity: 1 }],
      priceUsd: 5,
      active: false,
      stock: 0,
    }],
    ['ml-inefable-1', {
      gameId: 'mobile-legends',
      name: 'ML Inefable',
      fulfillment: 'auto',
      calls: [{ packageId: 1 }],
      priceUsd: 1.5,
      active: true,
    }],
    ['hok-inefable-1', {
      gameId: 'honor-of-kings',
      name: 'HoK Inefable',
      fulfillment: 'auto',
      calls: [{ packageId: 64 }],
      priceUsd: 0.4,
      active: true,
    }],
    ['hok-manual-ok', {
      gameId: 'honor-of-kings',
      name: 'HoK Manual',
      fulfillment: 'manual',
      calls: [],
      priceUsd: 1.2,
      active: true,
    }],
    ['hok-manual-off', {
      gameId: 'honor-of-kings',
      name: 'HoK Manual Off',
      fulfillment: 'manual',
      calls: [],
      priceUsd: 1.2,
      active: false,
    }],
    ['orphan-1', {
      gameId: 'no-existe',
      name: 'Huérfano',
      fulfillment: 'auto',
      calls: [{ packageId: 123 }],
      priceUsd: 1,
      active: false,
    }],
    ['orphan-manual-active', {
      gameId: 'no-existe',
      name: 'Huérfano Manual Activo',
      fulfillment: 'manual',
      calls: [],
      priceUsd: 1,
      active: true,
    }],
    ['streaming-p1', {
      gameId: 'streaming-netflix',
      name: 'Netflix 1 mes',
      provider: 'centralone',
      providerOfferId: 'missing-stream',
      calls: [{ provider: 'centralone', packageId: 'missing-stream', quantity: 1 }],
      priceUsd: 5,
      active: true,
    }],
  ]);

  const live = new Map([
    ['offer-live', { status: 'active', inStock: true, sku: 'S1', name: 'Live' }],
    ['offer-inactive', { status: 'inactive', inStock: false, sku: 'S2', name: 'Inactive' }],
    ['offer-oos', { status: 'active', inStock: false, sku: 'S3', name: 'OOS' }],
  ]);

  const res = classifyCatalog(makeBaseInput({ games, products, live }));

  assert.deepEqual(res.products.get('fz-p1'), { action: 'delete', reason: 'proveedor_viejo_fazercards' });
  assert.deepEqual(res.products.get('co-live-1'), { action: 'protect', reason: 'co_vivo' });
  assert.deepEqual(res.products.get('co-missing-sku'), { action: 'delete', reason: 'co_sku_inexistente' });
  assert.deepEqual(res.products.get('co-inactive-sku'), { action: 'delete', reason: 'co_desactivado' });
  assert.deepEqual(res.products.get('co-removed-sync'), { action: 'delete', reason: 'co_retirado_por_sync' });
  assert.deepEqual(res.products.get('co-out-1'), { action: 'protect', reason: 'co_vivo' });
  assert.deepEqual(res.products.get('ml-inefable-1'), { action: 'delete', reason: 'proveedor_viejo_inefable' });
  assert.deepEqual(res.products.get('hok-inefable-1'), { action: 'review', reason: 'inefable_en_juego_activo' });
  assert.deepEqual(res.products.get('hok-manual-ok'), { action: 'protect', reason: 'manual_activo' });
  assert.deepEqual(res.products.get('hok-manual-off'), { action: 'review', reason: 'manual_inactivo_o_sin_precio' });
  assert.deepEqual(res.products.get('orphan-1'), { action: 'delete', reason: 'huerfano_sin_juego' });
  assert.deepEqual(res.products.get('orphan-manual-active'), { action: 'review', reason: 'huerfano_manual_activo' });
  assert.deepEqual(res.products.get('streaming-p1'), { action: 'review', reason: 'streaming_activo' });

  assert.deepEqual(res.games.get('fz-topup-algo'), { action: 'delete', reason: 'proveedor_viejo_fazercards' });
  assert.deepEqual(res.games.get('co-topup-live-ok'), { action: 'protect', reason: 'vendible' });
  assert.deepEqual(res.games.get('co-topup-out'), { action: 'keep', reason: 'co_agotado_temporal' });
  assert.deepEqual(res.games.get('co-topup-removed'), { action: 'delete', reason: 'co_retirado_del_catalogo' });
  assert.deepEqual(res.games.get('mobile-legends'), { action: 'delete', reason: 'proveedor_viejo_inefable' });
  assert.deepEqual(res.games.get('honor-of-kings'), { action: 'protect', reason: 'vendible' });
  assert.deepEqual(res.games.get('roblox'), { action: 'delete', reason: 'proveedor_viejo_inefable' });
  assert.deepEqual(res.games.get('manual-empty'), { action: 'review', reason: 'manual_sin_paquetes' });
  assert.deepEqual(res.games.get('streaming-netflix'), { action: 'protect', reason: 'streaming_activo' });
});

test('classifyCatalog: protege órdenes abiertas y detecta duplicados CO residuales', () => {
  const games = new Map([
    ['fz-open', { name: 'FZ Open', provider: 'fazercards', active: false }],
    ['co-dup-game', { name: 'Dup Game', provider: 'centralone', active: true }],
  ]);
  const products = new Map([
    ['fz-open-p', { gameId: 'fz-open', name: 'FZ Open P', priceUsd: 2, active: false }],
    ['dup-active', {
      gameId: 'co-dup-game',
      name: 'Oferta A',
      provider: 'centralone',
      providerOfferId: 'offer-a',
      calls: [{ provider: 'centralone', packageId: 'offer-a', quantity: 1 }],
      priceUsd: 3,
      active: true,
    }],
    ['dup-inactive', {
      gameId: 'co-dup-game',
      name: 'Oferta A dup',
      provider: 'centralone',
      providerOfferId: 'offer-a',
      calls: [{ provider: 'centralone', packageId: 'offer-a', quantity: 1 }],
      priceUsd: 3,
      active: false,
    }],
    ['dup-both-1', {
      gameId: 'co-dup-game',
      name: 'Oferta B1',
      provider: 'centralone',
      providerOfferId: 'offer-b',
      calls: [{ provider: 'centralone', packageId: 'offer-b', quantity: 1 }],
      priceUsd: 4,
      active: true,
    }],
    ['dup-both-2', {
      gameId: 'co-dup-game',
      name: 'Oferta B2',
      provider: 'centralone',
      providerOfferId: 'offer-b',
      calls: [{ provider: 'centralone', packageId: 'offer-b', quantity: 1 }],
      priceUsd: 4,
      active: true,
    }],
  ]);
  const live = new Map([
    ['offer-a', { status: 'active', inStock: true, sku: 'A', name: 'A' }],
    ['offer-b', { status: 'active', inStock: true, sku: 'B', name: 'B' }],
  ]);

  const res = classifyCatalog(
    makeBaseInput({
      games,
      products,
      live,
      openOrderGameIds: new Set(['fz-open']),
      openOrderProductIds: new Set(['fz-open-p']),
    })
  );

  assert.deepEqual(res.products.get('fz-open-p'), { action: 'review', reason: 'orden_abierta' });
  assert.deepEqual(res.games.get('fz-open'), { action: 'review', reason: 'orden_abierta' });
  assert.deepEqual(res.products.get('dup-active'), { action: 'protect', reason: 'co_vivo' });
  assert.deepEqual(res.products.get('dup-inactive'), { action: 'delete', reason: 'duplicado_residual' });
  assert.deepEqual(res.products.get('dup-both-1'), { action: 'review', reason: 'duplicado_ambos_activos' });
  assert.deepEqual(res.products.get('dup-both-2'), { action: 'review', reason: 'duplicado_ambos_activos' });
});

test('assertSafe: lanza error si se fuerza borrado de CO vivo o manual activo', () => {
  const games = new Map([['g1', { name: 'G1', provider: 'centralone', active: true }]]);
  const products = new Map([
    ['p-live', {
      gameId: 'g1',
      provider: 'centralone',
      providerOfferId: 'o1',
      calls: [{ provider: 'centralone', packageId: 'o1', quantity: 1 }],
      priceUsd: 1,
      active: true,
    }],
  ]);
  const live = new Map([['o1', { status: 'active', inStock: true }]]);

  assert.throws(
    () =>
      assertSafe(
        { games, products, live, openOrderGameIds: new Set(), openOrderProductIds: new Set() },
        {
          games: new Map([['g1', { action: 'protect', reason: 'vendible' }]]),
          products: new Map([['p-live', { action: 'delete', reason: 'inventado' }]]),
        }
      ),
    /Invariante violado/
  );
});

test('serializeValue y deserializeValue preservan Timestamps', () => {
  const ts = new Timestamp(1700000000, 123000000);
  const raw = { a: 1, createdAt: ts, nested: [{ t: ts }] };
  const serialized = JSON.parse(JSON.stringify(serializeValue(raw)));
  assert.deepEqual(serialized.createdAt, { __ts: [1700000000, 123000000] });
  const restored = deserializeValue(serialized, Timestamp);
  assert.ok(restored.createdAt instanceof Timestamp);
  assert.equal(restored.createdAt.seconds, 1700000000);
  assert.equal(restored.nested[0].t.nanoseconds, 123000000);
});

test('classifyCatalog: jamás borra productos CO en mappedOfferIds ni temporalmente sin stock aunque tuvieran providerRemoved', () => {
  const games = new Map([
    ['co-topup-rescued', { name: 'Rescued Game', provider: 'centralone', active: false, providerRemoved: true, hiddenReason: 'provider_removed' }],
    ['co-topup-oos', { name: 'OOS Game', provider: 'centralone', active: false, hiddenReason: 'out_of_stock' }],
  ]);
  const products = new Map([
    ['co-rescued-p', {
      gameId: 'co-topup-rescued',
      name: 'Anima Pack 1',
      provider: 'centralone',
      providerOfferId: 'offer-rescued',
      calls: [{ provider: 'centralone', packageId: 'offer-rescued', quantity: 1 }],
      priceUsd: 9.99,
      active: false,
      providerRemoved: true,
    }],
    ['co-oos-p', {
      gameId: 'co-topup-oos',
      name: 'OOS Offer',
      provider: 'centralone',
      providerOfferId: 'offer-oos',
      calls: [{ provider: 'centralone', packageId: 'offer-oos', quantity: 1 }],
      priceUsd: 4.5,
      active: false,
      stock: 0,
    }],
  ]);
  const live = new Map([
    ['offer-rescued', { status: 'active', inStock: true, sku: 'S1', name: 'Anima Pack 1' }],
    ['offer-oos', { status: 'active', inStock: false, sku: 'S2', name: 'OOS Offer' }],
  ]);

  const res = classifyCatalog(
    makeBaseInput({
      games,
      products,
      live,
      mappedOfferIds: new Set(['offer-rescued', 'offer-oos']),
      mappedGameIds: new Set(['co-topup-rescued', 'co-topup-oos']),
    })
  );

  assert.deepEqual(res.products.get('co-rescued-p'), {
    action: 'protect',
    reason: 'co_recuperado_por_nuevo_mapeo',
  });
  assert.deepEqual(res.products.get('co-oos-p'), {
    action: 'protect',
    reason: 'co_vivo',
  });
  assert.deepEqual(res.games.get('co-topup-rescued'), {
    action: 'protect',
    reason: 'co_recuperado_por_nuevo_mapeo',
  });
  assert.deepEqual(res.games.get('co-topup-oos'), {
    action: 'keep',
    reason: 'co_agotado_temporal',
  });
});
