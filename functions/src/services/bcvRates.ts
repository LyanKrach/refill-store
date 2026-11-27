/**
 * Histórico diario de tasa oficial pura del BCV (`bcvRates/{YYYY-MM-DD}`).
 *
 * REGLA ESTRICTA:
 *  - Aquí se guarda y resuelve ÚNICAMENTE la tasa BCV oficial pura (sin el margen
 *    comercial / `markupPercent` que usa la tienda para vender).
 *  - Todas las claves de fecha usan estrictamente la zona horaria `America/Caracas` (`UTC-4`).
 *  - Una tasa marcada como `manual` nunca se sobrescribe automáticamente.
 */
import { COLLECTIONS, db, now } from '../config/firebase';
import { invalidArgument } from '../lib/errors';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import type { BcvRateRecord, BcvRateSource } from '../types/models';
import { fetchReferenceRate } from './rate';
import { dayKey } from './stats';

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateKey(raw: string): boolean {
  const match = DATE_KEY_RE.exec(raw);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

export function todayCaracasKey(date: Date = new Date()): string {
  return dayKey(date);
}

const bcvRatesCol = () => db.collection(COLLECTIONS.bcvRates);

export async function getAllBcvRatesMap(): Promise<Map<string, BcvRateRecord>> {
  const snap = await bcvRatesCol().get();
  const map = new Map<string, BcvRateRecord>();
  for (const doc of snap.docs) {
    const data = doc.data() as Partial<BcvRateRecord> | undefined;
    const key = data?.dateKey && isValidDateKey(data.dateKey) ? data.dateKey : doc.id;
    const rate = Number(data?.rate);
    if (!isValidDateKey(key) || !Number.isFinite(rate) || rate <= 0) continue;
    map.set(key, {
      dateKey: key,
      rate: round(rate, 4),
      source: (data?.source as BcvRateSource) || 'auto',
      updatedAt: data?.updatedAt ?? now(),
      updatedBy: data?.updatedBy ?? null,
      provider: data?.provider ?? null,
      carriedFromDateKey: data?.carriedFromDateKey ?? null,
    });
  }
  return map;
}

export async function setManualBcvRate(
  dateKey: string,
  rate: number,
  updatedBy: string | null
): Promise<{ saved: BcvRateRecord; previousRate: number | null }> {
  if (!isValidDateKey(dateKey)) {
    throw invalidArgument('Fecha inválida. Usa formato YYYY-MM-DD.');
  }
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0) {
    throw invalidArgument('La tasa BCV debe ser un número positivo.');
  }

  const cleanRate = round(numericRate, 4);
  const ref = bcvRatesCol().doc(dateKey);
  const prevSnap = await ref.get();
  const prevRaw = prevSnap.exists ? Number((prevSnap.data() as Partial<BcvRateRecord>)?.rate) : NaN;
  const previousRate = Number.isFinite(prevRaw) && prevRaw > 0 ? round(prevRaw, 4) : null;

  const record: BcvRateRecord = {
    dateKey,
    rate: cleanRate,
    source: 'manual',
    provider: null,
    carriedFromDateKey: null,
    updatedAt: now(),
    updatedBy: updatedBy ?? null,
  };

  await ref.set(record);
  return { saved: record, previousRate };
}

export interface ResolveBcvRateOptions {
  knownRates?: Map<string, BcvRateRecord>;
  allowLiveFetch?: boolean;
  updatedBy?: string | null;
  fallbackSnapshotRate?: number | null;
}

export interface ResolvedBcvRate {
  dateKey: string;
  rate: number | null;
  source: BcvRateSource | null;
  carriedFromDateKey: string | null;
}

function findLatestPriorRate(
  ratesMap: Map<string, BcvRateRecord>,
  targetDateKey: string
): BcvRateRecord | null {
  let best: BcvRateRecord | null = null;
  for (const [key, rec] of ratesMap.entries()) {
    if (key < targetDateKey && rec.rate > 0) {
      if (!best || key > best.dateKey) {
        best = rec;
      }
    }
  }
  return best;
}

/**
 * Resuelve la tasa BCV oficial pura para `dateKey` (`YYYY-MM-DD`, hora Caracas):
 *  1. Si existe registro `manual` o `auto` en `bcvRates/{dateKey}`, lo devuelve sin sobrescribirlo.
 *  2. Si `dateKey` es hoy (Caracas) y se permite consulta en vivo, consulta `fetchReferenceRate()`
 *     (tasa pura sin margen comercial) y la guarda en `bcvRates/{dateKey}` (respetando `manual`).
 *  3. Si existe un registro `carry_forward` guardado, lo devuelve.
 *  4. Si es fin de semana/feriado/día sin publicación propia, hereda (`carry_forward`) la última
 *     tasa anterior disponible en `bcvRates`.
 *  5. Si tampoco hay histórico anterior, usa `fallbackSnapshotRate` (ej. respaldo de un movimiento)
 *     si fue provisto.
 */
export async function getOrResolveBcvRateForDate(
  dateKey: string,
  options: ResolveBcvRateOptions = {}
): Promise<ResolvedBcvRate> {
  if (!isValidDateKey(dateKey)) {
    throw invalidArgument('Fecha inválida para resolver tasa BCV. Usa YYYY-MM-DD.');
  }

  let existing: BcvRateRecord | null = null;
  if (options.knownRates) {
    existing = options.knownRates.get(dateKey) ?? null;
  } else {
    const snap = await bcvRatesCol().doc(dateKey).get();
    if (snap.exists) {
      const data = snap.data() as Partial<BcvRateRecord>;
      const r = Number(data?.rate);
      if (Number.isFinite(r) && r > 0) {
        existing = {
          dateKey,
          rate: round(r, 4),
          source: (data?.source as BcvRateSource) || 'auto',
          updatedAt: data?.updatedAt ?? now(),
          updatedBy: data?.updatedBy ?? null,
          provider: data?.provider ?? null,
          carriedFromDateKey: data?.carriedFromDateKey ?? null,
        };
      }
    }
  }

  if (existing && (existing.source === 'manual' || existing.source === 'auto')) {
    return {
      dateKey,
      rate: existing.rate,
      source: existing.source,
      carriedFromDateKey: null,
    };
  }

  const today = todayCaracasKey();
  if (dateKey === today && options.allowLiveFetch !== false) {
    const reference = await fetchReferenceRate().catch((err) => {
      log.warn('No se pudo consultar tasa BCV pura en vivo', {
        dateKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    if (reference && Number.isFinite(reference.value) && reference.value > 0) {
      const cleanRate = round(reference.value, 4);
      const ref = bcvRatesCol().doc(dateKey);

      const savedOrExisting = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          const data = snap.data() as Partial<BcvRateRecord>;
          const currentRate = Number(data?.rate);
          if (data?.source === 'manual' && Number.isFinite(currentRate) && currentRate > 0) {
            return {
              dateKey,
              rate: round(currentRate, 4),
              source: 'manual' as BcvRateSource,
              updatedAt: data.updatedAt ?? now(),
              updatedBy: data.updatedBy ?? null,
              provider: null,
              carriedFromDateKey: null,
            } satisfies BcvRateRecord;
          }
        }

        const record: BcvRateRecord = {
          dateKey,
          rate: cleanRate,
          source: 'auto',
          provider: reference.source,
          carriedFromDateKey: null,
          updatedAt: now(),
          updatedBy: options.updatedBy ?? 'system',
        };
        tx.set(ref, record);
        return record;
      });

      if (options.knownRates) {
        options.knownRates.set(dateKey, savedOrExisting);
      }

      return {
        dateKey,
        rate: savedOrExisting.rate,
        source: savedOrExisting.source,
        carriedFromDateKey: null,
      };
    }
  }

  if (existing && existing.source === 'carry_forward' && existing.rate > 0) {
    return {
      dateKey,
      rate: existing.rate,
      source: 'carry_forward',
      carriedFromDateKey: existing.carriedFromDateKey ?? null,
    };
  }

  const ratesMap = options.knownRates ?? (await getAllBcvRatesMap());
  const prior = findLatestPriorRate(ratesMap, dateKey);
  if (prior) {
    return {
      dateKey,
      rate: prior.rate,
      source: 'carry_forward',
      carriedFromDateKey: prior.dateKey,
    };
  }

  const snapshotFallback = Number(options.fallbackSnapshotRate);
  if (Number.isFinite(snapshotFallback) && snapshotFallback > 0) {
    return {
      dateKey,
      rate: round(snapshotFallback, 4),
      source: 'carry_forward',
      carriedFromDateKey: null,
    };
  }

  return {
    dateKey,
    rate: null,
    source: null,
    carriedFromDateKey: null,
  };
}

/** Asegura que la tasa BCV oficial pura de hoy quede registrada en `bcvRates/{YYYY-MM-DD}`. */
export async function ensureTodayBcvRate(): Promise<ResolvedBcvRate | null> {
  const today = todayCaracasKey();
  try {
    return await getOrResolveBcvRateForDate(today, { allowLiveFetch: true, updatedBy: 'system' });
  } catch (err) {
    log.warn('Error asegurando tasa BCV diaria', {
      dateKey: today,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
