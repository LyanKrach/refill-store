'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PROJECT_ID = 'refill-e254f';
const DEFAULT_BASE_URL = 'https://portal.centraloneglobal.com/api/v1';
const MIN_LIVE_CATALOG_ITEMS = 1000;
const BATCH_LIMIT = 400;
const OPEN_ORDER_STATUSES = [
  'awaiting_payment',
  'verifying',
  'paid',
  'dispatching',
  'awaiting_manual',
  'in_review',
  'failed',
];
const STREAMING_RE =
  /netflix|spotify|disney|\bhbo\b|\bmax\b|prime video|paramount|crunchyroll|youtube|deezer|apple tv|star\+|vix|streaming/i;

const BACKUPS_DIR = path.resolve(__dirname, '../../backups');

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function toMap(input) {
  if (input instanceof Map) return input;
  const map = new Map();
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      map.set(k, v);
    }
  }
  return map;
}

function toSet(input) {
  if (input instanceof Set) return input;
  if (Array.isArray(input)) return new Set(input.map((v) => String(v).trim()).filter(Boolean));
  return new Set();
}

function coIds(product) {
  if (!product || typeof product !== 'object') return [];
  const ids = [];
  const seen = new Set();
  const add = (val) => {
    if (val === null || val === undefined) return;
    const str = String(val).trim();
    if (!str || seen.has(str)) return;
    seen.add(str);
    ids.push(str);
  };
  if (Array.isArray(product.calls)) {
    for (const call of product.calls) {
      if (!call || typeof call !== 'object') continue;
      const effProvider = call.provider ?? product.provider;
      if (effProvider === 'centralone') {
        add(call.packageId);
      }
    }
  }
  if (product.provider === 'centralone') {
    add(product.providerOfferId);
  }
  return ids;
}

function validPrice(product) {
  return (
    product != null &&
    typeof product.priceUsd === 'number' &&
    Number.isFinite(product.priceUsd) &&
    product.priceUsd > 0
  );
}

function isManual(product) {
  if (!product || typeof product !== 'object') return false;
  if (coIds(product).length > 0) return false;
  return product.fulfillment === 'manual' || !Array.isArray(product.calls) || product.calls.length === 0;
}

function detectProductProvider(id, product, game) {
  if (String(id).startsWith('fz-') || game?.provider === 'fazercards') return 'fazercards';
  if (coIds(product).length > 0 || product?.provider === 'centralone') return 'centralone';
  if (isManual(product)) return 'manual';
  if (
    product?.provider === 'inefable' ||
    game?.provider === 'inefable' ||
    (product?.fulfillment === 'auto' && Array.isArray(product.calls) && product.calls.length > 0)
  ) {
    return 'inefable';
  }
  return 'otro';
}

function timestampMs(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (val instanceof Date) return val.getTime();
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val.seconds === 'number') {
    return val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6);
  }
  if (typeof val._seconds === 'number') {
    return val._seconds * 1000 + Math.floor((val._nanoseconds || 0) / 1e6);
  }
  if (Array.isArray(val.__ts) && val.__ts.length === 2) {
    return val.__ts[0] * 1000 + Math.floor(val.__ts[1] / 1e6);
  }
  return 0;
}

function coSignature(product) {
  const sigs = [];
  if (Array.isArray(product.calls)) {
    for (const call of product.calls) {
      if (!call || typeof call !== 'object') continue;
      const effProvider = call.provider ?? product.provider;
      if (effProvider === 'centralone' && call.packageId !== undefined && call.packageId !== null) {
        const pkgId = String(call.packageId).trim();
        if (pkgId) sigs.push(`${pkgId}:${Number(call.quantity ?? 1)}`);
      }
    }
  }
  if (sigs.length === 0 && product.provider === 'centralone' && product.providerOfferId) {
    sigs.push(`${String(product.providerOfferId).trim()}:1`);
  }
  sigs.sort();
  return sigs.join('|');
}

function isSellableProduct(product) {
  return (
    product != null &&
    product.active === true &&
    product.adminDisabled !== true &&
    product.providerRemoved !== true &&
    validPrice(product)
  );
}

// ---------------------------------------------------------------------------
// Clasificador puro e invariantes
// ---------------------------------------------------------------------------

function classifyCatalog(input) {
  const games = toMap(input.games);
  const products = toMap(input.products);
  const live = toMap(input.live);
  const openOrderGameIds = toSet(input.openOrderGameIds);
  const openOrderProductIds = toSet(input.openOrderProductIds);
  const alsoDelete = toSet(input.alsoDelete);
  const keep = toSet(input.keep);
  const mappedOfferIds = toSet(input.mappedOfferIds);
  const mappedGameIds = toSet(input.mappedGameIds);

  // Evitar que --also-delete fuerce el borrado de algo con órdenes abiertas.
  for (const id of alsoDelete) {
    if (openOrderGameIds.has(id) || openOrderProductIds.has(id)) {
      throw new Error(`No se puede incluir "${id}" en --also-delete porque tiene órdenes abiertas.`);
    }
  }

  const productDecisions = new Map();

  for (const [id, p] of products) {
    const gameId = typeof p?.gameId === 'string' ? p.gameId : '';
    const game = gameId ? games.get(gameId) : undefined;
    let decision;

    if (keep.has(id)) {
      decision = { action: 'protect', reason: 'forzado_keep' };
    } else if (openOrderProductIds.has(id)) {
      decision = { action: 'review', reason: 'orden_abierta' };
    } else if (alsoDelete.has(id) || (gameId && alsoDelete.has(gameId))) {
      decision = { action: 'delete', reason: 'aprobado_por_usuario' };
    } else if (!gameId || !game) {
      if (isManual(p) && p.active === true) {
        decision = { action: 'review', reason: 'huerfano_manual_activo' };
      } else {
        decision = { action: 'delete', reason: 'huerfano_sin_juego' };
      }
    } else if (id.startsWith('fz-') || (game.provider === 'fazercards' && game.manual !== true)) {
      decision = { action: 'delete', reason: 'proveedor_viejo_fazercards' };
    } else {
      const cIds = coIds(p);
      if (cIds.length > 0) {
        const allMapped = mappedOfferIds.size > 0 && cIds.every((cid) => mappedOfferIds.has(cid));
        if (cIds.some((cid) => !live.has(cid))) {
          decision = { action: 'delete', reason: 'co_sku_inexistente' };
        } else if (cIds.some((cid) => live.get(cid)?.status !== 'active')) {
          decision = { action: 'delete', reason: 'co_desactivado' };
        } else if (allMapped) {
          if (!validPrice(p)) {
            decision = { action: 'review', reason: 'co_vivo_precio_invalido' };
          } else if (p.providerRemoved === true) {
            decision = { action: 'protect', reason: 'co_recuperado_por_nuevo_mapeo' };
          } else {
            decision = { action: 'protect', reason: 'co_vivo' };
          }
        } else if (p.providerRemoved === true) {
          decision = { action: 'delete', reason: 'co_retirado_por_sync' };
        } else if (!validPrice(p)) {
          decision = { action: 'review', reason: 'co_vivo_precio_invalido' };
        } else {
          decision = { action: 'protect', reason: 'co_vivo' };
        }
      } else if (p.provider === 'centralone') {
        decision = { action: 'review', reason: 'co_sin_ids' };
      } else if (isManual(p)) {
        if (p.active === true && validPrice(p)) {
          decision = { action: 'protect', reason: 'manual_activo' };
        } else {
          decision = { action: 'review', reason: 'manual_inactivo_o_sin_precio' };
        }
      } else {
        // Productos automáticos no-CO = legado Inefable
        if (game.active === true) {
          decision = { action: 'review', reason: 'inefable_en_juego_activo' };
        } else {
          decision = { action: 'delete', reason: 'proveedor_viejo_inefable' };
        }
      }

      if (
        decision.action === 'protect' &&
        decision.reason !== 'forzado_keep' &&
        cIds.length === 0 &&
        !isManual(p) &&
        !validPrice(p)
      ) {
        decision = { action: 'delete', reason: 'precio_invalido' };
      }
    }

    // Guardia de streaming activo
    if (
      decision.action === 'delete' &&
      game &&
      STREAMING_RE.test(game.name || '') &&
      p.active === true &&
      game.active === true
    ) {
      decision = { action: 'review', reason: 'streaming_activo' };
    }

    productDecisions.set(id, decision);
  }

  // Pase de duplicados (solo productos no borrados con coIds)
  const dupGroups = new Map();
  for (const [id, p] of products) {
    const decision = productDecisions.get(id);
    if (!decision || decision.action === 'delete') continue;
    const cIds = coIds(p);
    if (cIds.length === 0) continue;
    const sig = coSignature(p);
    if (!sig) continue;
    const groupKey = `${p.gameId}::${sig}`;
    if (!dupGroups.has(groupKey)) dupGroups.set(groupKey, []);
    dupGroups.get(groupKey).push({ id, data: p, decision });
  }

  const isPinnedDecision = (dec) =>
    dec.reason === 'forzado_keep' || dec.reason === 'orden_abierta' || dec.reason === 'streaming_activo';

  for (const items of dupGroups.values()) {
    if (items.length <= 1) continue;
    const activeItems = items.filter((item) => item.data.active === true);
    if (activeItems.length === 1) {
      for (const item of items) {
        if (item.data.active === true) continue;
        if (isPinnedDecision(item.decision)) continue;
        productDecisions.set(item.id, { action: 'delete', reason: 'duplicado_residual' });
      }
    } else if (activeItems.length === 0) {
      items.sort((a, b) => {
        const pinDiff = (isPinnedDecision(b.decision) ? 1 : 0) - (isPinnedDecision(a.decision) ? 1 : 0);
        if (pinDiff !== 0) return pinDiff;
        const tsDiff = timestampMs(b.data.updatedAt) - timestampMs(a.data.updatedAt);
        if (tsDiff !== 0) return tsDiff;
        return a.id.localeCompare(b.id);
      });
      for (let i = 1; i < items.length; i += 1) {
        if (isPinnedDecision(items[i].decision)) continue;
        productDecisions.set(items[i].id, { action: 'delete', reason: 'duplicado_residual' });
      }
    } else {
      for (const item of items) {
        if (isPinnedDecision(item.decision)) continue;
        productDecisions.set(item.id, { action: 'review', reason: 'duplicado_ambos_activos' });
      }
    }
  }

  // Agrupar productos por juego para decidir el destino de cada juego
  const productsByGame = new Map();
  for (const [id, p] of products) {
    const gameId = typeof p?.gameId === 'string' ? p.gameId : '';
    if (!gameId) continue;
    if (!productsByGame.has(gameId)) productsByGame.set(gameId, []);
    productsByGame.get(gameId).push({
      id,
      data: p,
      decision: productDecisions.get(id),
    });
  }

  const gameDecisions = new Map();

  for (const [id, g] of games) {
    const gameProds = productsByGame.get(id) || [];
    const surviving = gameProds.filter((item) => item.decision.action !== 'delete');
    const sellable = surviving.filter((item) => isSellableProduct(item.data));

    let decision;
    if (keep.has(id)) {
      decision = { action: 'protect', reason: 'forzado_keep' };
    } else if (openOrderGameIds.has(id)) {
      if (alsoDelete.has(id)) {
        throw new Error(`No se puede eliminar el juego "${id}" porque tiene órdenes abiertas.`);
      }
      decision = { action: 'review', reason: 'orden_abierta' };
    } else if (alsoDelete.has(id)) {
      for (const item of gameProds) {
        if (openOrderProductIds.has(item.id)) {
          throw new Error(
            `No se puede eliminar el juego "${id}" porque su producto "${item.id}" tiene órdenes abiertas.`
          );
        }
        if (keep.has(item.id)) {
          throw new Error(
            `Conflicto entre --also-delete="${id}" y --keep="${item.id}".`
          );
        }
        productDecisions.set(item.id, { action: 'delete', reason: 'aprobado_por_usuario' });
      }
      decision = { action: 'delete', reason: 'aprobado_por_usuario' };
    } else if (g?.manual === true) {
      if (surviving.length === 0) {
        decision = { action: 'review', reason: 'manual_sin_paquetes' };
      } else {
        decision = { action: 'protect', reason: 'manual_activo' };
      }
    } else if (STREAMING_RE.test(g?.name || '') && g?.active === true) {
      decision = { action: 'protect', reason: 'streaming_activo' };
    } else if (surviving.length === 0) {
      if (mappedGameIds.has(id)) {
        decision = { action: 'review', reason: 'co_recuperable_por_sync' };
      } else if (id.startsWith('fz-') || g?.provider === 'fazercards') {
        decision = { action: 'delete', reason: 'proveedor_viejo_fazercards' };
      } else if (id.startsWith('co-') && g?.providerRemoved === true) {
        decision = { action: 'delete', reason: 'co_retirado_del_catalogo' };
      } else if (g?.provider === 'inefable' || !g?.provider) {
        decision = { action: 'delete', reason: 'proveedor_viejo_inefable' };
      } else {
        decision = { action: 'delete', reason: 'cascaron_sin_paquetes' };
      }
    } else if (surviving.some((item) => item.decision.reason === 'co_recuperado_por_nuevo_mapeo') && sellable.length === 0) {
      decision = { action: 'protect', reason: 'co_recuperado_por_nuevo_mapeo' };
    } else if (surviving.some((item) => item.decision.action === 'review') && sellable.length === 0) {
      decision = { action: 'review', reason: 'solo_quedan_paquetes_dudosos' };
    } else if (g?.active === false && !g?.hiddenReason && surviving.length > 0) {
      decision = { action: 'review', reason: 'pausado_por_admin' };
    } else if (id.startsWith('co-') && surviving.length > 0 && sellable.length === 0) {
      decision = { action: 'keep', reason: 'co_agotado_temporal' };
    } else {
      decision = { action: 'protect', reason: 'vendible' };
    }

    gameDecisions.set(id, decision);
  }

  const stats = computeStats({ games, products, gameDecisions, productDecisions });
  const result = {
    games: gameDecisions,
    products: productDecisions,
    stats,
  };

  assertSafe(
    { games, products, live, openOrderGameIds, openOrderProductIds, mappedOfferIds },
    result
  );

  return result;
}

function computeStats({ games, products, gameDecisions, productDecisions }) {
  const gameActions = { delete: 0, review: 0, protect: 0, keep: 0 };
  const gameDeleteByReason = {};
  const productActions = { delete: 0, review: 0, protect: 0, keep: 0 };
  const productDeleteByReason = {};
  const productDeleteByProvider = {};

  for (const [id, dec] of gameDecisions) {
    gameActions[dec.action] = (gameActions[dec.action] || 0) + 1;
    if (dec.action === 'delete') {
      gameDeleteByReason[dec.reason] = (gameDeleteByReason[dec.reason] || 0) + 1;
    }
    void id;
  }

  for (const [id, dec] of productDecisions) {
    productActions[dec.action] = (productActions[dec.action] || 0) + 1;
    if (dec.action === 'delete') {
      productDeleteByReason[dec.reason] = (productDeleteByReason[dec.reason] || 0) + 1;
      const p = products.get(id);
      const game = p?.gameId ? games.get(p.gameId) : undefined;
      const prov = detectProductProvider(id, p, game);
      productDeleteByProvider[prov] = (productDeleteByProvider[prov] || 0) + 1;
    }
  }

  return {
    totalGames: games.size,
    totalProducts: products.size,
    survivingGames: games.size - gameActions.delete,
    survivingProducts: products.size - productActions.delete,
    gameActions,
    productActions,
    gameDeleteByReason,
    productDeleteByReason,
    productDeleteByProvider,
  };
}

function assertSafe(ctx, classification) {
  const games = toMap(ctx.games);
  const products = toMap(ctx.products);
  const live = toMap(ctx.live);
  const openOrderGameIds = toSet(ctx.openOrderGameIds);
  const openOrderProductIds = toSet(ctx.openOrderProductIds);
  const mappedOfferIds = toSet(ctx.mappedOfferIds);

  const productsByGame = new Map();
  for (const [id, p] of products) {
    const gid = typeof p?.gameId === 'string' ? p.gameId : '';
    if (!gid) continue;
    if (!productsByGame.has(gid)) productsByGame.set(gid, []);
    productsByGame.get(gid).push(id);
  }

  for (const [id, dec] of classification.products) {
    const p = products.get(id);
    if (!p) continue;
    const game = p.gameId ? games.get(p.gameId) : undefined;
    if (dec.action !== 'delete') continue;

    if (openOrderProductIds.has(id)) {
      throw new Error(`Invariante violado: el producto "${id}" tiene una orden abierta y quedó marcado para borrar.`);
    }

    const cIds = coIds(p);
    if (
      cIds.length > 0 &&
      dec.reason !== 'duplicado_residual' &&
      dec.reason !== 'aprobado_por_usuario' &&
      mappedOfferIds.size > 0 &&
      cIds.every((cid) => mappedOfferIds.has(cid))
    ) {
      throw new Error(`Invariante violado: producto CO cubierto por el nuevo mapeo "${id}" marcado para borrar (${dec.reason}).`);
    }

    if (
      cIds.length > 0 &&
      dec.reason !== 'duplicado_residual' &&
      dec.reason !== 'aprobado_por_usuario' &&
      p.providerRemoved !== true &&
      cIds.every((cid) => live.has(cid) && live.get(cid)?.status === 'active')
    ) {
      throw new Error(`Invariante violado: producto CO vivo "${id}" marcado para borrar (${dec.reason}).`);
    }

    if (isManual(p) && p.active === true && dec.reason !== 'aprobado_por_usuario') {
      throw new Error(`Invariante violado: producto manual activo "${id}" marcado para borrar (${dec.reason}).`);
    }

    if (game && STREAMING_RE.test(game.name || '') && p.active === true && game.active === true) {
      throw new Error(`Invariante violado: producto streaming activo "${id}" marcado para borrar.`);
    }
  }

  for (const [id, dec] of classification.games) {
    const g = games.get(id);
    if (!g || dec.action !== 'delete') continue;

    if (openOrderGameIds.has(id)) {
      throw new Error(`Invariante violado: el juego "${id}" tiene una orden abierta y quedó marcado para borrar.`);
    }

    if (STREAMING_RE.test(g.name || '') && g.active === true) {
      throw new Error(`Invariante violado: juego streaming activo "${id}" marcado para borrar.`);
    }

    const childIds = productsByGame.get(id) || [];
    for (const childId of childIds) {
      const childDec = classification.products.get(childId);
      if (!childDec || childDec.action !== 'delete') {
        throw new Error(
          `Invariante violado: juego "${id}" marcado para borrar pero su producto "${childId}" no se borra (${childDec?.action}:${childDec?.reason}).`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Serialización de respaldo y formateo
// ---------------------------------------------------------------------------

function serializeValue(val) {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) {
    const ms = val.getTime();
    return { __ts: [Math.floor(ms / 1000), (ms % 1000) * 1e6] };
  }
  if (
    typeof val === 'object' &&
    !Array.isArray(val) &&
    typeof val.seconds === 'number' &&
    typeof val.nanoseconds === 'number' &&
    typeof val.toDate === 'function'
  ) {
    return { __ts: [val.seconds, val.nanoseconds] };
  }
  if (
    typeof val === 'object' &&
    !Array.isArray(val) &&
    typeof val._seconds === 'number' &&
    typeof val._nanoseconds === 'number'
  ) {
    return { __ts: [val._seconds, val._nanoseconds] };
  }
  if (Array.isArray(val)) return val.map(serializeValue);
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) out[k] = serializeValue(v);
    }
    return out;
  }
  return val;
}

function deserializeValue(val, TimestampClass) {
  if (val === null || val === undefined) return val;
  if (
    typeof val === 'object' &&
    !Array.isArray(val) &&
    Array.isArray(val.__ts) &&
    val.__ts.length === 2 &&
    typeof val.__ts[0] === 'number' &&
    typeof val.__ts[1] === 'number'
  ) {
    return new TimestampClass(val.__ts[0], val.__ts[1]);
  }
  if (Array.isArray(val)) return val.map((item) => deserializeValue(item, TimestampClass));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) out[k] = deserializeValue(v, TimestampClass);
    }
    return out;
  }
  return val;
}

function formatFileStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-');
}

// ---------------------------------------------------------------------------
// Argumentos CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    apply: false,
    dryRun: true,
    confirm: null,
    alsoDelete: new Set(),
    keep: new Set(),
    restore: null,
  };
  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
      opts.dryRun = false;
    } else if (arg === '--dry-run') {
      opts.apply = false;
      opts.dryRun = true;
    } else if (arg.startsWith('--confirm=')) {
      opts.confirm = arg.slice('--confirm='.length).trim();
    } else if (arg.startsWith('--also-delete=')) {
      for (const id of arg.slice('--also-delete='.length).split(',')) {
        const clean = id.trim();
        if (clean) opts.alsoDelete.add(clean);
      }
    } else if (arg.startsWith('--keep=')) {
      for (const id of arg.slice('--keep='.length).split(',')) {
        const clean = id.trim();
        if (clean) opts.keep.add(clean);
      }
    } else if (arg.startsWith('--restore=')) {
      opts.restore = arg.slice('--restore='.length).trim();
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Flag no reconocido: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Carga externa (Central One + Firestore)
// ---------------------------------------------------------------------------

async function fetchLiveCentralOneCatalog() {
  const apiKey = (process.env.CENTRAL_ONE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Falta la variable de entorno CENTRAL_ONE_API_KEY.');
  }
  const baseUrl = (process.env.CENTRAL_ONE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/catalog`;

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`Central One /catalog respondió HTTP ${res.status}`);
      }
      const json = await res.json();
      const items = Array.isArray(json?.items) ? json.items : null;
      if (!items) {
        throw new Error('La respuesta de Central One /catalog no contiene `items`.');
      }
      if (items.length < MIN_LIVE_CATALOG_ITEMS) {
        throw new Error(
          `Catálogo sospechosamente pequeño (${items.length} < ${MIN_LIVE_CATALOG_ITEMS}); se aborta por seguridad.`
        );
      }
      const live = new Map();
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const pid = item.product_id != null ? String(item.product_id).trim() : '';
        if (!pid) continue;
        live.set(pid, {
          status: String(item.status || ''),
          inStock: item.in_stock !== false,
          sku: item.sku != null ? String(item.sku) : '',
          name: item.name != null ? String(item.name) : '',
        });
      }
      return { live, rawCount: items.length, rawItems: items };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error('No se pudo consultar Central One /catalog.');
}

function initFirebase() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: DEFAULT_PROJECT_ID });
  }
  const db = admin.firestore();
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // Ya configurado
  }
  return { admin, db, Timestamp: admin.firestore.Timestamp, FieldValue: admin.firestore.FieldValue };
}

async function restoreFromBackup(restorePath) {
  const resolved = fs.existsSync(restorePath)
    ? path.resolve(restorePath)
    : path.resolve(BACKUPS_DIR, restorePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No existe el archivo de respaldo: ${restorePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const deletedGames = Array.isArray(raw?.deleted?.games) ? raw.deleted.games : [];
  const deletedProducts = Array.isArray(raw?.deleted?.products) ? raw.deleted.products : [];
  const gamesObj = raw?.games || {};
  const productsObj = raw?.products || {};

  const { db, Timestamp } = initFirebase();
  console.log(`Restaurando desde ${resolved}...`);
  console.log(`Docs en lista deleted: ${deletedGames.length} juegos, ${deletedProducts.length} productos.`);

  async function restoreCollection(colName, ids, sourceMap) {
    let restored = 0;
    let skipped = 0;
    let missingInBackup = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const refs = chunk.map((id) => db.collection(colName).doc(id));
      const snaps = await db.getAll(...refs);
      const batch = db.batch();
      let pending = 0;
      for (const snap of snaps) {
        if (snap.exists) {
          skipped += 1;
          continue;
        }
        const docData = sourceMap[snap.id];
        if (!docData) {
          missingInBackup += 1;
          continue;
        }
        batch.create(snap.ref, deserializeValue(docData, Timestamp));
        pending += 1;
        restored += 1;
      }
      if (pending > 0) await batch.commit();
    }
    return { restored, skipped, missingInBackup };
  }

  const gRes = await restoreCollection('games', deletedGames, gamesObj);
  const pRes = await restoreCollection('products', deletedProducts, productsObj);
  console.log('Resultado restauración juegos:', gRes);
  console.log('Resultado restauración productos:', pRes);
}

function loadCentralOneMapper() {
  const { Timestamp } = require('firebase-admin/firestore');
  const fbPath = path.resolve(__dirname, '../lib/config/firebase.js');
  if (!require.cache[fbPath]) {
    require.cache[fbPath] = {
      id: fbPath,
      filename: fbPath,
      loaded: true,
      exports: {
        db: {},
        COLLECTIONS: {},
        now: () => Timestamp.now(),
        Timestamp,
        games: () => ({}),
        products: () => ({}),
        providerSync: () => ({}),
        privateCentralOneConfigDoc: () => ({}),
        privateCentralOneSyncLockDoc: () => ({}),
      },
    };
  }
  return require('../lib/services/centralOneCatalogSync.js').mapCentralOneCatalog;
}

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------

function buildReportData(games, products, classification, liveCount, mappingComparison = null) {
  const { stats } = classification;
  const gamesToDeleteByReason = {};
  const gamesToReview = [];
  const gamesCoOutOfStock = [];
  const streamingActiveGames = [];
  const coVendibleGames = [];

  for (const [id, dec] of classification.games) {
    const g = games.get(id);
    if (dec.action === 'delete') {
      if (!gamesToDeleteByReason[dec.reason]) gamesToDeleteByReason[dec.reason] = [];
      gamesToDeleteByReason[dec.reason].push({
        id,
        name: g?.name || id,
        provider: g?.provider || null,
        active: g?.active === true,
        salesCount: g?.salesCount ?? 0,
      });
    } else if (dec.action === 'review') {
      gamesToReview.push({
        id,
        name: g?.name || id,
        reason: dec.reason,
        provider: g?.provider || null,
        manual: g?.manual === true,
        active: g?.active === true,
        salesCount: g?.salesCount ?? 0,
      });
    } else if (dec.action === 'keep' && dec.reason === 'co_agotado_temporal') {
      gamesCoOutOfStock.push({ id, name: g?.name || id, hiddenReason: g?.hiddenReason || null });
    }
    if (dec.action === 'protect') {
      if (STREAMING_RE.test(g?.name || '') && g?.active === true) {
        streamingActiveGames.push({ id, name: g?.name || id });
      }
      if (id.startsWith('co-') && dec.reason === 'vendible') {
        coVendibleGames.push(id);
      }
    }
  }

  const productsToDeleteByGame = {};
  const productsToReview = [];
  let coVivoProducts = 0;
  let coRescuedProducts = 0;
  let manualActivoProducts = 0;

  for (const [id, dec] of classification.products) {
    const p = products.get(id);
    const g = p?.gameId ? games.get(p.gameId) : undefined;
    if (dec.action === 'delete') {
      const gid = p?.gameId || '(sin_gameId)';
      if (!productsToDeleteByGame[gid]) {
        productsToDeleteByGame[gid] = {
          gameId: gid,
          gameName: g?.name || gid,
          count: 0,
          reasons: {},
        };
      }
      productsToDeleteByGame[gid].count += 1;
      productsToDeleteByGame[gid].reasons[dec.reason] =
        (productsToDeleteByGame[gid].reasons[dec.reason] || 0) + 1;
    } else if (dec.action === 'review') {
      productsToReview.push({
        id,
        name: p?.name || id,
        gameId: p?.gameId || '',
        gameName: g?.name || p?.gameId || '',
        reason: dec.reason,
        provider: detectProductProvider(id, p, g),
        fulfillment: p?.fulfillment || null,
        active: p?.active === true,
        priceUsd: p?.priceUsd ?? null,
      });
    } else if (dec.action === 'protect') {
      if (dec.reason === 'co_vivo') coVivoProducts += 1;
      if (dec.reason === 'co_recuperado_por_nuevo_mapeo') coRescuedProducts += 1;
      if (dec.reason === 'manual_activo') manualActivoProducts += 1;
    }
  }

  const topAffectedGames = Object.values(productsToDeleteByGame)
    .sort((a, b) => b.count - a.count || a.gameId.localeCompare(b.gameId))
    .slice(0, 30);

  return {
    generatedAt: new Date().toISOString(),
    liveCatalogItems: liveCount,
    mappingComparison,
    stats,
    protection: {
      coVivoProducts,
      coRescuedProducts,
      coVendibleGames: coVendibleGames.length,
      manualActivoProducts,
      streamingActiveGames,
      invariantsOk: true,
    },
    gamesToDeleteByReason,
    topAffectedGames,
    gamesToReview,
    productsToReview,
    gamesCoOutOfStock,
  };
}

function renderMarkdownReport(report, games, classification) {
  const s = report.stats;
  const lines = [];
  lines.push('# Reporte de Auditoría y Limpieza del Catálogo');
  lines.push('');
  lines.push(`- Generado: ${report.generatedAt}`);
  lines.push(`- Ítems en catálogo vivo de Central One: **${report.liveCatalogItems}**`);
  if (report.mappingComparison) {
    const mc = report.mappingComparison;
    lines.push('');
    lines.push('## 0. Comparativo del nuevo mapeo completo de Central One');
    lines.push('');
    lines.push(`- Juegos mapeados en memoria: **${mc.mappedGames}** (${JSON.stringify(mc.byFamily)})`);
    lines.push(`- Ofertas mapeadas en memoria: **${mc.mappedOffers}** (incluye **${mc.pinsMapped}** PINs digitales)`);
    lines.push(`- Ofertas nuevas de Central One que se agregarán al sincronizar: **${mc.newOffersToAddCount}**`);
    lines.push(`- Productos rescatados del borrado por el nuevo mapeo (\`co_recuperado_por_nuevo_mapeo\`): **${mc.rescuedProductsCount}**`);
    lines.push(`- Descartados del mapeo (\`skipped\`): \`${JSON.stringify(mc.skipped)}\``);
  }
  lines.push('');
  lines.push('## 1. Totales actuales vs. vivos tras limpieza');
  lines.push('');
  lines.push('| Colección | Actuales | A eliminar | Quedan vivos | Protegidos | Agotados (keep) | A revisar |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(
    `| games | ${s.totalGames} | ${s.gameActions.delete} | ${s.survivingGames} | ${s.gameActions.protect} | ${s.gameActions.keep} | ${s.gameActions.review} |`
  );
  lines.push(
    `| products | ${s.totalProducts} | ${s.productActions.delete} | ${s.survivingProducts} | ${s.productActions.protect} | ${s.productActions.keep} | ${s.productActions.review} |`
  );
  lines.push('');
  lines.push('## 2. Juegos a eliminar por motivo');
  lines.push('');
  for (const [reason, list] of Object.entries(report.gamesToDeleteByReason).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${reason} (${list.length})`);
    lines.push('');
    for (const item of list.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- \`${item.id}\` — ${item.name} (provider: ${item.provider || 'none'}, active: ${item.active}, sales: ${item.salesCount})`);
    }
    lines.push('');
  }

  lines.push('## 3. Productos a eliminar');
  lines.push('');
  lines.push('### Por motivo');
  lines.push('');
  for (const [reason, count] of Object.entries(s.productDeleteByReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${reason}\`: **${count}**`);
  }
  lines.push('');
  lines.push('### Por proveedor');
  lines.push('');
  for (const [prov, count] of Object.entries(s.productDeleteByProvider).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${prov}\`: **${count}**`);
  }
  lines.push('');
  lines.push('### Top 30 juegos afectados por eliminación de productos');
  lines.push('');
  for (const item of report.topAffectedGames) {
    lines.push(`- \`${item.gameId}\` (${item.gameName}): **${item.count}** productos (${JSON.stringify(item.reasons)})`);
  }
  lines.push('');

  lines.push('## 4. REVISAR MANUALMENTE');
  lines.push('');
  lines.push(`### Juegos en revisión (${report.gamesToReview.length})`);
  lines.push('');
  if (report.gamesToReview.length === 0) {
    lines.push('- Ninguno.');
  } else {
    for (const g of report.gamesToReview.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(
        `- \`${g.id}\` — ${g.name} | motivo: \`${g.reason}\` | provider: ${g.provider || 'none'} | manual: ${g.manual} | active: ${g.active} | sales: ${g.salesCount}`
      );
    }
  }
  lines.push('');
  lines.push(`### Productos en revisión (${report.productsToReview.length})`);
  lines.push('');
  if (report.productsToReview.length === 0) {
    lines.push('- Ninguno.');
  } else {
    for (const p of report.productsToReview.sort((a, b) => a.gameId.localeCompare(b.gameId) || a.id.localeCompare(b.id))) {
      lines.push(
        `- \`${p.id}\` — ${p.name} | juego: \`${p.gameId}\` (${p.gameName}) | motivo: \`${p.reason}\` | prov: ${p.provider} | active: ${p.active} | priceUsd: ${p.priceUsd}`
      );
    }
  }
  lines.push('');

  lines.push(`## 5. Juegos Central One conservados ocultos por agotado (${report.gamesCoOutOfStock.length})`);
  lines.push('');
  for (const g of report.gamesCoOutOfStock.sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`- \`${g.id}\` — ${g.name} (hiddenReason: ${g.hiddenReason || 'none'})`);
  }
  lines.push('');

  lines.push('## 6. Confirmación de protección e invariantes');
  lines.push('');
  lines.push(`- Productos \`co_vivo\` protegidos: **${report.protection.coVivoProducts}**`);
  lines.push(`- Productos \`co_recuperado_por_nuevo_mapeo\` protegidos: **${report.protection.coRescuedProducts}**`);
  lines.push(`- Juegos Central One vendibles protegidos: **${report.protection.coVendibleGames}**`);
  lines.push(`- Productos \`manual_activo\` protegidos: **${report.protection.manualActivoProducts}**`);
  if (report.protection.streamingActiveGames.length === 0) {
    lines.push('- Catálogo de Streaming manual en Firestore: **no existe catálogo de Streaming manual activo en Firestore** (solo gift cards de proveedores).');
  } else {
    lines.push(
      `- Juegos Streaming activos protegidos (${report.protection.streamingActiveGames.length}): ${report.protection.streamingActiveGames.map((g) => `\`${g.id}\``).join(', ')}`
    );
  }
  lines.push('- Invariantes: **OK**');
  lines.push('');

  void games;
  void classification;
  return lines.join('\n');
}

function printConsoleReport(report, stamp, jsonPath, mdPath) {
  const s = report.stats;
  console.log('\n=== REPORTE DRY-RUN / AUDITORÍA DE CATÁLOGO ===');
  console.log(`Catálogo vivo Central One: ${report.liveCatalogItems} ítems`);
  if (report.mappingComparison) {
    const mc = report.mappingComparison;
    console.log(
      `Nuevo mapeo CO: juegos=${mc.mappedGames} (${JSON.stringify(mc.byFamily)}) | ofertas=${mc.mappedOffers} (PINs=${mc.pinsMapped}) | nuevasPorAgregar=${mc.newOffersToAddCount} | rescatadosDelBorrado=${mc.rescuedProductsCount}`
    );
    console.log(`Descartados del mapeo: ${JSON.stringify(mc.skipped)}`);
  }
  console.log(
    `Juegos:    actuales=${s.totalGames} | eliminar=${s.gameActions.delete} | quedan=${s.survivingGames} (protect=${s.gameActions.protect}, keep=${s.gameActions.keep}, review=${s.gameActions.review})`
  );
  console.log(
    `Productos: actuales=${s.totalProducts} | eliminar=${s.productActions.delete} | quedan=${s.survivingProducts} (protect=${s.productActions.protect}, keep=${s.productActions.keep}, review=${s.productActions.review})`
  );

  console.log('\n--- Juegos a eliminar (agrupados por motivo) ---');
  for (const [reason, list] of Object.entries(report.gamesToDeleteByReason).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`* ${reason}: ${list.length}`);
    list
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 15)
      .forEach((g) => console.log(`   - ${g.id} (${g.name})`));
    if (list.length > 15) console.log(`   ... (+${list.length - 15} más en el reporte .md)`);
  }

  console.log('\n--- Productos a eliminar por motivo ---');
  for (const [reason, count] of Object.entries(s.productDeleteByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`* ${reason}: ${count}`);
  }
  console.log('\n--- Productos a eliminar por proveedor ---');
  for (const [prov, count] of Object.entries(s.productDeleteByProvider).sort((a, b) => b[1] - a[1])) {
    console.log(`* ${prov}: ${count}`);
  }
  console.log('\n--- Top juegos afectados ---');
  report.topAffectedGames.slice(0, 10).forEach((item) => {
    console.log(`* ${item.gameId} (${item.gameName}): ${item.count} ${JSON.stringify(item.reasons)}`);
  });

  console.log(`\n--- REVISAR MANUALMENTE: Juegos (${report.gamesToReview.length}) ---`);
  report.gamesToReview.forEach((g) => {
    console.log(`* ${g.id} | ${g.name} | ${g.reason} | prov=${g.provider || 'none'} | active=${g.active} | sales=${g.salesCount}`);
  });

  console.log(`\n--- REVISAR MANUALMENTE: Productos (${report.productsToReview.length}) ---`);
  report.productsToReview.forEach((p) => {
    console.log(`* ${p.id} | ${p.name} | game=${p.gameId} | ${p.reason} | prov=${p.provider} | active=${p.active} | price=${p.priceUsd}`);
  });

  console.log(`\n--- Juegos CO conservados ocultos por agotado (${report.gamesCoOutOfStock.length}) ---`);
  report.gamesCoOutOfStock.slice(0, 15).forEach((g) => console.log(`* ${g.id} (${g.name})`));
  if (report.gamesCoOutOfStock.length > 15) {
    console.log(`... (+${report.gamesCoOutOfStock.length - 15} más en el reporte .md)`);
  }

  console.log('\n--- Protección e Invariantes ---');
  console.log(`* co_vivo protegidos: ${report.protection.coVivoProducts}`);
  console.log(`* co_recuperado_por_nuevo_mapeo protegidos: ${report.protection.coRescuedProducts}`);
  console.log(`* Juegos CO vendibles protegidos: ${report.protection.coVendibleGames}`);
  console.log(`* manual_activo protegidos: ${report.protection.manualActivoProducts}`);
  console.log(
    report.protection.streamingActiveGames.length === 0
      ? '* Streaming manual: no existe catálogo de Streaming manual en Firestore'
      : `* Streaming activos protegidos: ${report.protection.streamingActiveGames.map((g) => g.id).join(', ')}`
  );
  console.log('* Invariantes: OK');
  console.log(`\nArchivos generados (${stamp}):`);
  console.log(`- JSON: ${jsonPath}`);
  console.log(`- MD:   ${mdPath}`);
  console.log(
    `\nComando para aplicar tras confirmar:\nnode scripts/cleanupDeadCatalog.cjs --apply --confirm=${s.gameActions.delete}:${s.productActions.delete}`
  );
}

// ---------------------------------------------------------------------------
// Aplicación (--apply)
// ---------------------------------------------------------------------------

async function applyCleanup({ db, FieldValue, games, products, classification, stamp }) {
  const gamesToDelete = [];
  for (const [id, dec] of classification.games) {
    if (dec.action === 'delete') gamesToDelete.push(id);
  }
  const productsToDelete = [];
  const gamesLosingProducts = new Set();
  for (const [id, dec] of classification.products) {
    if (dec.action === 'delete') {
      productsToDelete.push(id);
      const p = products.get(id);
      if (p?.gameId) gamesLosingProducts.add(p.gameId);
    }
  }
  for (const gid of gamesToDelete) gamesLosingProducts.delete(gid);

  // 1. Backup completo ANTES de escribir nada
  const backupPath = path.join(BACKUPS_DIR, `catalog-backup-${stamp}.json`);
  const serializedGames = {};
  for (const [id, data] of games) serializedGames[id] = serializeValue(data);
  const serializedProducts = {};
  for (const [id, data] of products) serializedProducts[id] = serializeValue(data);

  const backupPayload = {
    createdAt: new Date().toISOString(),
    projectId: DEFAULT_PROJECT_ID,
    games: serializedGames,
    products: serializedProducts,
    deleted: {
      games: gamesToDelete,
      products: productsToDelete,
    },
  };
  fs.writeFileSync(backupPath, JSON.stringify(backupPayload), 'utf8');
  const verified = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (
    Object.keys(verified.games || {}).length !== games.size ||
    Object.keys(verified.products || {}).length !== products.size
  ) {
    throw new Error('La verificación del respaldo falló: los conteos no coinciden.');
  }
  console.log(`Respaldo completo verificado en: ${backupPath}`);

  // 2. Borrar productos y luego juegos en batches de 400
  async function deleteIds(colName, ids) {
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      const chunk = ids.slice(i, i + BATCH_LIMIT);
      const batch = db.batch();
      for (const id of chunk) batch.delete(db.collection(colName).doc(id));
      await batch.commit();
    }
  }
  await deleteIds('products', productsToDelete);
  await deleteIds('games', gamesToDelete);

  // 3. Recalcular resúmenes en juegos supervivientes afectados
  const deletedProductSet = new Set(productsToDelete);
  const survivingByGame = new Map();
  for (const [id, p] of products) {
    if (deletedProductSet.has(id)) continue;
    if (!p?.gameId || !gamesLosingProducts.has(p.gameId)) continue;
    if (!survivingByGame.has(p.gameId)) survivingByGame.set(p.gameId, []);
    survivingByGame.get(p.gameId).push(p);
  }

  const nowMs = Date.now();
  const recalculatedGames = [];
  let batch = db.batch();
  let pending = 0;

  for (const gameId of gamesLosingProducts) {
    const gameData = games.get(gameId);
    if (!gameData) continue;
    const isCentralOneGame = gameData.provider === 'centralone' || gameId.startsWith('co-');
    const gameProducts = survivingByGame.get(gameId) || [];

    const available = [];
    const liveOfferIds = new Set();
    for (const p of gameProducts) {
      const pausedUntilMs = timestampMs(p.providerPausedUntil);
      const paused = pausedUntilMs > nowMs;
      if (
        p.active === true &&
        p.adminDisabled !== true &&
        p.providerRemoved !== true &&
        !paused &&
        (p.stock === null || p.stock === undefined || p.stock > 0)
      ) {
        available.push(p);
        if (Array.isArray(p.calls)) {
          for (const call of p.calls) {
            if ((call.provider ?? p.provider) === 'centralone' && call.packageId) {
              liveOfferIds.add(String(call.packageId));
            }
          }
        }
        if (p.providerOfferId) liveOfferIds.add(String(p.providerOfferId));
      }
    }

    const prices = available.map((item) => Number(item.priceUsd)).filter((v) => Number.isFinite(v) && v > 0);
    const minPriceUsd = prices.length ? Math.round(Math.min(...prices) * 100) / 100 : null;
    const patch = {
      productCount: available.length,
      minPriceUsd,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (isCentralOneGame) {
      patch.liveOfferIds = [...liveOfferIds];
      if (available.length === 0) {
        if (gameData.active !== false) {
          patch.active = false;
          patch.hiddenReason = 'out_of_stock';
        }
      } else if (gameData.active === false && gameData.hiddenReason === 'out_of_stock') {
        patch.active = true;
        patch.hiddenReason = null;
      }
    }

    batch.set(db.collection('games').doc(gameId), patch, { merge: true });
    recalculatedGames.push(gameId);
    pending += 1;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();

  const appliedPath = path.join(BACKUPS_DIR, `catalog-cleanup-applied-${stamp}.json`);
  fs.writeFileSync(
    appliedPath,
    JSON.stringify(
      {
        appliedAt: new Date().toISOString(),
        backupPath,
        deleted: { games: gamesToDelete, products: productsToDelete },
        recalculatedGames,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\nLimpieza aplicada: ${gamesToDelete.length} juegos y ${productsToDelete.length} productos eliminados.`);
  console.log(`Resumen de aplicación guardado en: ${appliedPath}`);
}

// ---------------------------------------------------------------------------
// Entrada CLI
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      'Uso: node scripts/cleanupDeadCatalog.cjs [--dry-run] [--apply --confirm=G:P] [--also-delete=id1,id2] [--keep=id1,id2] [--restore=ruta]'
    );
    return;
  }

  if (opts.restore) {
    await restoreFromBackup(opts.restore);
    return;
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  console.log('Consultando catálogo vivo de Central One...');
  const { live, rawCount, rawItems } = await fetchLiveCentralOneCatalog();
  const mapCentralOneCatalog = loadCentralOneMapper();

  const { db, FieldValue } = initFirebase();
  console.log('Leyendo Firestore (games, products, órdenes abiertas)...');

  const [gamesSnap, productsSnap, openOrdersSnap] = await Promise.all([
    db.collection('games').get(),
    db.collection('products').get(),
    db.collection('orders').where('status', 'in', OPEN_ORDER_STATUSES).select('gameId', 'productId').get(),
  ]);

  if (opts.apply) {
    const syncSnap = await db.collection('providerSync').where('status', 'in', ['queued', 'running']).limit(1).get();
    if (!syncSnap.empty) {
      throw new Error('Hay una sincronización de Central One en curso o en cola. Espera a que termine antes de aplicar.');
    }
  }

  const games = new Map();
  gamesSnap.forEach((doc) => games.set(doc.id, doc.data()));
  const products = new Map();
  productsSnap.forEach((doc) => products.set(doc.id, doc.data()));

  const coGamesForMapper = new Map();
  for (const [id, g] of games) {
    if (g?.provider === 'centralone' || id.startsWith('co-')) {
      coGamesForMapper.set(id, g);
    }
  }
  const newMapping = mapCentralOneCatalog(rawItems, [], { games: coGamesForMapper });
  const mappedOfferIds = new Set();
  const mappedGameIds = new Set();
  let pinsMapped = 0;
  for (const g of newMapping.games) {
    mappedGameIds.add(g.id);
    for (const o of g.offers) {
      mappedOfferIds.add(o.productId);
      if (o.isPin) pinsMapped += 1;
    }
  }

  const existingCoOfferIds = new Set();
  for (const p of products.values()) {
    for (const cid of coIds(p)) existingCoOfferIds.add(cid);
  }
  let newOffersToAddCount = 0;
  for (const cid of mappedOfferIds) {
    if (!existingCoOfferIds.has(cid)) newOffersToAddCount += 1;
  }

  const openOrderGameIds = new Set();
  const openOrderProductIds = new Set();
  openOrdersSnap.forEach((doc) => {
    const d = doc.data();
    if (d.gameId) openOrderGameIds.add(String(d.gameId));
    if (d.productId) openOrderProductIds.add(String(d.productId));
  });

  const classification = classifyCatalog({
    games,
    products,
    live,
    openOrderGameIds,
    openOrderProductIds,
    alsoDelete: opts.alsoDelete,
    keep: opts.keep,
    mappedOfferIds,
    mappedGameIds,
  });

  let rescuedProductsCount = 0;
  for (const dec of classification.products.values()) {
    if (dec.reason === 'co_recuperado_por_nuevo_mapeo') rescuedProductsCount += 1;
  }
  const mappingComparison = {
    rawItems: rawCount,
    mappedGames: newMapping.games.length,
    byFamily: newMapping.gamesByFamily,
    mappedOffers: mappedOfferIds.size,
    pinsMapped,
    existingCoOfferCount: existingCoOfferIds.size,
    newOffersToAddCount,
    rescuedProductsCount,
    skipped: newMapping.skipped,
  };

  const stamp = formatFileStamp();
  const report = buildReportData(games, products, classification, rawCount, mappingComparison);
  const md = renderMarkdownReport(report, games, classification);

  const jsonPath = path.join(BACKUPS_DIR, `catalog-cleanup-report-${stamp}.json`);
  const mdPath = path.join(BACKUPS_DIR, `catalog-cleanup-report-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');

  printConsoleReport(report, stamp, jsonPath, mdPath);

  if (opts.apply) {
    const expectedConfirm = `${report.stats.gameActions.delete}:${report.stats.productActions.delete}`;
    if (opts.confirm !== expectedConfirm) {
      throw new Error(
        `Confirmación inválida. Recibido "${opts.confirm || ''}", esperado "--confirm=${expectedConfirm}". No se escribió nada.`
      );
    }
    await applyCleanup({ db, FieldValue, games, products, classification, stamp });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  OPEN_ORDER_STATUSES,
  STREAMING_RE,
  coIds,
  validPrice,
  isManual,
  coSignature,
  timestampMs,
  serializeValue,
  deserializeValue,
  classifyCatalog,
  assertSafe,
  parseArgs,
  buildReportData,
  renderMarkdownReport,
};
