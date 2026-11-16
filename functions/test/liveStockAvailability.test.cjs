'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveProductLiveAvailability,
  isCentralOnePackageUnavailableFailure,
  dispatchPauseDurationMs,
} = require('../lib/services/centralOne');

test('resolveProductLiveAvailability: oculta stock 0 y muestra disponibles con stock vivo', () => {
  const base = {
    active: true,
    stock: 15,
    provider: 'centralone',
    providerOfferId: 'evo-1',
    adminDisabled: false,
    providerRemoved: false,
    calls: [{ packageId: 'evo-1', quantity: 1, provider: 'centralone' }],
  };

  const stockMap = new Map([
    ['evo-1', { inStock: true, availableStock: 12, active: true }],
    ['evo-0', { inStock: false, availableStock: 0, active: true }],
    ['diam-100', { inStock: true, availableStock: null, active: true }],
  ]);

  const ok = resolveProductLiveAvailability(base, stockMap);
  assert.deepEqual(ok, { checked: true, available: true, stock: 12 });

  const soldOut = resolveProductLiveAvailability(
    { ...base, calls: [{ packageId: 'evo-0', quantity: 1, provider: 'centralone' }] },
    stockMap
  );
  assert.deepEqual(soldOut, { checked: true, available: false, stock: 0 });

  const missingFromCatalog = resolveProductLiveAvailability(
    { ...base, calls: [{ packageId: 'removed-sku', quantity: 1, provider: 'centralone' }] },
    stockMap
  );
  assert.deepEqual(missingFromCatalog, { checked: true, available: false, stock: 0 });

  const unlimited = resolveProductLiveAvailability(
    { ...base, stock: null, calls: [{ packageId: 'diam-100', quantity: 1, provider: 'centralone' }] },
    stockMap
  );
  assert.deepEqual(unlimited, { checked: true, available: true, stock: null });
});

test('resolveProductLiveAvailability: reactiva items repuestos y respeta apagado admin', () => {
  const stockMap = new Map([
    ['evo-restocked', { inStock: true, availableStock: 5, active: true }],
  ]);

  const restocked = resolveProductLiveAvailability(
    {
      active: false,
      stock: 0,
      provider: 'centralone',
      providerOfferId: 'evo-restocked',
      adminDisabled: false,
      providerRemoved: false,
      calls: [{ packageId: 'evo-restocked', quantity: 1, provider: 'centralone' }],
    },
    stockMap
  );
  assert.deepEqual(restocked, { checked: true, available: true, stock: 5 });

  const adminOff = resolveProductLiveAvailability(
    {
      active: false,
      stock: 0,
      provider: 'centralone',
      providerOfferId: 'evo-restocked',
      adminDisabled: true,
      providerRemoved: false,
      calls: [{ packageId: 'evo-restocked', quantity: 1, provider: 'centralone' }],
    },
    stockMap
  );
  assert.equal(adminOff.available, false);

  const manualOff = resolveProductLiveAvailability(
    {
      active: false,
      stock: null,
      provider: 'centralone',
      providerOfferId: 'evo-restocked',
      adminDisabled: false,
      providerRemoved: false,
      calls: [{ packageId: 'evo-restocked', quantity: 1, provider: 'centralone' }],
    },
    stockMap
  );
  assert.equal(manualOff.available, false);
});

test('resolveProductLiveAvailability: combos respetan cantidad y stock minimo de llamadas', () => {
  const stockMap = new Map([
    ['pkg-a', { inStock: true, availableStock: 3, active: true }],
    ['pkg-b', { inStock: true, availableStock: 10, active: true }],
    ['pkg-0', { inStock: false, availableStock: 0, active: true }],
  ]);

  const comboOk = resolveProductLiveAvailability(
    {
      active: true,
      stock: null,
      provider: 'centralone',
      adminDisabled: false,
      providerRemoved: false,
      calls: [
        { packageId: 'pkg-a', quantity: 1, provider: 'centralone' },
        { packageId: 'pkg-b', quantity: 2, provider: 'centralone' },
      ],
    },
    stockMap
  );
  assert.deepEqual(comboOk, { checked: true, available: true, stock: 3 });

  const comboInsufficient = resolveProductLiveAvailability(
    {
      active: true,
      stock: null,
      provider: 'centralone',
      adminDisabled: false,
      providerRemoved: false,
      calls: [
        { packageId: 'pkg-a', quantity: 4, provider: 'centralone' },
      ],
    },
    stockMap
  );
  assert.deepEqual(comboInsufficient, { checked: true, available: false, stock: 0 });

  const comboZeroSubcall = resolveProductLiveAvailability(
    {
      active: true,
      stock: null,
      provider: 'centralone',
      adminDisabled: false,
      providerRemoved: false,
      calls: [
        { packageId: 'pkg-b', quantity: 1, provider: 'centralone' },
        { packageId: 'pkg-0', quantity: 1, provider: 'centralone' },
      ],
    },
    stockMap
  );
  assert.deepEqual(comboZeroSubcall, { checked: true, available: false, stock: 0 });
});

test('resolveProductLiveAvailability: pausa temporal tras fallo de despacho y recupera al vencer', () => {
  const nowMs = 1_800_000_000_000;
  const stockMap = new Map([
    ['ml-112', { inStock: true, availableStock: null, active: true }],
  ]);
  const paused = {
    active: false,
    stock: 0,
    provider: 'centralone',
    providerOfferId: 'ml-112',
    adminDisabled: false,
    providerRemoved: false,
    providerPausedUntil: nowMs + 10 * 60_000,
    calls: [{ packageId: 'ml-112', quantity: 1, provider: 'centralone' }],
  };

  assert.deepEqual(resolveProductLiveAvailability(paused, stockMap, nowMs), {
    checked: true,
    available: false,
    stock: 0,
  });
  assert.deepEqual(resolveProductLiveAvailability(paused, null, nowMs), {
    checked: true,
    available: false,
    stock: 0,
  });

  // Al vencer el enfriamiento y seguir inStock en Central One, vuelve automáticamente.
  assert.deepEqual(
    resolveProductLiveAvailability(paused, stockMap, nowMs + 11 * 60_000),
    { checked: true, available: true, stock: null }
  );
});

test('isCentralOnePackageUnavailableFailure & backoff: separa fallos de línea/stock de errores de jugador', () => {
  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'out_of_stock' }), true);
  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'insufficient_stock' }), true);
  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'provider_unavailable' }), true);
  assert.equal(
    isCentralOnePackageUnavailableFailure({
      code: 'unknown',
      action: 'contact_support',
      message: 'La línea no se pudo completar.',
    }),
    true
  );

  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'invalid_player' }), false);
  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'not_eligible', action: 'do_not_retry' }), false);
  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'insufficient_balance' }), false);
  assert.equal(isCentralOnePackageUnavailableFailure({ code: 'network_error' }), false);

  assert.equal(dispatchPauseDurationMs('out_of_stock', 1), 15 * 60_000);
  assert.equal(dispatchPauseDurationMs('unknown', 1), 30 * 60_000);
  assert.equal(dispatchPauseDurationMs('unknown', 2), 60 * 60_000);
  assert.equal(dispatchPauseDurationMs('unknown', 3), 6 * 60 * 60_000);
});
