const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock with real transaction serialization & rollback
// ---------------------------------------------------------------------------
const store = new Map();
let autoIdCounter = 0;
let txChain = Promise.resolve();
let failNextOrderSetInTx = false;

function clone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
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
    if (
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
  const exists = store.has(docPath);
  const raw = exists ? clone(store.get(docPath)) : undefined;
  return {
    id,
    exists,
    data: () => (exists ? clone(raw) : undefined),
    get: (field) => (exists ? getByPath(raw, field) : undefined),
  };
}

function makeDocRef(docPath) {
  const id = docPath.split('/').pop();
  return {
    id,
    path: docPath,
    firestore: mockDb,
    collection: (subName) => makeCollectionRef(`${docPath}/${subName}`),
    get: async () => makeSnap(docPath),
    set: async (data, options) => {
      if (options && options.merge) {
        store.set(docPath, deepMerge(store.get(docPath), data));
      } else {
        store.set(docPath, clone(data));
      }
    },
    update: async (data) => {
      const current = clone(store.get(docPath) || {});
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let cursor = current;
          for (let i = 0; i < parts.length - 1; i += 1) {
            cursor[parts[i]] = clone(cursor[parts[i]] || {});
            cursor = cursor[parts[i]];
          }
          cursor[parts[parts.length - 1]] = clone(v);
        } else {
          current[k] = clone(v);
        }
      }
      store.set(docPath, current);
    },
    delete: async () => {
      store.delete(docPath);
    },
  };
}

function makeQuery(colPath, filters = [], limitCount = null) {
  return {
    where: (field, op, value) => makeQuery(colPath, [...filters, { field, op, value }], limitCount),
    orderBy: () => makeQuery(colPath, filters, limitCount),
    limit: (n) => makeQuery(colPath, filters, n),
    select: () => makeQuery(colPath, filters, limitCount),
    count: () => ({
      get: async () => {
        const snap = await makeQuery(colPath, filters, limitCount).get();
        return { data: () => ({ count: snap.size }) };
      },
    }),
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
          if (op === '<=') return toComparable(docVal) !== null && toComparable(docVal) !== undefined && toComparable(docVal) <= toComparable(value);
          if (op === '<') return toComparable(docVal) !== null && toComparable(docVal) !== undefined && toComparable(docVal) < toComparable(value);
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
            throw new Error('Firestore transactions require all reads to be executed before all writes.');
          }
          return makeSnap(ref.path);
        },
        set: (ref, data, options) => {
          hasWritten = true;
          stagedWrites.push(async () => {
            if (failNextOrderSetInTx && ref.path.startsWith('orders/')) {
              failNextOrderSetInTx = false;
              throw new Error('Simulated order write failure in transaction');
            }
            return ref.set(data, options);
          });
        },
        update: (ref, data) => {
          hasWritten = true;
          stagedWrites.push(() => ref.update(data));
        },
        create: (ref, data) => {
          hasWritten = true;
          stagedWrites.push(() => {
            if (store.has(ref.path)) throw new Error('Document already exists');
            return ref.set(data);
          });
        },
      };
      const snapshotBefore = new Map(Array.from(store.entries()).map(([k, v]) => [k, clone(v)]));
      try {
        const result = await fn(tx);
        for (const apply of stagedWrites) {
          await apply();
        }
        return result;
      } catch (err) {
        // Atomic rollback of in-memory store
        store.clear();
        for (const [k, v] of snapshotBefore.entries()) {
          store.set(k, v);
        }
        throw err;
      }
    });
    txChain = run.catch(() => {});
    return run;
  },
};

// ---------------------------------------------------------------------------
// Stub firebase.js and external side-effect modules in require.cache
// ---------------------------------------------------------------------------
const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    auth: {},
    COLLECTIONS: {
      games: 'games',
      products: 'products',
      orders: 'orders',
      users: 'users',
      coupons: 'coupons',
      config: 'config',
      auditLogs: 'auditLogs',
      tickets: 'tickets',
      paymentRefs: 'paymentRefs',
      rateHistory: 'rateHistory',
      rateLimits: 'rateLimits',
      stats: 'stats',
      adminAlerts: 'adminAlerts',
      creators: 'creators',
      creatorCodes: 'creatorCodes',
      modals: 'modals',
      providerOrders: 'providerOrders',
      playerIdCache: 'playerIdCache',
    },
    CONFIG_DOC_ID: 'app',
    games: () => mockDb.collection('games'),
    products: () => mockDb.collection('products'),
    orders: () => mockDb.collection('orders'),
    users: () => mockDb.collection('users'),
    coupons: () => mockDb.collection('coupons'),
    auditLogs: () => mockDb.collection('auditLogs'),
    tickets: () => mockDb.collection('tickets'),
    paymentRefs: () => mockDb.collection('paymentRefs'),
    rateHistory: () => mockDb.collection('rateHistory'),
    rateLimits: () => mockDb.collection('rateLimits'),
    adminAlerts: () => mockDb.collection('adminAlerts'),
    creators: () => mockDb.collection('creators'),
    creatorCodes: () => mockDb.collection('creatorCodes'),
    modals: () => mockDb.collection('modals'),
    providerOrders: () => mockDb.collection('providerOrders'),
    playerIdCache: () => mockDb.collection('playerIdCache'),
    configDoc: () => mockDb.collection('config').doc('app'),
    privateChatbotConfigDoc: () => mockDb.collection('privateConfig').doc('chatbot'),
    dailyStats: () => mockDb.collection('stats').doc('daily').collection('days'),
    now: () => Timestamp.now(),
    timestampFromDate: (d) => Timestamp.fromDate(d),
    minutesFromNow: (m) => Timestamp.fromMillis(Date.now() + m * 60_000),
    Timestamp,
  },
};

const stubModule = (relPath, exportsObj) => {
  const full = path.resolve(__dirname, relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
};

const dispatchedOrderIds = [];
const manualPreparedOrderIds = [];

stubModule('../lib/services/centralOne.js', {
  productUsesCentralOne: () => false,
  getLiveCatalogStockMap: async () => new Map(),
  resolveProductLiveAvailability: () => ({ checked: false, available: true, stock: null }),
  buildCacheKey: (gameId, p1, p2) => `${gameId}_${p1}_${p2 || ''}`,
});

stubModule('../lib/services/dispatch.js', {
  buildCallPlan: (calls) => calls || [],
  dispatchOrder: async (orderId) => {
    dispatchedOrderIds.push(orderId);
  },
  prepareManualOrder: async (orderId) => {
    manualPreparedOrderIds.push(orderId);
  },
});

stubModule('../lib/services/orderEmails.js', {
  sendOrderEmail: async () => {},
});

stubModule('../lib/services/notifications.js', {
  notify: async () => {},
});

stubModule('../lib/services/adminAlerts.js', {
  alert: async () => {},
  checkProviderBalance: async () => {},
});

stubModule('../lib/services/stats.js', {
  trackEvent: async () => {},
  STORE_TIMEZONE: 'America/Caracas',
});

stubModule('../lib/services/audit.js', {
  ACTIONS: {
    ORDER_CREATED: 'order.created',
    ORDER_PAYMENT_VERIFIED: 'order.payment.verified',
    ORDER_DISPATCHED: 'order.dispatched',
    ORDER_DISPATCH_FAILED: 'order.dispatch.failed',
    ORDER_COMPLETED_MANUALLY: 'order.completed.manual',
    ORDER_REFUNDED: 'order.refunded',
    ORDER_CANCELLED: 'order.cancelled',
    ORDER_RETRIED: 'order.retried',
  },
  record: async () => {},
});

stubModule('../lib/services/creators.js', {
  resolveForPurchase: async () => ({ ref: null, creator: { discountPercent: 0 } }),
  accrueCommission: async () => {},
  revertCommission: async () => {},
});

stubModule('../lib/services/settings.js', {
  getConfig: async () => ({
    rate: { value: 50 },
    pricing: { roundToBs: 0.01 },
    bank: { code: '0102', name: 'BDV', idNumber: 'J-123', phone: '04120000000' },
    transfer: {
      enabled: true,
      code: '0102',
      name: 'BDV',
      idNumber: 'J-123',
      accountNumber: '01020000',
      accountType: 'corriente',
    },
    binancePay: { enabled: true, payId: '999888' },
    checkout: {
      walletEnabled: true,
      maxOpenOrdersPerUser: 5,
      orderExpiryMinutes: 20,
      referenceMinLength: 6,
      referenceMaxLength: 14,
      maxVerifyAttempts: 5,
      amountTolerancePercent: 1,
    },
    features: {
      autoDispatchEnabled: true,
      manualProductsEnabled: true,
      couponsEnabled: false,
      creatorsEnabled: false,
      maintenanceMode: false,
    },
    tiers: [],
    whatsapp: { adminNumber: '584120000000', supportNumber: '584120000000' },
  }),
});

const ordersService = require('../lib/services/orders.js');

const TEST_USER = {
  uid: 'user-mix-1',
  email: 'mix@refill.store',
  displayName: 'Mix Buyer',
  photoURL: null,
  role: 'customer',
  isStaff: false,
  isAdmin: false,
};

function seedStore({ walletBalanceUsd = 0, productPriceUsd = 3.0 } = {}) {
  store.clear();
  autoIdCounter = 0;
  failNextOrderSetInTx = false;
  dispatchedOrderIds.length = 0;
  manualPreparedOrderIds.length = 0;

  store.set('games/free-fire', {
    id: 'free-fire',
    name: 'Free Fire',
    slug: 'free-fire',
    active: true,
    provider: 'inefable',
    providerFamily: 'topup',
    requiresPlayerData: true,
    playerFields: [{ key: 'playerId', label: 'ID de jugador', required: true }],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  store.set('products/ff-300', {
    id: 'ff-300',
    gameId: 'free-fire',
    name: '310 Diamantes',
    sku: 'FF310',
    amount: 310,
    bonus: 0,
    priceUsd: productPriceUsd,
    costUsd: 2.0,
    active: true,
    stock: null,
    fulfillment: 'auto',
    provider: 'inefable',
    calls: [{ packageId: 1001, quantity: 1, provider: 'inefable' }],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  const userProfile = {
    uid: TEST_USER.uid,
    email: TEST_USER.email,
    displayName: TEST_USER.displayName,
    photoURL: null,
    role: 'customer',
    tier: 'base',
    walletBalanceUsd,
    totalSpentUsd: 0,
    ordersCount: 0,
    banned: false,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  store.set(`users/${TEST_USER.uid}`, userProfile);

  return userProfile;
}

test('1. Mixed payment with switch at max applies full wallet balance and charges remaining Bs', async () => {
  const profile = seedStore({ walletBalanceUsd: 1.5, productPriceUsd: 3.0 });

  const order = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '123456789' },
    quantity: 1,
    paymentMethod: 'pagomovil_bdv',
    useWallet: true,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });

  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.payment.method, 'pagomovil_bdv');
  assert.equal(order.pricing.totalUsd, 3.0);
  assert.equal(order.pricing.walletAppliedUsd, 1.5);
  assert.equal(order.pricing.amountDueUsd, 1.5);
  assert.equal(order.pricing.totalBs, 75); // 1.5 * 50

  const updatedUser = store.get(`users/${TEST_USER.uid}`);
  assert.equal(updatedUser.walletBalanceUsd, 0);
});

test('2. Mixed payment with custom walletAmountUsd applies requested partial amount', async () => {
  const profile = seedStore({ walletBalanceUsd: 2.5, productPriceUsd: 3.0 });

  const order = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '123456789' },
    quantity: 1,
    paymentMethod: 'binance_pay',
    useWallet: true,
    walletAmountUsd: 1.0,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });

  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.payment.method, 'binance_pay');
  assert.equal(order.pricing.walletAppliedUsd, 1.0);
  assert.equal(order.pricing.amountDueUsd, 2.0);
  assert.equal(order.pricing.totalBs, 100); // 2.0 * 50

  const updatedUser = store.get(`users/${TEST_USER.uid}`);
  assert.equal(updatedUser.walletBalanceUsd, 1.5);
});

test('3. Server clamps excessive walletAmountUsd and ignores walletAmountUsd when useWallet is false', async () => {
  // Clamp against real wallet balance (2.00 < 3.00 < 99.00)
  let profile = seedStore({ walletBalanceUsd: 2.0, productPriceUsd: 3.0 });
  const clampedByBalance = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '123456789' },
    quantity: 1,
    useWallet: true,
    walletAmountUsd: 99.0,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });
  assert.equal(clampedByBalance.pricing.walletAppliedUsd, 2.0);
  assert.equal(clampedByBalance.pricing.amountDueUsd, 1.0);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 0);

  // Clamp against order total when balance exceeds total
  profile = seedStore({ walletBalanceUsd: 10.0, productPriceUsd: 3.0 });
  const splitMax = ordersService.computeWalletSplit({
    useWallet: true,
    walletEnabled: true,
    walletBalanceUsd: 10.0,
    totalUsd: 3.0,
    walletAmountUsd: 5.0,
  });
  assert.equal(splitMax.walletAppliedUsd, 3.0);
  assert.equal(splitMax.amountDueUsd, 0);
  assert.equal(splitMax.paidWithWallet, true);

  // Ignored when useWallet === false
  const noWalletOrder = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '123456789' },
    quantity: 1,
    useWallet: false,
    walletAmountUsd: 2.0,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });
  assert.equal(noWalletOrder.pricing.walletAppliedUsd, 0);
  assert.equal(noWalletOrder.pricing.amountDueUsd, 3.0);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 10.0);
});

test('4. 100% wallet payment sets amountDueUsd=0, totalBs=0, method=wallet, status=paid and dispatches', async () => {
  const profile = seedStore({ walletBalanceUsd: 5.0, productPriceUsd: 3.0 });

  const order = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '123456789' },
    quantity: 1,
    paymentMethod: 'pagomovil_bdv',
    useWallet: true,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });

  assert.equal(order.status, 'paid');
  assert.equal(order.payment.method, 'wallet');
  assert.equal(order.pricing.walletAppliedUsd, 3.0);
  assert.equal(order.pricing.amountDueUsd, 0);
  assert.equal(order.pricing.totalBs, 0);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 2.0);
  assert.deepEqual(dispatchedOrderIds, [order.id]);
});

test('5. Cancelling or expiring a mixed order refunds walletAppliedUsd idempotently', async () => {
  const profile = seedStore({ walletBalanceUsd: 2.0, productPriceUsd: 3.0 });

  // Part A: Customer cancels mixed order
  const cancelledOrder = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '123456789' },
    quantity: 1,
    useWallet: true,
    walletAmountUsd: 1.25,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 0.75);

  const afterCancel = await ordersService.cancelOrder(TEST_USER, cancelledOrder.id);
  assert.equal(afterCancel.status, 'cancelled');
  assert.equal(afterCancel.pricing.walletRefunded, true);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 2.0);

  // Calling refundWalletIfApplied again does not double-credit
  const duplicateRefund = await ordersService.refundWalletIfApplied(afterCancel, 'duplicate check');
  assert.equal(duplicateRefund, 0);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 2.0);

  // Part B: Stale mixed order expires via expireStaleOrders
  const staleOrder = await ordersService.createOrder(TEST_USER, profile, {
    gameId: 'free-fire',
    productId: 'ff-300',
    playerFields: { playerId: '987654321' },
    quantity: 1,
    useWallet: true,
    walletAmountUsd: 1.5,
    ip: '127.0.0.1',
    userAgent: 'node-test',
  });
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 0.5);

  // Force expiration timestamp in the past
  const storedOrder = store.get(`orders/${staleOrder.id}`);
  storedOrder.expiresAt = Timestamp.fromMillis(Date.now() - 60_000);
  store.set(`orders/${staleOrder.id}`, storedOrder);

  const expiredCount = await ordersService.expireStaleOrders(10);
  assert.equal(expiredCount, 1);
  assert.equal(store.get(`orders/${staleOrder.id}`).status, 'expired');
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 2.0);

  // Second sweep does not double-refund
  const secondSweep = await ordersService.expireStaleOrders(10);
  assert.equal(secondSweep, 0);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 2.0);
});

test('6. Transaction atomicity prevents wallet deduction on write failure and blocks double spend under concurrency', async () => {
  // Part A: Rollback when order write fails inside transaction
  const profile = seedStore({ walletBalanceUsd: 3.0, productPriceUsd: 3.0 });
  failNextOrderSetInTx = true;

  await assert.rejects(
    ordersService.createOrder(TEST_USER, profile, {
      gameId: 'free-fire',
      productId: 'ff-300',
      playerFields: { playerId: '123456789' },
      quantity: 1,
      useWallet: true,
      walletAmountUsd: 2.0,
      ip: '127.0.0.1',
      userAgent: 'node-test',
    }),
    /Simulated order write failure/
  );
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 3.0);

  // Part B: Two concurrent createOrder calls sharing $3.00 balance with custom $2.00 request
  const [first, second] = await Promise.all([
    ordersService.createOrder(TEST_USER, profile, {
      gameId: 'free-fire',
      productId: 'ff-300',
      playerFields: { playerId: '111111111' },
      quantity: 1,
      useWallet: true,
      walletAmountUsd: 2.0,
      ip: '127.0.0.1',
      userAgent: 'node-test',
    }),
    ordersService.createOrder(TEST_USER, profile, {
      gameId: 'free-fire',
      productId: 'ff-300',
      playerFields: { playerId: '222222222' },
      quantity: 1,
      useWallet: true,
      walletAmountUsd: 2.0,
      ip: '127.0.0.1',
      userAgent: 'node-test',
    }),
  ]);

  const appliedSum = first.pricing.walletAppliedUsd + second.pricing.walletAppliedUsd;
  assert.equal(appliedSum, 3.0);
  assert.equal(store.get(`users/${TEST_USER.uid}`).walletBalanceUsd, 0);
});
