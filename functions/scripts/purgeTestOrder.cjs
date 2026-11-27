/**
 * Elimina por completo una orden de prueba de WhatsApp y revierte su efecto
 * en los agregados diarios. Uso:
 *   node scripts/purgeTestOrder.cjs WA-585204            (dry-run)
 *   node scripts/purgeTestOrder.cjs WA-585204 --apply    (borra, con respaldo en backups/)
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'refill-e254f' });
const db = admin.firestore();

const CODE = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!CODE) {
  console.error('Falta el código de la orden (ej. WA-585204).');
  process.exit(1);
}

const round = (v, d = 2) => Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d;
const dayKey = (date) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return p;
};
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x === 'object' && typeof x._seconds === 'number' ? { __ts: x._seconds * 1000 } : x)));

(async () => {
  const snap = await db.collection('orders').where('code', '==', CODE).get();
  if (snap.empty) { console.log('No existe ninguna orden con ese código.'); process.exit(0); }

  const backup = { code: CODE, takenAt: new Date().toISOString(), orders: [] };
  const deletes = [];
  const dayAdjust = new Map();

  for (const doc of snap.docs) {
    const o = doc.data();
    const entry = { id: doc.id, data: plain(o), events: [], paymentRefs: [], alerts: [], audit: [], wallet: [] };

    const ev = await doc.ref.collection('events').get();
    ev.docs.forEach((d) => { entry.events.push({ id: d.id, data: plain(d.data()) }); deletes.push(d.ref); });

    const refIds = new Set();
    if (o.payment?.reference) refIds.add(String(o.payment.reference));
    if (o.referencia) refIds.add(String(o.referencia));
    for (const id of refIds) {
      const s = await db.collection('paymentRefs').doc(id).get();
      if (s.exists && (s.data().orderId === doc.id || s.data().orderCode === CODE)) {
        entry.paymentRefs.push({ id, data: plain(s.data()) }); deletes.push(s.ref);
      }
    }
    const q = await db.collection('paymentRefs').where('orderId', '==', doc.id).get();
    q.docs.forEach((d) => { if (!entry.paymentRefs.some((p) => p.id === d.id)) { entry.paymentRefs.push({ id: d.id, data: plain(d.data()) }); deletes.push(d.ref); } });

    for (const [col, field] of [['adminAlerts', 'orderId'], ['auditLogs', 'targetId'], ['providerOrders', 'orderId']]) {
      const r = await db.collection(col).where(field, '==', doc.id).get();
      r.docs.forEach((d) => { entry.alerts.push({ col, id: d.id, data: plain(d.data()) }); deletes.push(d.ref); });
    }

    if (o.uid && !String(o.uid).startsWith('whatsapp:')) {
      const w = await db.collection('users').doc(o.uid).collection('wallet').where('orderId', '==', doc.id).get();
      w.docs.forEach((d) => entry.wallet.push({ id: d.id, data: plain(d.data()) }));
      if (entry.wallet.length) console.log('AVISO: la orden tiene movimientos de billetera; revisar a mano.', entry.wallet.length);
    }

    deletes.push(doc.ref);
    backup.orders.push(entry);
    if (o.createdAt) dayAdjust.set(dayKey(o.createdAt.toDate()), true);
  }

  // Reconciliación del agregado diario con las órdenes que SÍ permanecen.
  const dayPlans = [];
  for (const key of dayAdjust.keys()) {
    const start = new Date(`${key}T00:00:00-04:00`);
    const end = new Date(start.getTime() + 86_400_000);
    const all = await db.collection('orders').where('createdAt', '>=', start).where('createdAt', '<', end).get();
    const targetIds = new Set(snap.docs.map((d) => d.id));
    const keep = all.docs.filter((d) => !targetIds.has(d.id) && d.data().metricsAccounted === true && d.data().status === 'completed');
    const tot = { completedOrders: 0, revenueUsd: 0, revenueBs: 0, costUsd: 0, profitUsd: 0 };
    const byGame = {}; const byProduct = {};
    for (const d of keep) {
      const o = d.data(); const p = o.pricing || {};
      const add = (acc) => { acc.orders = (acc.orders || 0) + 1; acc.revenueUsd = round((acc.revenueUsd || 0) + round(p.totalUsd, 2)); acc.costUsd = round((acc.costUsd || 0) + round(p.costUsd, 2)); acc.profitUsd = round((acc.profitUsd || 0) + round(p.profitUsd, 2)); };
      tot.completedOrders += 1;
      tot.revenueUsd = round(tot.revenueUsd + round(p.totalUsd, 2));
      tot.revenueBs = round(tot.revenueBs + round(p.totalBs, 2));
      tot.costUsd = round(tot.costUsd + round(p.costUsd, 2));
      tot.profitUsd = round(tot.profitUsd + round(p.profitUsd, 2));
      add(byGame[o.gameId] = byGame[o.gameId] || {});
      add(byProduct[o.productId] = byProduct[o.productId] || {});
    }
    const ref = db.collection('stats').doc('daily').collection('days').doc(key);
    const cur = await ref.get();
    backup[`dailyStats:${key}`] = plain(cur.data() || null);
    dayPlans.push({ key, ref, tot, byGame, byProduct, current: cur.data() || {} });
  }

  console.log(`Orden(es): ${snap.size} | documentos a borrar: ${deletes.length}`);
  deletes.forEach((r) => console.log('  - borrar', r.path));
  for (const p of dayPlans) {
    const c = p.current;
    console.log(`dailyStats ${p.key}: antes`, JSON.stringify({ completedOrders: c.completedOrders, revenueUsd: c.revenueUsd, revenueBs: c.revenueBs, costUsd: c.costUsd, profitUsd: c.profitUsd }));
    console.log(`dailyStats ${p.key}: después`, JSON.stringify({ ...p.tot, byGame: p.byGame, byProduct: p.byProduct }));
  }

  if (!APPLY) { console.log('\nDRY-RUN: no se modificó nada. Usa --apply para ejecutar.'); process.exit(0); }

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `purge-${CODE}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log('Respaldo:', file);

  const batch = db.batch();
  deletes.forEach((r) => batch.delete(r));
  for (const p of dayPlans) {
    batch.set(p.ref, {
      completedOrders: p.tot.completedOrders, revenueUsd: p.tot.revenueUsd, revenueBs: p.tot.revenueBs,
      costUsd: p.tot.costUsd, profitUsd: p.tot.profitUsd,
      byGame: admin.firestore.FieldValue.delete(), byProduct: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    batch.set(p.ref, { byGame: p.byGame, byProduct: p.byProduct }, { merge: true });
  }
  await batch.commit();
  console.log('Listo: orden y registros asociados eliminados; estadísticas del día reconciliadas.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
