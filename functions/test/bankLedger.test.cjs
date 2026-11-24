const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock
// ---------------------------------------------------------------------------
const store = new Map();
let autoIdCounter = 0;
let txChain = Promise.resolve();

function isIncrementTransform(val) {
  return Boolean(
    val &&
      typeof val === 'object' &&
      typeof val.operand === 'number' &&
      !(val instanceof Timestamp)
  );
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
  if (isIncrementTransform(value)) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = clone(v);
    }
    return out;
  }
  return value;
}

function deepMerge(target, source) {
  const out = clone(target || {});
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    if (isIncrementTransform(value)) {
      const prev = typeof out[key] === 'number' ? out[key] : 0;
      out[key] = Math.round((prev + value.operand) * 10000) / 10000;
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Timestamp) &&
      typeof value.toMillis !== 'function' &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key]) &&
      !(out[key] instanceof Timestamp)
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function getByPath(obj, fieldPath) {
  return fieldPath.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

function toComparable(val) {
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  return val;
}

function makeSnap(docPath) {
  const id = docPath.split('/').pop();
  if (!store.has(docPath)) {
    return {
      id,
      exists: false,
      data: () => undefined,
      get: () => undefined,
    };
  }
  const raw = store.get(docPath);
  return {
    id,
    exists: true,
    data: () => clone(raw),
    get: (f) => getByPath(raw, f),
  };
}

function makeDocRef(docPath) {
  return {
    id: docPath.split('/').pop(),
    path: docPath,
    firestore: mockDb,
    get: async () => makeSnap(docPath),
    set: async (data, options) => {
      const existing = store.get(docPath);
      if (options && options.merge) {
        store.set(docPath, deepMerge(existing || {}, data));
      } else {
        store.set(docPath, clone(data));
      }
    },
    update: async (data) => {
      const existing = store.get(docPath);
      if (!existing) throw new Error(`Document does not exist: ${docPath}`);
      store.set(docPath, deepMerge(existing, data));
    },
    delete: async () => {
      store.delete(docPath);
    },
    collection: (subCol) => makeCollectionRef(`${docPath}/${subCol}`),
  };
}

function makeQuery(colPath, filters = [], limitCount = null) {
  return {
    where: (field, op, value) => makeQuery(colPath, [...filters, { field, op, value }], limitCount),
    limit: (n) => makeQuery(colPath, filters, n),
    orderBy: () => makeQuery(colPath, filters, limitCount),
    get: async () => {
      const prefix = `${colPath}/`;
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        const matches = filters.every(({ field, op, value }) => {
          const docVal = getByPath(v, field);
          if (op === '==') return toComparable(docVal) === toComparable(value);
          if (op === 'in') return Array.isArray(value) && value.includes(docVal);
          return false;
        });
        if (matches) {
          docs.push({
            id: rest,
            exists: true,
            data: () => clone(v),
            get: (f) => getByPath(v, f),
          });
        }
      }
      const sliced = limitCount !== null ? docs.slice(0, limitCount) : docs;
      return {
        empty: sliced.length === 0,
        size: sliced.length,
        docs: sliced,
      };
    },
  };
}

function makeCollectionRef(colPath) {
  const baseQuery = makeQuery(colPath);
  return {
    ...baseQuery,
    firestore: mockDb,
    doc: (id) => {
      const docId = id || `auto_${++autoIdCounter}`;
      return makeDocRef(`${colPath}/${docId}`);
    },
    add: async (data) => {
      const ref = makeDocRef(`${colPath}/auto_${++autoIdCounter}`);
      await ref.set(data);
      return ref;
    },
  };
}

const mockDb = {
  collection: (name) => makeCollectionRef(name),
  runTransaction: (fn) => {
    const run = txChain.then(async () => {
      let hasWritten = false;
      const stagedWrites = [];
      const tx = {
        get: async (ref) => {
          if (hasWritten) {
            throw new Error('Firestore transactions require all reads before writes.');
          }
          return makeSnap(ref.path);
        },
        set: (ref, data, options) => {
          hasWritten = true;
          stagedWrites.push(() => ref.set(data, options));
        },
        update: (ref, data) => {
          hasWritten = true;
          stagedWrites.push(() => ref.update(data));
        },
        delete: (ref) => {
          hasWritten = true;
          stagedWrites.push(() => ref.delete());
        },
        create: (ref, data) => {
          hasWritten = true;
          stagedWrites.push(() => {
            if (store.has(ref.path)) throw new Error('Document already exists');
            return ref.set(data);
          });
        },
      };
      const result = await fn(tx);
      for (const apply of stagedWrites) {
        await apply();
      }
      return result;
    });
    txChain = run.catch(() => {});
    return run;
  },
};

const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    auth: {},
    COLLECTIONS: {
      orders: 'orders',
      users: 'users',
      config: 'config',
      paymentRefs: 'paymentRefs',
      auditLogs: 'auditLogs',
      adminAlerts: 'adminAlerts',
      stats: 'stats',
      bankLedger: 'bankLedger',
    },
    CONFIG_DOC_ID: 'app',
    orders: () => mockDb.collection('orders'),
    users: () => mockDb.collection('users'),
    paymentRefs: () => mockDb.collection('paymentRefs'),
    configDoc: () => mockDb.collection('config').doc('app'),
    auditLogs: () => mockDb.collection('auditLogs'),
    adminAlerts: () => mockDb.collection('adminAlerts'),
    bankLedger: () => mockDb.collection('bankLedger'),
    now: () => Timestamp.now(),
    minutesFromNow: (m) => Timestamp.fromMillis(Date.now() + m * 60_000),
    Timestamp,
  },
};

const stubModule = (relPath, exportsObj) => {
  const full = path.resolve(__dirname, relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
};

let mockPabiloResult = null;
stubModule('../lib/services/pabilo.js', {
  verifyPayment: async () => mockPabiloResult,
});
stubModule('../lib/services/catalog.js', { decrementStock: async () => {} });
stubModule('../lib/services/coupons.js', { consume: async () => {} });
stubModule('../lib/services/audit.js', {
  record: async () => {},
  ACTIONS: {
    ORDER_PAYMENT_VERIFIED: 'order.payment.verified',
    ORDER_PAYMENT_REJECTED: 'order.payment.rejected',
    ORDER_REFUNDED: 'order.refunded',
  },
});
stubModule('../lib/services/notifications.js', { notify: async () => {} });
stubModule('../lib/services/adminAlerts.js', { alert: async () => {} });
stubModule('../lib/services/orderEmails.js', { sendOrderEmail: async () => {} });
stubModule('../lib/services/stats.js', {
  STORE_TIMEZONE: 'America/Caracas',
  dayKey: (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  },
  trackEvent: async () => {},
});
stubModule('../lib/services/dispatch.js', {
  dispatchOrder: async () => {},
  prepareManualOrder: async () => {},
});
stubModule('../lib/services/orderEvents.js', { addEvent: async () => {} });

const bankLedger = require('../lib/services/bankLedger.js');
const ordersService = require('../lib/services/orders.js');
const whatsappSync = require('../lib/services/whatsappSync.js');
const settingsService = require('../lib/services/settings.js');

const ACTIVE_ACCOUNT_KEY = '0102-V32463319-04222003851';

function seedConfig() {
  settingsService.invalidateConfigCache();
  store.set('config/app', {
    bank: {
      code: '0102',
      name: 'Banco de Venezuela',
      idNumber: 'V-32463319',
      phone: '04222003851',
      holder: 'Refill Store',
    },
    transfer: {
      enabled: true,
      code: '0102',
      name: 'Banco de Venezuela',
      idNumber: 'V-32.463.319',
      holder: 'Refill Store',
      accountNumber: '01020471270000600934',
      accountType: 'corriente',
    },
    checkout: {
      referenceMinLength: 4,
      referenceMaxLength: 20,
      orderExpiryMinutes: 30,
      amountTolerancePercent: 0.5,
      maxVerifyAttempts: 5,
      maxOpenOrdersPerUser: 3,
      walletEnabled: true,
    },
    tiers: [
      { tier: 'hierro', label: 'Hierro', minSpentUsd: 0, discountPercent: 0, profile: '' },
    ],
  });
}

function seedOrder(id, overrides = {}) {
  const nowTs = Timestamp.now();
  const base = {
    code: 'RF-TEST01',
    uid: 'user-1',
    userId: 'user-1',
    user: { email: 'test@example.com', displayName: 'Test', photoURL: null },
    gameId: 'free-fire',
    gameName: 'Free Fire',
    providerGameId: 1,
    provider: 'centralone',
    providerFamily: 'topup',
    productId: 'ff-100',
    productName: '100+10 Diamantes',
    productSku: 'ff-100',
    productAmount: 100,
    productBonus: 10,
    fulfillment: 'auto',
    playerId: '123456789',
    playerId2: null,
    playerFields: { playerId: '123456789' },
    pricing: {
      unitUsd: 1,
      quantity: 1,
      subtotalUsd: 1,
      discountUsd: 0,
      totalUsd: 1,
      walletAppliedUsd: 0,
      amountDueUsd: 1,
      rate: 1000,
      totalBs: 1000,
      couponCode: null,
      creatorCode: null,
      costUsd: 0.7,
      profitUsd: 0.3,
    },
    creator: null,
    contactPhone: '+584120000000',
    emailsSent: [],
    payment: {
      method: 'pagomovil_bdv',
      reference: null,
      reportedAmountBs: null,
      partials: [],
      paidBs: 0,
      verifiedAt: null,
      attempts: 0,
      providerResponse: null,
      bankSnapshot: {
        code: '0102',
        name: 'Banco de Venezuela',
        idNumber: 'V-32463319',
        phone: '04222003851',
      },
    },
    dispatch: { calls: [], startedAt: null, completedAt: null, lastError: null },
    whatsappUrl: null,
    status: 'awaiting_payment',
    customerNote: null,
    adminNote: null,
    createdAt: nowTs,
    updatedAt: nowTs,
    expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000),
  };

  store.set(`orders/${id}`, deepMerge(base, overrides));
}

test.beforeEach(() => {
  store.clear();
  autoIdCounter = 0;
  mockPabiloResult = null;
  seedConfig();
});

test('1. Idempotencia estricta por referencia (doble recordInflow y WhatsApp sync)', async () => {
  const first = await bankLedger.recordInflow({
    bankSnapshot: { code: '0102', name: 'Banco de Venezuela', idNumber: 'V-32463319', phone: '04222003851' },
    paymentMethod: 'pagomovil_bdv',
    amountBs: 1250.75,
    source: 'web',
    orderId: 'ord-1',
    orderCode: 'RF-001',
    reference: '00998877',
  });
  const second = await bankLedger.recordInflow({
    bankSnapshot: { code: '0102', name: 'Banco de Venezuela', idNumber: 'V32463319', phone: '0422-2003851' },
    paymentMethod: 'pagomovil_bdv',
    amountBs: 1250.75,
    source: 'whatsapp',
    orderId: 'wa_00998877',
    orderCode: 'WA-998877',
    reference: '00998877',
  });

  assert.equal(first.recorded, true);
  assert.equal(first.accountKey, ACTIVE_ACCOUNT_KEY);
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, true);

  // Sync WhatsApp con misma referencia tampoco duplica
  await whatsappSync.syncWhatsappOrder({
    referencia: '00998877',
    clienteContacto: '04141112233',
    juego: 'Free Fire',
    paqueteNombre: '100+10 Diamantes',
    montoBs: 1250.75,
    tasaBcv: 1000,
    tipoDespacho: 'AUTOMATICO',
    estado: 'COMPLETADO',
    bankSnapshot: { code: '0102', name: 'Banco de Venezuela', idNumber: 'V32463319', phone: '04222003851' },
  });

  const report = await bankLedger.getLedgerReport({ accountKey: ACTIVE_ACCOUNT_KEY });
  assert.equal(report.movements.length, 1);
  assert.equal(report.summary.totalInflowBs, 1250.75);
});

test('2. Pago mixto con RefillCoins solo suma los Bs reales acreditados al banco', async () => {
  seedOrder('ord-mix', {
    pricing: {
      totalUsd: 10,
      walletAppliedUsd: 4,
      amountDueUsd: 6,
      rate: 1000,
      totalBs: 6000,
    },
  });
  store.set('users/user-1', { uid: 'user-1', email: 'test@example.com', walletBalanceUsd: 0 });

  mockPabiloResult = {
    found: true,
    isNew: true,
    reportedAmount: 6000,
    amountVerifiedByProvider: true,
    raw: { ok: true },
  };

  await ordersService.verifyPayment(
    { uid: 'user-1', email: 'test@example.com', role: 'user', displayName: 'Test' },
    'ord-mix',
    '44556677',
    '127.0.0.1'
  );

  const report = await bankLedger.getLedgerReport({ accountKey: ACTIVE_ACCOUNT_KEY });
  assert.equal(report.movements.length, 1);
  assert.equal(report.summary.totalInflowBs, 6000);
  assert.equal(report.summary.netBalanceBs, 6000);
});

test('3. Pago parcial en 2 referencias (incluyendo sobrepago en la 2da) suma exactamente los Bs reales', async () => {
  seedOrder('ord-partial', {
    pricing: { totalUsd: 1, walletAppliedUsd: 0, amountDueUsd: 1, rate: 1000, totalBs: 1000 },
  });
  store.set('users/user-1', { uid: 'user-1', email: 'test@example.com', walletBalanceUsd: 0 });

  // 1er abono parcial: 400 Bs
  mockPabiloResult = {
    found: true,
    isNew: true,
    reportedAmount: 400,
    amountVerifiedByProvider: false,
    raw: { part: 1 },
  };

  await assert.rejects(
    () =>
      ordersService.verifyPayment(
        { uid: 'user-1', email: 'test@example.com', role: 'user', displayName: 'Test' },
        'ord-partial',
        '11112222',
        '127.0.0.1'
      ),
    /Recibimos 400\.00 Bs/
  );

  // 2do pago: 650 Bs cuando faltaban 600 Bs (50 Bs de sobrepago)
  mockPabiloResult = {
    found: true,
    isNew: true,
    reportedAmount: 650,
    amountVerifiedByProvider: false,
    raw: { part: 2 },
  };

  await ordersService.verifyPayment(
    { uid: 'user-1', email: 'test@example.com', role: 'user', displayName: 'Test' },
    'ord-partial',
    '33334444',
    '127.0.0.1'
  );

  const report = await bankLedger.getLedgerReport({ accountKey: ACTIVE_ACCOUNT_KEY });
  assert.equal(report.movements.length, 2);
  assert.equal(report.summary.totalInflowBs, 1050);
  assert.equal(report.summary.netBalanceBs, 1050);
});

test('4. Excluye binance_pay y wallet; reembolso en RefillCoins NO resta del bankLedger', async () => {
  const binance = await bankLedger.recordInflow({
    bankSnapshot: { code: '', name: 'Binance Pay', idNumber: '', phone: '' },
    paymentMethod: 'binance_pay',
    amountBs: 5000,
    source: 'web',
    orderId: 'ord-bin',
    reference: 'BIN9999',
  });
  const walletOnly = await bankLedger.recordInflow({
    paymentMethod: 'wallet',
    amountBs: 2000,
    source: 'web',
    orderId: 'ord-wal',
    reference: 'WAL9999',
  });

  assert.equal(binance.recorded, false);
  assert.equal(walletOnly.recorded, false);

  // Orden pagada en Bs por Pago Móvil y luego reembolsada a RefillCoins
  seedOrder('ord-ref', {
    status: 'in_review',
    payment: {
      method: 'pagomovil_bdv',
      reference: '77778888',
      reportedAmountBs: 2500,
      paidBs: 2500,
      verifiedAt: Timestamp.now(),
    },
    pricing: { totalUsd: 2.5, amountDueUsd: 2.5, rate: 1000, totalBs: 2500 },
  });
  store.set('users/user-1', { uid: 'user-1', email: 'test@example.com', walletBalanceUsd: 0 });

  await bankLedger.recordInflow({
    paymentMethod: 'pagomovil_bdv',
    amountBs: 2500,
    source: 'web',
    orderId: 'ord-ref',
    orderCode: 'RF-REF',
    reference: '77778888',
  });

  await ordersService.refundOrder('ord-ref', 'Producto agotado', {
    actor: { uid: 'admin-1', email: 'admin@example.com', role: 'admin', displayName: 'Admin' },
    toWallet: true,
  });

  const report = await bankLedger.getLedgerReport({ accountKey: ACTIVE_ACCOUNT_KEY });
  assert.equal(report.summary.totalInflowBs, 2500);
  assert.equal(report.summary.netBalanceBs, 2500);
});

test('5. Unifica cuenta entre Pago Móvil Web, Transferencia sin teléfono y WhatsApp, y calcula retiros', async () => {
  // Transferencia (phone vacío, cédula con puntos)
  const tr = await bankLedger.recordInflow({
    bankSnapshot: {
      code: '0102',
      name: 'Banco de Venezuela',
      idNumber: 'V-32.463.319',
      phone: '',
      accountNumber: '01020471270000600934',
    },
    paymentMethod: 'transfer',
    amountBs: 3000,
    source: 'manual_transfer',
    orderId: 'ord-tr',
    reference: '99110022',
  });
  assert.equal(tr.accountKey, ACTIVE_ACCOUNT_KEY);

  // WhatsApp
  await whatsappSync.syncWhatsappOrder({
    referencia: '88110022',
    clienteContacto: '04125556677',
    juego: 'Blood Strike',
    paqueteNombre: '100+5 Oro',
    montoBs: 1500,
    tasaBcv: 1000,
    tipoDespacho: 'AUTOMATICO',
    estado: 'COMPLETADO',
    bankSnapshot: { code: '0102', name: 'Banco de Venezuela', idNumber: 'V32463319', phone: '04222003851' },
  });

  // Retiro
  const wd = await bankLedger.recordWithdrawal({
    accountKey: ACTIVE_ACCOUNT_KEY,
    amountBs: 1200.5,
    note: 'Cambio a USDT',
    reference: 'RET-01',
    createdBy: 'admin@example.com',
  });

  let report = await bankLedger.getLedgerReport({ accountKey: ACTIVE_ACCOUNT_KEY });
  assert.equal(report.summary.totalInflowBs, 4500);
  assert.equal(report.summary.totalWithdrawalBs, 1200.5);
  assert.equal(report.summary.netBalanceBs, 3299.5);
  assert.equal(report.summary.todayInflowBs, 4500);
  assert.equal(report.summary.manualTransferInflowCount, 1);
  assert.equal(report.summary.whatsappInflowCount, 1);
  assert.equal(report.summary.withdrawalCount, 1);

  // No permite eliminar un ingreso verificado
  await assert.rejects(
    () => bankLedger.deleteWithdrawal(`inflow_${ACTIVE_ACCOUNT_KEY}_99110022`),
    /Solo se pueden eliminar retiros manuales/
  );

  // Sí permite eliminar el retiro
  await bankLedger.deleteWithdrawal(wd.id);
  report = await bankLedger.getLedgerReport({ accountKey: ACTIVE_ACCOUNT_KEY });
  assert.equal(report.summary.totalWithdrawalBs, 0);
  assert.equal(report.summary.netBalanceBs, 4500);
});
