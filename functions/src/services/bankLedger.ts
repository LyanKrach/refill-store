/**
 * Control de caja en bolívares por cuenta bancaria (`bankLedger`).
 *
 * Registra de forma idempotente cada ingreso real verificado en Bs (Pago Móvil
 * verificado por Pabilo desde Web o WhatsApp, abonos parciales, porción en Bs de
 * pagos mixtos y transferencias verificadas) y los retiros manuales del titular.
 *
 * Reglas financieras:
 *  - ID determinístico `inflow_{accountKey}_{ref}` + transacción insert-only:
 *    imposible contar dos veces el mismo pago entre Web, WhatsApp, reintentos o backfill.
 *  - Nunca se registran pagos en `binance_pay` ni en `wallet` (RefillCoins).
 *  - Los reembolsos a RefillCoins NO restan del ledger: los Bs siguen en el banco.
 */
import { db, now } from '../config/firebase';
import { failedPrecondition, invalidArgument, notFound } from '../lib/errors';
import { generateToken } from '../lib/ids';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import { getConfig } from './settings';
import { dayKey } from './stats';
import {
  getAllBcvRatesMap,
  getOrResolveBcvRateForDate,
  isValidDateKey,
} from './bcvRates';
import type {
  BankLedgerAccountSummary,
  BankLedgerDailyBcvRow,
  BankLedgerEntry,
  BankLedgerQueryResult,
  BankLedgerSource,
  BankLedgerUsdBcvSummary,
  Order,
  PaymentMethod,
  TimestampLike,
} from '../types/models';

const BANK_LEDGER_COLLECTION = 'bankLedger';

const DEFAULT_FALLBACK_BANK = {
  code: '0102',
  name: 'Banco de Venezuela',
  idNumber: 'V-32463319',
  phone: '04222003851',
};

export interface BankSnapshotLike {
  code?: string | null;
  name?: string | null;
  idNumber?: string | null;
  phone?: string | null;
  accountNumber?: string | null;
}

export interface ResolvedBankAccount {
  accountKey: string;
  bankCode: string;
  bankName: string;
  cedula: string;
  phone: string;
  label: string;
}

export function normalizeBankCode(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  const match = s.match(/\b(0\d{3})\b/);
  if (match) return match[1];
  const digits = s.replace(/\D/g, '').slice(0, 4);
  return digits || '0102';
}

export function normalizeCedula(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return '';
  if (/^\d{6,10}$/.test(cleaned)) return `V${cleaned}`;
  return cleaned;
}

export function normalizeBankPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('58') && digits.length === 12) return `0${digits.slice(2)}`;
  if (/^[24]\d{9}$/.test(digits)) return `0${digits}`;
  return digits;
}

export function normalizeLedgerReference(raw: string | null | undefined): string {
  const rawStr = String(raw ?? '').trim();
  if (!rawStr) return '';
  const digits = rawStr.replace(/\D/g, '');
  if (digits.length >= 4) return digits;
  return rawStr.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function buildAccountKey(bankCode: string, cedula: string, phone: string): string {
  return `${bankCode}-${cedula}-${phone}`;
}

export function formatAccountLabel(account: {
  bankCode: string;
  bankName?: string;
  cedula: string;
  phone: string;
}): string {
  const bankPart = account.bankName ? `${account.bankCode} · ${account.bankName}` : account.bankCode;
  return `${bankPart} · ${account.cedula} · ${account.phone}`;
}

export function resolveBankAccount(
  snapshot?: BankSnapshotLike | null,
  fallbackBank?: BankSnapshotLike | null
): ResolvedBankAccount {
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

  const accountKey = buildAccountKey(bankCode, cedula, phone);
  return {
    accountKey,
    bankCode,
    bankName,
    cedula,
    phone,
    label: formatAccountLabel({ bankCode, bankName, cedula, phone }),
  };
}

export function inflowDocId(accountKey: string, cleanRef: string): string {
  return `inflow_${accountKey}_${cleanRef}`;
}

function parseAccountKey(accountKeyRaw: string): ResolvedBankAccount {
  const cleaned = String(accountKeyRaw ?? '').trim();
  const parts = cleaned.split('-').filter(Boolean);
  if (parts.length < 3) {
    throw invalidArgument('El identificador de cuenta bancaria (accountKey) no es válido.');
  }
  const bankCode = normalizeBankCode(parts[0]);
  const cedula = normalizeCedula(parts[1]);
  const phone = parts.slice(2).join('-');
  if (!bankCode || !cedula || !phone) {
    throw invalidArgument('El identificador de cuenta bancaria (accountKey) está incompleto.');
  }
  const bankName = bankCode === '0102' ? 'Banco de Venezuela' : `Banco ${bankCode}`;
  const accountKey = buildAccountKey(bankCode, cedula, phone);
  return {
    accountKey,
    bankCode,
    bankName,
    cedula,
    phone,
    label: formatAccountLabel({ bankCode, bankName, cedula, phone }),
  };
}

function toMillis(value: TimestampLike | unknown): number {
  if (value == null) return 0;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.toMillis === 'function') return (v.toMillis as () => number)();
    if (typeof v._seconds === 'number') return v._seconds * 1000 + Math.floor(Number(v._nanoseconds ?? 0) / 1e6);
    if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor(Number(v.nanoseconds ?? 0) / 1e6);
  }
  return 0;
}

function entryDayCaracas(entry: Pick<BankLedgerEntry, 'createdAt'>): string {
  const ms = toMillis(entry.createdAt);
  return ms > 0 ? dayKey(new Date(ms)) : '';
}

export interface RecordInflowInput {
  bankSnapshot?: BankSnapshotLike | null;
  fallbackBank?: BankSnapshotLike | null;
  paymentMethod?: PaymentMethod | string | null;
  amountBs: number;
  source: Exclude<BankLedgerSource, 'withdrawal'>;
  orderId?: string | null;
  orderCode?: string | null;
  reference: string;
  note?: string | null;
  bcvRateSnapshot?: number | null;
  createdAt?: TimestampLike | null;
  createdBy?: string | null;
}

export interface RecordInflowResult {
  recorded: boolean;
  duplicate: boolean;
  skippedReason?: string;
  docId?: string;
  accountKey?: string;
}

/**
 * Registra un ingreso verificado en Bs de forma estrictamente idempotente.
 * Nunca duplica un movimiento para la misma combinación `(accountKey, reference)`.
 */
export async function recordInflow(input: RecordInflowInput): Promise<RecordInflowResult> {
  if (input.paymentMethod === 'binance_pay' || input.paymentMethod === 'wallet') {
    return { recorded: false, duplicate: false, skippedReason: 'excluded_payment_method' };
  }

  const amountBs = round(Number(input.amountBs), 2);
  if (!Number.isFinite(amountBs) || amountBs <= 0) {
    return { recorded: false, duplicate: false, skippedReason: 'non_positive_amount' };
  }

  const cleanRef = normalizeLedgerReference(input.reference);
  if (!cleanRef) {
    return { recorded: false, duplicate: false, skippedReason: 'missing_reference' };
  }

  let fallbackBank = input.fallbackBank ?? null;
  if (!fallbackBank) {
    try {
      const config = await getConfig();
      fallbackBank = config.bank;
    } catch {
      fallbackBank = DEFAULT_FALLBACK_BANK;
    }
  }

  const resolved = resolveBankAccount(input.bankSnapshot, fallbackBank);
  const docId = inflowDocId(resolved.accountKey, cleanRef);
  const col = db.collection(BANK_LEDGER_COLLECTION);
  const ref = col.doc(docId);

  const entryCreatedAt = input.createdAt ?? now();
  const createdMs = toMillis(entryCreatedAt) || Date.now();
  const inflowDay = dayKey(new Date(createdMs));
  const rawFallback = Number(input.bcvRateSnapshot);
  const fallbackSnapshotRate =
    Number.isFinite(rawFallback) && rawFallback > 0 ? round(rawFallback, 4) : null;

  let bcvRateSnapshot: number | null = fallbackSnapshotRate;
  try {
    const resolvedBcv = await getOrResolveBcvRateForDate(inflowDay, {
      allowLiveFetch: inflowDay === dayKey(new Date()),
      updatedBy: input.createdBy ?? 'system',
      fallbackSnapshotRate,
    });
    if (resolvedBcv.rate !== null && resolvedBcv.rate > 0) {
      bcvRateSnapshot = resolvedBcv.rate;
    }
  } catch (err) {
    log.warn('No se pudo resolver bcvRateSnapshot al registrar ingreso', {
      inflowDay,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const created = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      return false;
    }

    const entry: Omit<BankLedgerEntry, 'id'> = {
      type: 'inflow',
      accountKey: resolved.accountKey,
      bankCode: resolved.bankCode,
      bankName: resolved.bankName,
      cedula: resolved.cedula,
      phone: resolved.phone,
      amountBs,
      source: input.source,
      orderId: input.orderId ?? null,
      orderCode: input.orderCode ?? null,
      reference: cleanRef,
      note: input.note?.trim() || null,
      bcvRateSnapshot,
      createdAt: entryCreatedAt,
      createdBy: input.createdBy ?? 'system',
    };

    tx.set(ref, entry);
    return true;
  });

  if (!created) {
    log.info('Ingreso bancario ya registrado (idempotente)', {
      docId,
      accountKey: resolved.accountKey,
      reference: `***${cleanRef.slice(-4)}`,
    });
  }

  return {
    recorded: created,
    duplicate: !created,
    docId,
    accountKey: resolved.accountKey,
  };
}

export interface RecordWithdrawalInput {
  accountKey: string;
  bankCode?: string | null;
  bankName?: string | null;
  cedula?: string | null;
  phone?: string | null;
  amountBs: number;
  note: string;
  reference?: string | null;
  createdBy: string;
}

/** Registra un retiro manual de fondos en Bs de una cuenta bancaria. */
export async function recordWithdrawal(input: RecordWithdrawalInput): Promise<BankLedgerEntry> {
  const amountBs = round(Number(input.amountBs), 2);
  if (!Number.isFinite(amountBs) || amountBs <= 0) {
    throw invalidArgument('El monto del retiro debe ser mayor a 0 Bs.');
  }

  const note = String(input.note ?? '').trim();
  if (!note) {
    throw invalidArgument('Indica una nota o concepto para el retiro.');
  }

  const parsed = parseAccountKey(input.accountKey);
  const bankCode = input.bankCode ? normalizeBankCode(input.bankCode) : parsed.bankCode;
  const cedula = input.cedula ? normalizeCedula(input.cedula) : parsed.cedula;
  const phone = input.phone ? normalizeBankPhone(input.phone) || parsed.phone : parsed.phone;
  const bankName = String(input.bankName || parsed.bankName).trim() || parsed.bankName;
  const accountKey = buildAccountKey(bankCode, cedula, phone);

  const docId = `wd_${Date.now()}_${generateToken(4)}`;
  const timestamp = now();
  const entryData: Omit<BankLedgerEntry, 'id'> = {
    type: 'withdrawal',
    accountKey,
    bankCode,
    bankName,
    cedula,
    phone,
    amountBs,
    source: 'withdrawal',
    orderId: null,
    orderCode: null,
    reference: input.reference?.trim() || null,
    note,
    createdAt: timestamp,
    createdBy: input.createdBy,
  };

  await db.collection(BANK_LEDGER_COLLECTION).doc(docId).set(entryData);
  return { id: docId, ...entryData };
}

/** Elimina un retiro mal anotado. Nunca permite borrar ingresos verificados. */
export async function deleteWithdrawal(id: string): Promise<BankLedgerEntry> {
  const cleanId = String(id ?? '').trim();
  if (!cleanId) {
    throw invalidArgument('ID de movimiento inválido.');
  }

  const ref = db.collection(BANK_LEDGER_COLLECTION).doc(cleanId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw notFound('Movimiento de caja no encontrado.');
    }

    const data = snap.data() as Omit<BankLedgerEntry, 'id'>;
    if (data.type !== 'withdrawal') {
      throw failedPrecondition('Solo se pueden eliminar retiros manuales, nunca ingresos verificados.');
    }

    tx.delete(ref);
    return { id: snap.id, ...data };
  });
}

function summarizeAccountEntries(
  account: ResolvedBankAccount,
  entries: BankLedgerEntry[],
  isActive: boolean,
  todayCaracas: string
): BankLedgerAccountSummary {
  let totalInflowBs = 0;
  let totalWithdrawalBs = 0;
  let todayInflowBs = 0;
  let webInflowCount = 0;
  let whatsappInflowCount = 0;
  let manualTransferInflowCount = 0;
  let withdrawalCount = 0;

  for (const entry of entries) {
    const amount = Number(entry.amountBs) || 0;
    if (entry.type === 'inflow') {
      totalInflowBs += amount;
      if (entryDayCaracas(entry) === todayCaracas) {
        todayInflowBs += amount;
      }
      if (entry.source === 'whatsapp') whatsappInflowCount += 1;
      else if (entry.source === 'manual_transfer') manualTransferInflowCount += 1;
      else webInflowCount += 1;
    } else if (entry.type === 'withdrawal') {
      totalWithdrawalBs += amount;
      withdrawalCount += 1;
    }
  }

  const totalIn = round(totalInflowBs, 2);
  const totalOut = round(totalWithdrawalBs, 2);

  return {
    accountKey: account.accountKey,
    bankCode: account.bankCode,
    bankName: account.bankName,
    cedula: account.cedula,
    phone: account.phone,
    label: account.label,
    isActive,
    totalInflowBs: totalIn,
    totalWithdrawalBs: totalOut,
    netBalanceBs: round(totalIn - totalOut, 2),
    todayInflowBs: round(todayInflowBs, 2),
    webInflowCount,
    whatsappInflowCount,
    manualTransferInflowCount,
    withdrawalCount,
  };
}

export interface GetLedgerReportOptions {
  accountKey?: string;
  from?: string;
  to?: string;
  valuationDate?: string;
}

/**
 * Devuelve el resumen completo de caja en Bs (saldo histórico neto, ingresos,
 * retiros, ingresado hoy), los movimientos filtrados por fecha descendente
 * y la valoración en USD a Tasa BCV Real (sin margen comercial).
 */
export async function getLedgerReport(
  options: GetLedgerReportOptions = {}
): Promise<BankLedgerQueryResult> {
  let activeBank: BankSnapshotLike = DEFAULT_FALLBACK_BANK;
  try {
    const config = await getConfig();
    activeBank = config.bank;
  } catch {
    activeBank = DEFAULT_FALLBACK_BANK;
  }

  const activeAccount = resolveBankAccount(activeBank, activeBank);
  const snap = await db.collection(BANK_LEDGER_COLLECTION).get();
  const entriesByAccount = new Map<string, { meta: ResolvedBankAccount; entries: BankLedgerEntry[] }>();

  entriesByAccount.set(activeAccount.accountKey, {
    meta: activeAccount,
    entries: [],
  });

  for (const doc of snap.docs) {
    const data = doc.data() as Omit<BankLedgerEntry, 'id'>;
    const entry: BankLedgerEntry = { id: doc.id, ...data };
    const key = entry.accountKey || activeAccount.accountKey;
    let bucket = entriesByAccount.get(key);
    if (!bucket) {
      const bankCode = normalizeBankCode(entry.bankCode);
      const cedula = normalizeCedula(entry.cedula) || 'SINCI';
      const phone = entry.phone || 'sintel';
      const bankName = entry.bankName || (bankCode === '0102' ? 'Banco de Venezuela' : `Banco ${bankCode}`);
      bucket = {
        meta: {
          accountKey: key,
          bankCode,
          bankName,
          cedula,
          phone,
          label: formatAccountLabel({ bankCode, bankName, cedula, phone }),
        },
        entries: [],
      };
      entriesByAccount.set(key, bucket);
    }
    bucket.entries.push(entry);
  }

  const todayCaracas = dayKey(new Date());
  const accounts: BankLedgerAccountSummary[] = [];
  for (const [key, bucket] of entriesByAccount.entries()) {
    accounts.push(
      summarizeAccountEntries(
        bucket.meta,
        bucket.entries,
        key === activeAccount.accountKey,
        todayCaracas
      )
    );
  }

  accounts.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.netBalanceBs - a.netBalanceBs;
  });

  const requestedKey = options.accountKey?.trim();
  const selectedAccountKey =
    requestedKey && entriesByAccount.has(requestedKey)
      ? requestedKey
      : activeAccount.accountKey;

  const selectedSummary =
    accounts.find((a) => a.accountKey === selectedAccountKey) ??
    summarizeAccountEntries(activeAccount, [], true, todayCaracas);

  const selectedEntries = entriesByAccount.get(selectedAccountKey)?.entries ?? [];
  const fromDate = options.from?.trim() || '';
  const toDate = options.to?.trim() || '';

  const movements = selectedEntries
    .filter((entry) => {
      if (!fromDate && !toDate) return true;
      const day = entryDayCaracas(entry);
      if (!day) return false;
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      return true;
    })
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  let filteredInflowBs = 0;
  let filteredWithdrawalBs = 0;
  for (const m of movements) {
    const amt = Number(m.amountBs) || 0;
    if (m.type === 'inflow') filteredInflowBs += amt;
    else if (m.type === 'withdrawal') filteredWithdrawalBs += amt;
  }

  const requestedValuationDate = options.valuationDate?.trim() || '';
  if (requestedValuationDate && !isValidDateKey(requestedValuationDate)) {
    throw invalidArgument('Fecha de valoración inválida. Usa YYYY-MM-DD.');
  }
  const valuationDate = requestedValuationDate || todayCaracas;

  const dayBuckets = new Map<
    string,
    {
      inflowBsRaw: number;
      withdrawalBsRaw: number;
      inflowCount: number;
      fallbackSnapshot: number | null;
      fallbackSnapshotMs: number;
    }
  >();

  for (const entry of selectedEntries) {
    const day = entryDayCaracas(entry);
    if (!day) continue;
    let bucket = dayBuckets.get(day);
    if (!bucket) {
      bucket = {
        inflowBsRaw: 0,
        withdrawalBsRaw: 0,
        inflowCount: 0,
        fallbackSnapshot: null,
        fallbackSnapshotMs: -1,
      };
      dayBuckets.set(day, bucket);
    }
    const amt = Number(entry.amountBs) || 0;
    if (entry.type === 'inflow') {
      bucket.inflowBsRaw += amt;
      bucket.inflowCount += 1;
      const snapRate = Number(entry.bcvRateSnapshot);
      const entryMs = toMillis(entry.createdAt);
      if (Number.isFinite(snapRate) && snapRate > 0 && entryMs >= bucket.fallbackSnapshotMs) {
        bucket.fallbackSnapshot = round(snapRate, 4);
        bucket.fallbackSnapshotMs = entryMs;
      }
    } else if (entry.type === 'withdrawal') {
      bucket.withdrawalBsRaw += amt;
    }
  }

  const knownRates = await getAllBcvRatesMap();
  const valuationFallbackSnapshot = dayBuckets.get(valuationDate)?.fallbackSnapshot ?? null;
  const valuationResolution = await getOrResolveBcvRateForDate(valuationDate, {
    knownRates,
    allowLiveFetch: valuationDate === todayCaracas,
    fallbackSnapshotRate: valuationFallbackSnapshot,
  });

  const sortedDays = Array.from(dayBuckets.keys()).sort((a, b) => a.localeCompare(b));
  const allDailyRows: BankLedgerDailyBcvRow[] = [];
  let rawDailySumUsd = 0;
  let unresolvedDaysCount = 0;

  for (const dateKey of sortedDays) {
    const bucket = dayBuckets.get(dateKey)!;
    const rateRes = await getOrResolveBcvRateForDate(dateKey, {
      knownRates,
      allowLiveFetch: dateKey === todayCaracas,
      fallbackSnapshotRate: bucket.fallbackSnapshot,
    });

    const inflowBs = round(bucket.inflowBsRaw, 2);
    const withdrawalBs = round(bucket.withdrawalBsRaw, 2);
    const netBs = round(inflowBs - withdrawalBs, 2);
    const bcvRate = rateRes.rate;
    const inflowUsd = bcvRate && bcvRate > 0 ? round(inflowBs / bcvRate, 2) : null;

    if (inflowBs > 0) {
      if (bcvRate && bcvRate > 0) {
        rawDailySumUsd += bucket.inflowBsRaw / bcvRate;
      } else {
        unresolvedDaysCount += 1;
      }
    }

    allDailyRows.push({
      dateKey,
      bcvRate,
      rateSource: rateRes.source,
      carriedFromDateKey: rateRes.carriedFromDateKey,
      inflowBs,
      inflowUsd,
      withdrawalBs,
      netBs,
      inflowCount: bucket.inflowCount,
    });
  }

  const dailyBreakdown =
    fromDate || toDate
      ? allDailyRows.filter((row) => {
          if (fromDate && row.dateKey < fromDate) return false;
          if (toDate && row.dateKey > toDate) return false;
          return true;
        })
      : allDailyRows;

  const valuationRate = valuationResolution.rate;
  const totalInflowUsdAtDate =
    valuationRate && valuationRate > 0
      ? round(selectedSummary.totalInflowBs / valuationRate, 2)
      : null;
  const netBalanceUsdAtDate =
    valuationRate && valuationRate > 0
      ? round(selectedSummary.netBalanceBs / valuationRate, 2)
      : null;
  const totalInflowUsdDailySum = round(rawDailySumUsd, 2);
  const exchangeDiffUsd =
    totalInflowUsdAtDate !== null
      ? round(totalInflowUsdAtDate - totalInflowUsdDailySum, 2)
      : null;

  const usdBcvSummary: BankLedgerUsdBcvSummary = {
    valuationDate,
    valuationRate,
    valuationRateSource: valuationResolution.source,
    valuationCarriedFromDateKey: valuationResolution.carriedFromDateKey,
    dailyBreakdown,
    allAtValuationDate: {
      totalInflowBs: selectedSummary.totalInflowBs,
      totalInflowUsdAtDate,
      netBalanceBs: selectedSummary.netBalanceBs,
      netBalanceUsdAtDate,
    },
    summedByDailyRate: {
      totalInflowBs: selectedSummary.totalInflowBs,
      totalInflowUsdDailySum,
      exchangeDiffUsd,
      unresolvedDaysCount,
    },
  };

  return {
    activeAccountKey: activeAccount.accountKey,
    selectedAccountKey,
    accounts,
    summary: selectedSummary,
    filteredInflowBs: round(filteredInflowBs, 2),
    filteredWithdrawalBs: round(filteredWithdrawalBs, 2),
    movements,
    usdBcvSummary,
  };
}

/** Utilidad para derivar los movimientos de caja a partir de un doc `Order` legado. */
export function extractOrderInflows(
  order: Partial<Order> & { id: string },
  fallbackBank?: BankSnapshotLike | null
): Array<{
  amountBs: number;
  reference: string;
  source: Exclude<BankLedgerSource, 'withdrawal'>;
  bankSnapshot: BankSnapshotLike;
  createdAt: TimestampLike;
  note: string | null;
}> {
  const method = order.payment?.method;
  if (method === 'binance_pay' || method === 'wallet') return [];

  const isWhatsapp =
    order.canal === 'WHATSAPP' ||
    order.origen === 'WHATSAPP' ||
    String(order.id).startsWith('wa_') ||
    String(order.uid ?? '').startsWith('whatsapp:');
  const source: Exclude<BankLedgerSource, 'withdrawal'> = isWhatsapp
    ? 'whatsapp'
    : method === 'transfer'
      ? 'manual_transfer'
      : 'web';

  const bankSnapshot: BankSnapshotLike = order.payment?.bankSnapshot ?? fallbackBank ?? DEFAULT_FALLBACK_BANK;
  const results: Array<{
    amountBs: number;
    reference: string;
    source: Exclude<BankLedgerSource, 'withdrawal'>;
    bankSnapshot: BankSnapshotLike;
    createdAt: TimestampLike;
    note: string | null;
  }> = [];

  const partials = Array.isArray(order.payment?.partials) ? order.payment.partials : [];
  const seenRefs = new Set<string>();
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
      createdAt: p.verifiedAt ?? order.payment?.verifiedAt ?? order.createdAt ?? now(),
      note: partials.length > 1 || !order.payment?.verifiedAt ? 'Abono parcial verificado' : null,
    });
  }

  const finalRef = normalizeLedgerReference(order.payment?.reference ?? order.referencia);
  const isVerified = Boolean(order.payment?.verifiedAt) || (isWhatsapp && Number(order.payment?.paidBs ?? order.montoBs ?? 0) > 0);
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
        createdAt: order.payment?.verifiedAt ?? order.createdAt ?? now(),
        note: null,
      });
    }
  }

  return results;
}
