/**
 * Backfill seguro e idempotente de ingresos verificados en Bs hacia `bankLedger`.
 *
 * Uso:
 *   node scripts/backfill-bank-ledger.mjs --dry-run
 *   node scripts/backfill-bank-ledger.mjs --dry-run --all
 *   node scripts/backfill-bank-ledger.mjs --apply
 *   node scripts/backfill-bank-ledger.mjs --apply --accountKey=0102-V32463319-04222003851
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');

const DEFAULT_TARGET_ACCOUNT = '0102-V32463319-04222003851';
const DEFAULT_FALLBACK_BANK = {
  code: '0102',
  name: 'Banco de Venezuela',
  idNumber: 'V-32463319',
  phone: '04222003851',
};

function parseArgs(argv) {
  let apply = false;
  let all = false;
  let accountKey = DEFAULT_TARGET_ACCOUNT;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--all') all = true;
    else if (arg.startsWith('--accountKey=')) {
      accountKey = arg.slice('--accountKey='.length).trim() || DEFAULT_TARGET_ACCOUNT;
    }
  }
  return { apply, all, accountKey };
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizeBankCode(raw) {
  const s = String(raw ?? '').trim();
  const match = s.match(/\b(0\d{3})\b/);
  if (match) return match[1];
  const digits = s.replace(/\D/g, '').slice(0, 4);
  return digits || '0102';
}

function normalizeCedula(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return '';
  if (/^\d{6,10}$/.test(cleaned)) return `V${cleaned}`;
  return cleaned;
}

function normalizeBankPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('58') && digits.length === 12) return `0${digits.slice(2)}`;
  if (/^[24]\d{9}$/.test(digits)) return `0${digits}`;
  return digits;
}

function normalizeLedgerReference(raw) {
  const rawStr = String(raw ?? '').trim();
  if (!rawStr) return '';
  const digits = rawStr.replace(/\D/g, '');
  if (digits.length >= 4) return digits;
  return rawStr.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function resolveBankAccount(snapshot, fallbackBank) {
  const fb = fallbackBank ?? DEFAULT_FALLBACK_BANK;
  const bankCode = normalizeBankCode(snapshot?.code || fb.code || '0102');
  const bankName =
    String(snapshot?.name || fb.name || 'Banco de Venezuela').trim() || 'Banco de Venezuela';

  const snapCedula = normalizeCedula(snapshot?.idNumber);
  const fbCedula = normalizeCedula(fb.idNumber);
  const cedula = snapCedula || fbCedula || 'SINCI';

  let phone = normalizeBankPhone(snapshot?.phone);
  if (!phone) {
    const fbPhone = normalizeBankPhone(fb.phone);
    const fbCode = normalizeBankCode(fb.code || '0102');
    if (fbPhone && (!snapCedula || !fbCedula || (bankCode === fbCode && snapCedula === fbCedula))) {
      phone = fbPhone;
    } else if (snapshot?.accountNumber) {
      const accDigits = String(snapshot.accountNumber).replace(/\D/g, '');
      phone = accDigits ? `cta_${accDigits.slice(-4)}` : 'transfer';
    } else {
      phone = fbPhone || 'sintel';
    }
  }

  return {
    accountKey: `${bankCode}-${cedula}-${phone}`,
    bankCode,
    bankName,
    cedula,
    phone,
  };
}

function extractOrderInflows(order, fallbackBank) {
  const method = order.payment?.method;
  if (method === 'binance_pay' || method === 'wallet') return [];

  const isWhatsapp =
    order.canal === 'WHATSAPP' ||
    order.origen === 'WHATSAPP' ||
    String(order.id).startsWith('wa_') ||
    String(order.uid ?? '').startsWith('whatsapp:');
  const source = isWhatsapp
    ? 'whatsapp'
    : method === 'transfer'
      ? 'manual_transfer'
      : 'web';

  const bankSnapshot = order.payment?.bankSnapshot ?? fallbackBank ?? DEFAULT_FALLBACK_BANK;
  const results = [];
  const partials = Array.isArray(order.payment?.partials) ? order.payment.partials : [];
  const seenRefs = new Set();
  let partialsSum = 0;

  for (const p of partials) {
    const cleanRef = normalizeLedgerReference(p?.reference);
    const amt = round(Number(p?.amountBs ?? 0), 2);
    if (!cleanRef || !(amt > 0) || seenRefs.has(cleanRef)) continue;
    seenRefs.add(cleanRef);
    partialsSum = round(partialsSum + amt, 2);
    results.push({
      amountBs: amt,
      reference: cleanRef,
      source,
      bankSnapshot,
      createdAt: p.verifiedAt ?? order.payment?.verifiedAt ?? order.createdAt ?? admin.firestore.Timestamp.now(),
      note: partials.length > 1 || !order.payment?.verifiedAt ? 'Abono parcial verificado (backfill)' : 'Backfill histórico',
    });
  }

  const finalRef = normalizeLedgerReference(order.payment?.reference ?? order.referencia);
  const isVerified =
    Boolean(order.payment?.verifiedAt) ||
    (isWhatsapp && Number(order.payment?.paidBs ?? order.montoBs ?? 0) > 0);
  if (isVerified && finalRef && !seenRefs.has(finalRef)) {
    const reported = Number(order.payment?.reportedAmountBs ?? 0);
    const totalOrderBs = Number(order.payment?.paidBs ?? order.pricing?.totalBs ?? order.montoBs ?? 0);
    let finalAmountBs = 0;
    if (Number.isFinite(reported) && reported > 0) {
      finalAmountBs = round(reported, 2);
    } else if (partialsSum > 0) {
      finalAmountBs = round(Math.max(0, totalOrderBs - partialsSum), 2);
    } else {
      finalAmountBs = round(totalOrderBs, 2);
    }

    if (finalAmountBs > 0) {
      results.push({
        amountBs: finalAmountBs,
        reference: finalRef,
        source,
        bankSnapshot,
        createdAt: order.payment?.verifiedAt ?? order.createdAt ?? admin.firestore.Timestamp.now(),
        note: 'Backfill histórico',
      });
    }
  }

  return results;
}

function formatTs(ts) {
  if (!ts) return '—';
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts._seconds === 'number') return new Date(ts._seconds * 1000).toISOString();
  return String(ts);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: 'refill-e254f',
    });
  }
  const db = admin.firestore();

  const configSnap = await db.collection('config').doc('app').get();
  const fallbackBank = configSnap.exists ? (configSnap.data()?.bank ?? DEFAULT_FALLBACK_BANK) : DEFAULT_FALLBACK_BANK;

  const [ordersSnap, ledgerSnap] = await Promise.all([
    db.collection('orders').get(),
    db.collection('bankLedger').get(),
  ]);

  const existingIds = new Set(ledgerSnap.docs.map((d) => d.id));
  const candidates = [];
  let alreadyExists = 0;
  let existingTotalBs = 0;
  let skippedOtherAccount = 0;

  for (const doc of ordersSnap.docs) {
    const order = { id: doc.id, ...doc.data() };
    const inflows = extractOrderInflows(order, fallbackBank);
    for (const inf of inflows) {
      const account = resolveBankAccount(inf.bankSnapshot, fallbackBank);
      if (!opts.all && account.accountKey !== opts.accountKey) {
        skippedOtherAccount += 1;
        continue;
      }

      const docId = `inflow_${account.accountKey}_${inf.reference}`;
      if (existingIds.has(docId)) {
        alreadyExists += 1;
        existingTotalBs = round(existingTotalBs + inf.amountBs, 2);
        continue;
      }

      existingIds.add(docId);
      candidates.push({
        docId,
        entry: {
          type: 'inflow',
          accountKey: account.accountKey,
          bankCode: account.bankCode,
          bankName: account.bankName,
          cedula: account.cedula,
          phone: account.phone,
          amountBs: inf.amountBs,
          source: inf.source,
          orderId: order.id,
          orderCode: order.code ?? null,
          reference: inf.reference,
          note: inf.note ?? null,
          createdAt: inf.createdAt,
          createdBy: 'system:backfill',
        },
      });
    }
  }

  let totalBsToCreate = 0;
  const bySource = { web: 0, whatsapp: 0, manual_transfer: 0 };
  const bsBySource = { web: 0, whatsapp: 0, manual_transfer: 0 };
  const byAccount = {};
  for (const item of candidates) {
    const { source, amountBs, accountKey } = item.entry;
    totalBsToCreate = round(totalBsToCreate + amountBs, 2);
    bySource[source] = (bySource[source] || 0) + 1;
    bsBySource[source] = round((bsBySource[source] || 0) + amountBs, 2);
    if (!byAccount[accountKey]) {
      byAccount[accountKey] = { count: 0, totalBs: 0 };
    }
    byAccount[accountKey].count += 1;
    byAccount[accountKey].totalBs = round(byAccount[accountKey].totalBs + amountBs, 2);
  }

  let created = 0;
  if (opts.apply && candidates.length > 0) {
    const col = db.collection('bankLedger');
    for (const item of candidates) {
      const ref = col.doc(item.docId);
      const inserted = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return false;
        tx.set(ref, item.entry);
        return true;
      });
      if (inserted) created += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: opts.apply ? 'APPLY' : 'DRY_RUN',
        targetAccountKey: opts.all ? 'ALL' : opts.accountKey,
        ordersScanned: ordersSnap.size,
        skippedOtherAccount,
        alreadyExists,
        existingTotalBs,
        pendingToCreate: candidates.length,
        createdInThisRun: created,
        totalBsToCreate,
        bySource,
        bsBySource,
        byAccount,
        sample: candidates.slice(0, 20).map((c) => ({
          docId: c.docId,
          orderCode: c.entry.orderCode,
          source: c.entry.source,
          reference: c.entry.reference,
          amountBs: c.entry.amountBs,
          createdAt: formatTs(c.entry.createdAt),
        })),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('❌ Error en backfill-bank-ledger:', err);
  process.exit(1);
});
