import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Check,
  DollarSign,
  Download,
  Landmark,
  Pencil,
  RefreshCw,
  Scale,
  Trash2,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import {
  useAdminBankLedger,
  useCreateBankWithdrawal,
  useDeleteBankWithdrawal,
  useUpsertBcvRate,
} from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, Skeleton } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatDateTime, formatNumber, formatUsd, toDate } from '@/lib/format';
import type {
  BankLedgerEntry,
  BankLedgerSource,
  BankLedgerUsdBcvSummary,
  BcvRateSource,
} from '@/types/models';

const SOURCE_META: Record<BankLedgerSource, { label: string; className: string }> = {
  web: {
    label: 'Web',
    className: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  },
  whatsapp: {
    label: 'WhatsApp',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  },
  manual_transfer: {
    label: 'Transferencia',
    className: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300',
  },
  withdrawal: {
    label: 'Retiro',
    className: 'border-rose-500/30 bg-rose-500/15 text-rose-300',
  },
};

const RATE_SOURCE_META: Record<BcvRateSource, { label: string; className: string }> = {
  auto: {
    label: 'Auto BCV',
    className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
  },
  manual: {
    label: 'Manual',
    className: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  },
  carry_forward: {
    label: 'Heredada',
    className: 'border-slate-500/30 bg-slate-500/15 text-slate-300',
  },
};

function dateKeyCaracasFromDate(dt: Date | null): string {
  if (!dt) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dt);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  return y && m && d ? `${y}-${m}-${d}` : '';
}

function formatBcvRate(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '—';
  return `${new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(rate)} Bs/$`;
}

function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (/[",\n\r;]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadCsv(
  movements: BankLedgerEntry[],
  accountKey: string,
  summary: {
    totalInflowBs: number;
    totalWithdrawalBs: number;
    netBalanceBs: number;
  },
  usdBcvSummary?: BankLedgerUsdBcvSummary
) {
  const rateByDay = new Map<string, number>();
  for (const row of usdBcvSummary?.dailyBreakdown ?? []) {
    if (row.bcvRate && row.bcvRate > 0) {
      rateByDay.set(row.dateKey, row.bcvRate);
    }
  }

  const header = [
    'FechaHoraCaracas',
    'Tipo',
    'Origen',
    'Referencia',
    'Orden',
    'ConceptoNota',
    'MontoBs',
    'Tasa BCV Real',
    'Equivalente USD BCV',
    'Cuenta',
    'RegistradoPor',
  ];

  const rows = movements.map((m) => {
    const dt = toDate(m.createdAt);
    const fecha = dt
      ? new Intl.DateTimeFormat('es-VE', {
          dateStyle: 'short',
          timeStyle: 'medium',
          timeZone: 'America/Caracas',
        }).format(dt)
      : '';
    const day = dateKeyCaracasFromDate(dt);
    const rate =
      (day ? rateByDay.get(day) : undefined) ??
      (m.bcvRateSnapshot && m.bcvRateSnapshot > 0 ? m.bcvRateSnapshot : undefined);
    const signedAmount =
      m.type === 'withdrawal' ? -Math.abs(m.amountBs) : Math.abs(m.amountBs);
    const usdEq = rate && rate > 0 ? (signedAmount / rate).toFixed(2) : '';

    return [
      fecha,
      m.type === 'withdrawal' ? 'Retiro' : 'Ingreso',
      SOURCE_META[m.source]?.label ?? m.source,
      m.reference ?? '',
      m.orderCode ?? m.orderId ?? '',
      m.note ?? '',
      signedAmount.toFixed(2),
      rate && rate > 0 ? rate.toFixed(4) : '',
      usdEq,
      m.accountKey,
      m.createdBy ?? '',
    ]
      .map(csvEscape)
      .join(',');
  });

  rows.push('');
  rows.push(
    ['RESUMEN CUENTA', '', '', '', '', 'Total ingresado', summary.totalInflowBs.toFixed(2), '', '', accountKey, '']
      .map(csvEscape)
      .join(',')
  );
  rows.push(
    ['RESUMEN CUENTA', '', '', '', '', 'Total retirado', (-summary.totalWithdrawalBs).toFixed(2), '', '', accountKey, '']
      .map(csvEscape)
      .join(',')
  );
  rows.push(
    ['RESUMEN CUENTA', '', '', '', '', 'Saldo neto en cuenta', summary.netBalanceBs.toFixed(2), '', '', accountKey, '']
      .map(csvEscape)
      .join(',')
  );

  if (usdBcvSummary) {
    const valRate = usdBcvSummary.valuationRate;
    rows.push(
      [
        'RESUMEN USD BCV',
        '',
        '',
        '',
        '',
        `Total ingresado a tasa del ${usdBcvSummary.valuationDate}`,
        usdBcvSummary.allAtValuationDate.totalInflowBs.toFixed(2),
        valRate ? valRate.toFixed(4) : '',
        usdBcvSummary.allAtValuationDate.totalInflowUsdAtDate !== null
          ? usdBcvSummary.allAtValuationDate.totalInflowUsdAtDate.toFixed(2)
          : '',
        accountKey,
        '',
      ]
        .map(csvEscape)
        .join(',')
    );
    rows.push(
      [
        'RESUMEN USD BCV',
        '',
        '',
        '',
        '',
        `Saldo neto a tasa del ${usdBcvSummary.valuationDate}`,
        usdBcvSummary.allAtValuationDate.netBalanceBs.toFixed(2),
        valRate ? valRate.toFixed(4) : '',
        usdBcvSummary.allAtValuationDate.netBalanceUsdAtDate !== null
          ? usdBcvSummary.allAtValuationDate.netBalanceUsdAtDate.toFixed(2)
          : '',
        accountKey,
        '',
      ]
        .map(csvEscape)
        .join(',')
    );
    rows.push(
      [
        'RESUMEN USD BCV',
        '',
        '',
        '',
        '',
        'Total ingresado sumado por tasa diaria histórica',
        usdBcvSummary.summedByDailyRate.totalInflowBs.toFixed(2),
        '',
        usdBcvSummary.summedByDailyRate.totalInflowUsdDailySum.toFixed(2),
        accountKey,
        '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  const csvContent = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `caja-bs-${accountKey}-${today}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function AdminBankLedger() {
  useDocumentTitle('Caja Bs (Cuentas) · Admin');

  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [valuationDate, setValuationDate] = useState<string>('');
  const [selectedDay, setSelectedDay] = useState<string>('');
  const [dailyRangeFrom, setDailyRangeFrom] = useState<string>('');
  const [dailyRangeTo, setDailyRangeTo] = useState<string>('');
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);
  const [editingRateValue, setEditingRateValue] = useState<string>('');

  const [amountInput, setAmountInput] = useState<string>('');
  const [noteInput, setNoteInput] = useState<string>('');
  const [refInput, setRefInput] = useState<string>('');

  const ledgerQuery = useAdminBankLedger({
    accountKey: selectedAccount || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    valuationDate: valuationDate || undefined,
  });

  const createWithdrawal = useCreateBankWithdrawal();
  const deleteWithdrawal = useDeleteBankWithdrawal();
  const upsertBcvRate = useUpsertBcvRate();

  const report = ledgerQuery.data;
  const activeKey = report?.selectedAccountKey ?? report?.activeAccountKey ?? '';

  const accountOptions = useMemo(() => {
    if (!report?.accounts?.length) return [];
    return report.accounts.map((acc) => ({
      value: acc.accountKey,
      label: `${acc.isActive ? '★ Activa · ' : ''}${acc.label} (${formatBs(acc.netBalanceBs)})`,
    }));
  }, [report?.accounts]);

  async function handleRegisterWithdrawal(e: FormEvent) {
    e.preventDefault();
    if (!activeKey) {
      toast.error('Selecciona una cuenta bancaria.');
      return;
    }

    const normalized = amountInput.trim().replace(/\s+/g, '').replace(',', '.');
    const amountBs = Number(normalized);
    if (!Number.isFinite(amountBs) || amountBs <= 0) {
      toast.error('Ingresa un monto válido en Bs mayor a 0.');
      return;
    }

    const note = noteInput.trim();
    if (!note) {
      toast.error('Indica una nota o concepto para el retiro.');
      return;
    }

    try {
      await createWithdrawal.mutateAsync({
        accountKey: activeKey,
        amountBs,
        note,
        reference: refInput.trim() || null,
      });
      toast.success(`Retiro de ${formatBs(amountBs)} registrado`);
      setAmountInput('');
      setNoteInput('');
      setRefInput('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar el retiro.');
    }
  }

  async function handleDeleteWithdrawal(entry: BankLedgerEntry) {
    const confirmed = window.confirm(
      `¿Eliminar este retiro de ${formatBs(entry.amountBs)} (${entry.note ?? 'sin nota'})?`
    );
    if (!confirmed) return;

    try {
      await deleteWithdrawal.mutateAsync(entry.id);
      toast.success('Retiro eliminado');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo eliminar el retiro.');
    }
  }

  const summary = report?.summary;
  const movements = report?.movements ?? [];
  const usdBcv = report?.usdBcvSummary;

  const filteredDailyRows = useMemo(() => {
    const rows = usdBcv?.dailyBreakdown ?? [];
    if (selectedDay) {
      return rows.filter((r) => r.dateKey === selectedDay);
    }
    if (dailyRangeFrom || dailyRangeTo) {
      return rows.filter((r) => {
        if (dailyRangeFrom && r.dateKey < dailyRangeFrom) return false;
        if (dailyRangeTo && r.dateKey > dailyRangeTo) return false;
        return true;
      });
    }
    return rows;
  }, [usdBcv?.dailyBreakdown, selectedDay, dailyRangeFrom, dailyRangeTo]);

  const selectedDayRow = useMemo(() => {
    if (!selectedDay) return null;
    return usdBcv?.dailyBreakdown.find((r) => r.dateKey === selectedDay) ?? null;
  }, [usdBcv?.dailyBreakdown, selectedDay]);

  function startEditRate(dateKey: string, currentRate: number | null | undefined) {
    setEditingDateKey(dateKey);
    setEditingRateValue(currentRate && currentRate > 0 ? String(currentRate) : '');
  }

  async function handleSaveBcvRate(dateKey: string) {
    const normalized = editingRateValue.trim().replace(/\s+/g, '').replace(',', '.');
    const rate = Number(normalized);
    if (!Number.isFinite(rate) || rate <= 0) {
      toast.error('Ingresa una tasa BCV válida mayor a 0.');
      return;
    }

    try {
      await upsertBcvRate.mutateAsync({ dateKey, rate });
      toast.success(`Tasa BCV real de ${dateKey} guardada: ${rate.toFixed(4)} Bs/$`);
      setEditingDateKey(null);
      setEditingRateValue('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la tasa BCV.');
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Caja Bs (Cuentas)</h1>
          <p className="mt-1 text-sm text-slate-400">
            Conteo real al céntimo de bolívares acreditados (Web + WhatsApp) y retiros por cuenta bancaria.
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          {accountOptions.length > 0 && (
            <Select
              label="Cuenta bancaria"
              value={activeKey}
              onChange={(e) => setSelectedAccount(e.target.value)}
              options={accountOptions}
              containerClassName="min-w-0 sm:min-w-[340px]"
            />
          )}
          <Button
            type="button"
            variant="secondary"
            size="md"
            leftIcon={<RefreshCw className="h-4 w-4" />}
            loading={ledgerQuery.isFetching}
            onClick={() => void ledgerQuery.refetch()}
          >
            Actualizar
          </Button>
        </div>
      </div>

      {ledgerQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : ledgerQuery.isError || !summary ? (
        <Card>
          <EmptyState
            icon={<Landmark className="h-8 w-8 text-slate-400" />}
            title="No se pudo cargar la caja en Bs"
            description="Intenta recargar en unos segundos."
            action={
              <Button variant="secondary" size="sm" onClick={() => void ledgerQuery.refetch()}>
                Reintentar
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Saldo tuyo en cuenta (Bs)"
              value={formatBs(summary.netBalanceBs)}
              hint={`Web: ${formatNumber(summary.webInflowCount + summary.manualTransferInflowCount)} · WA: ${formatNumber(summary.whatsappInflowCount)}`}
              icon={<Wallet className="h-5 w-5" />}
              accent="emerald"
              className="ring-1 ring-emerald-500/40"
            />
            <StatCard
              label="Total ingresado (Bs)"
              value={formatBs(summary.totalInflowBs)}
              hint={`${formatNumber(summary.webInflowCount + summary.whatsappInflowCount + summary.manualTransferInflowCount)} pagos verificados`}
              icon={<ArrowDownLeft className="h-5 w-5" />}
              accent="blue"
            />
            <StatCard
              label="Total retirado (Bs)"
              value={formatBs(summary.totalWithdrawalBs)}
              hint={`${formatNumber(summary.withdrawalCount)} retiros registrados`}
              icon={<ArrowUpRight className="h-5 w-5" />}
              accent="danger"
            />
            <StatCard
              label="Ingresado hoy (Bs)"
              value={formatBs(summary.todayInflowBs)}
              hint="Hora Caracas (America/Caracas)"
              icon={<TrendingUp className="h-5 w-5" />}
              accent="amber"
            />
          </div>

          {usdBcv && (
            <section className="min-w-0 space-y-4 rounded-2xl border border-base-600/80 bg-base-900/50 p-3.5 sm:p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="flex items-center gap-2 font-display text-lg font-bold text-white">
                    <DollarSign className="h-5 w-5 text-emerald-400" />
                    Equivalente en USD (Tasa BCV Real)
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Calculado estrictamente con la tasa oficial pura del BCV (sin el margen comercial de la web), agrupado en hora Caracas (UTC-4).
                  </p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {/* Bloque 2: Todo el Total a la Tasa de un Día */}
                <Card className="min-w-0 border-sky-500/30 bg-base-900/80">
                  <CardHeader
                    title="Todo el total a la tasa de un día"
                    description="Valora todo el histórico ingresado y el saldo neto actual usando una única tasa BCV real."
                    icon={<Calendar className="h-5 w-5 text-sky-400" />}
                  />
                  <div className="space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <Input
                        label="Fecha de tasa de referencia"
                        type="date"
                        value={valuationDate || usdBcv.valuationDate}
                        onChange={(e) => setValuationDate(e.target.value)}
                        containerClassName="min-w-0 flex-1"
                        className="max-w-full"
                      />
                      <div className="flex min-w-0 items-center gap-2 pb-1">
                        {editingDateKey === `val:${usdBcv.valuationDate}` ? (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editingRateValue}
                              onChange={(e) => setEditingRateValue(e.target.value)}
                              placeholder="Tasa BCV"
                              className="min-w-0 flex-1 rounded-lg border border-base-500 bg-base-800 px-2.5 py-1.5 text-xs text-white focus:border-sky-400 focus:outline-none sm:w-28 sm:flex-none"
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="primary"
                              loading={upsertBcvRate.isPending}
                              onClick={() => void handleSaveBcvRate(usdBcv.valuationDate)}
                              title="Guardar tasa"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingDateKey(null)}
                              title="Cancelar"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-base-600 bg-base-800/80 px-3 py-2 text-xs">
                              <span className="text-slate-400">Tasa BCV ({usdBcv.valuationDate}): </span>
                              <span className="font-semibold text-white">
                                {formatBcvRate(usdBcv.valuationRate)}
                              </span>
                              {usdBcv.valuationRateSource && (
                                <span
                                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${RATE_SOURCE_META[usdBcv.valuationRateSource].className}`}
                                >
                                  {RATE_SOURCE_META[usdBcv.valuationRateSource].label}
                                </span>
                              )}
                            </div>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="shrink-0"
                              title="Editar tasa BCV de la fecha de referencia"
                              onClick={() =>
                                startEditRate(`val:${usdBcv.valuationDate}`, usdBcv.valuationRate)
                              }
                            >
                              <Pencil className="h-3.5 w-3.5 text-slate-300" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-base-600/80 bg-base-800/50 p-3.5">
                        <p className="text-xs text-slate-400">Total Ingresado (Bs → USD)</p>
                        <p className="mt-1 text-xs font-medium text-slate-300 tabular">
                          {formatBs(usdBcv.allAtValuationDate.totalInflowBs)}
                        </p>
                        <p className="mt-0.5 font-display text-xl font-bold text-sky-300 tabular">
                          {usdBcv.allAtValuationDate.totalInflowUsdAtDate !== null
                            ? formatUsd(usdBcv.allAtValuationDate.totalInflowUsdAtDate)
                            : 'Sin tasa BCV'}
                        </p>
                      </div>
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5">
                        <p className="text-xs text-slate-400">Saldo Neto en Cuenta (Bs → USD)</p>
                        <p className="mt-1 text-xs font-medium text-slate-300 tabular">
                          {formatBs(usdBcv.allAtValuationDate.netBalanceBs)}
                        </p>
                        <p className="mt-0.5 font-display text-xl font-bold text-emerald-300 tabular">
                          {usdBcv.allAtValuationDate.netBalanceUsdAtDate !== null
                            ? formatUsd(usdBcv.allAtValuationDate.netBalanceUsdAtDate)
                            : 'Sin tasa BCV'}
                        </p>
                      </div>
                    </div>
                  </div>
                </Card>

                {/* Bloque 3: Suma de Ingresos por Día (Tasa Histórica Diaria) */}
                <Card className="min-w-0 border-amber-500/30 bg-base-900/80">
                  <CardHeader
                    title="Suma de ingresos por día (tasa histórica)"
                    description="Acumula Día 1 Bs / tasa Día 1 + Día 2 Bs / tasa Día 2 + … con la tasa BCV real de cada jornada."
                    icon={<Scale className="h-5 w-5 text-amber-400" />}
                  />
                  <div className="space-y-4">
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                      <p className="text-xs text-slate-400">
                        Total ingresado sumado por tasa diaria
                      </p>
                      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
                        <p className="font-display text-2xl font-bold text-amber-300 tabular">
                          {formatUsd(usdBcv.summedByDailyRate.totalInflowUsdDailySum)}
                        </p>
                        <span className="text-xs text-slate-300 tabular">
                          Base: {formatBs(usdBcv.summedByDailyRate.totalInflowBs)}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-xl border border-base-600/80 bg-base-800/50 p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-slate-400">
                          Diferencia cambiaria vs. tasa del {usdBcv.valuationDate}
                        </span>
                        <span
                          className={`text-sm font-bold tabular ${
                            usdBcv.summedByDailyRate.exchangeDiffUsd === null
                              ? 'text-slate-400'
                              : usdBcv.summedByDailyRate.exchangeDiffUsd >= 0
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                          }`}
                        >
                          {usdBcv.summedByDailyRate.exchangeDiffUsd === null
                            ? '—'
                            : `${usdBcv.summedByDailyRate.exchangeDiffUsd >= 0 ? '+' : '-'}${formatUsd(
                                Math.abs(usdBcv.summedByDailyRate.exchangeDiffUsd)
                              )}`}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {usdBcv.summedByDailyRate.exchangeDiffUsd === null
                          ? 'Asigna una tasa BCV a la fecha de referencia para calcular el efecto cambiario.'
                          : usdBcv.summedByDailyRate.exchangeDiffUsd < 0
                            ? 'La devaluación redujo el valor en USD de los bolívares ingresados frente a su valor histórico diario.'
                            : 'El equivalente a la tasa de referencia supera o iguala la suma histórica diaria.'}
                      </p>
                      {usdBcv.summedByDailyRate.unresolvedDaysCount > 0 && (
                        <p className="mt-2 text-xs font-medium text-amber-300">
                          ⚠️ {usdBcv.summedByDailyRate.unresolvedDaysCount} día(s) con ingresos aún no tienen tasa BCV asignada; edítalos en la tabla de abajo.
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              </div>

              {/* Bloque 1: Filtro por Día (Detalle Diario) */}
              <Card className="min-w-0">
                <CardHeader
                  title="Filtro por día (detalle diario)"
                  description="Consulta cuánto entró cada día en Bs y su equivalente en USD a la tasa BCV real de esa fecha."
                  icon={<TrendingUp className="h-5 w-5 text-emerald-400" />}
                />

                <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Input
                    label="Día puntual"
                    type="date"
                    value={selectedDay}
                    onChange={(e) => setSelectedDay(e.target.value)}
                  />
                  <Input
                    label="Rango desde"
                    type="date"
                    value={dailyRangeFrom}
                    disabled={Boolean(selectedDay)}
                    onChange={(e) => setDailyRangeFrom(e.target.value)}
                  />
                  <Input
                    label="Rango hasta"
                    type="date"
                    value={dailyRangeTo}
                    disabled={Boolean(selectedDay)}
                    onChange={(e) => setDailyRangeTo(e.target.value)}
                  />
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="md"
                      fullWidth
                      disabled={!selectedDay && !dailyRangeFrom && !dailyRangeTo}
                      onClick={() => {
                        setSelectedDay('');
                        setDailyRangeFrom('');
                        setDailyRangeTo('');
                      }}
                    >
                      Limpiar filtro
                    </Button>
                  </div>
                </div>

                {selectedDay && (
                  <div className="mb-4 break-words rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5 text-sm text-emerald-100">
                    {selectedDayRow ? (
                      selectedDayRow.bcvRate ? (
                        <span>
                          El <strong>{selectedDay}</strong> a tasa BCV{' '}
                          <strong>{formatBcvRate(selectedDayRow.bcvRate)}</strong> entraron{' '}
                          <strong>{formatBs(selectedDayRow.inflowBs)}</strong> ={' '}
                          <strong className="text-emerald-300">
                            {formatUsd(selectedDayRow.inflowUsd)} USD
                          </strong>
                        </span>
                      ) : (
                        <span>
                          El <strong>{selectedDay}</strong> entraron{' '}
                          <strong>{formatBs(selectedDayRow.inflowBs)}</strong>, pero no hay tasa BCV registrada para ese día. Usa el botón de lápiz para fijarla.
                        </span>
                      )
                    ) : (
                      <span>
                        El <strong>{selectedDay}</strong> no se registraron ingresos en esta cuenta.
                      </span>
                    )}
                  </div>
                )}

                {filteredDailyRows.length === 0 ? (
                  <EmptyState
                    icon={<Calendar className="h-8 w-8 text-slate-500" />}
                    title="Sin registros diarios en este filtro"
                    description="Selecciona otro día o limpia el filtro para ver el desglose diario."
                  />
                ) : (
                  <>
                    <div className="space-y-2.5 md:hidden">
                      {filteredDailyRows.map((row) => {
                        const isEditing = editingDateKey === row.dateKey;
                        const sourceMeta = row.rateSource ? RATE_SOURCE_META[row.rateSource] : null;
                        return (
                          <div
                            key={row.dateKey}
                            className="rounded-xl border border-base-600/80 bg-base-900/70 p-3.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="font-mono text-xs font-semibold text-slate-200">
                                  {row.dateKey}
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  ({row.inflowCount} ing.)
                                </span>
                              </div>
                              {!isEditing && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 shrink-0"
                                  title={`Editar tasa BCV real del ${row.dateKey}`}
                                  aria-label={`Editar tasa BCV real del ${row.dateKey}`}
                                  onClick={() => startEditRate(row.dateKey, row.bcvRate)}
                                >
                                  <Pencil className="h-4 w-4 text-slate-300" />
                                </Button>
                              )}
                            </div>

                            <div className="mt-2.5 grid grid-cols-2 gap-2.5 rounded-lg border border-base-700/70 bg-base-800/50 p-2.5">
                              <div className="min-w-0">
                                <p className="text-[11px] text-slate-400">Ingresos (Bs)</p>
                                <p className="mt-0.5 break-words text-sm font-semibold text-emerald-400 tabular">
                                  {formatBs(row.inflowBs)}
                                </p>
                              </div>
                              <div className="min-w-0 text-right">
                                <p className="text-[11px] text-slate-400">Equivalente (USD)</p>
                                <p className="mt-0.5 text-sm font-semibold text-sky-300 tabular">
                                  {row.inflowUsd !== null ? formatUsd(row.inflowUsd) : '—'}
                                </p>
                              </div>
                            </div>

                            {isEditing ? (
                              <div className="mt-2.5 flex items-center gap-1.5">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={editingRateValue}
                                  onChange={(e) => setEditingRateValue(e.target.value)}
                                  placeholder="Ej: 54.23"
                                  className="min-w-0 flex-1 rounded-lg border border-base-500 bg-base-800 px-2.5 py-1.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
                                />
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="primary"
                                  loading={upsertBcvRate.isPending}
                                  onClick={() => void handleSaveBcvRate(row.dateKey)}
                                  title="Guardar tasa BCV"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => setEditingDateKey(null)}
                                  title="Cancelar"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            ) : (
                              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="text-slate-400">Tasa BCV Real</span>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-semibold text-white tabular">
                                    {formatBcvRate(row.bcvRate)}
                                  </span>
                                  {sourceMeta && (
                                    <span
                                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${sourceMeta.className}`}
                                      title={
                                        row.carriedFromDateKey
                                          ? `Heredada de ${row.carriedFromDateKey}`
                                          : undefined
                                      }
                                    >
                                      {sourceMeta.label}
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full min-w-[640px] text-left text-sm">
                        <thead>
                          <tr className="border-b border-base-600 text-xs uppercase tracking-wider text-slate-400">
                            <th className="py-2.5 pr-3">Fecha (Caracas)</th>
                            <th className="py-2.5 pr-3">Tasa BCV Real</th>
                            <th className="py-2.5 pr-3 text-right">Ingresos (Bs)</th>
                            <th className="py-2.5 pr-3 text-right">Equivalente (USD BCV)</th>
                            <th className="py-2.5 text-right">Editar tasa</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-base-700/70">
                          {filteredDailyRows.map((row) => {
                            const isEditing = editingDateKey === row.dateKey;
                            const sourceMeta = row.rateSource ? RATE_SOURCE_META[row.rateSource] : null;
                            return (
                              <tr key={row.dateKey} className="hover:bg-base-800/50">
                                <td className="whitespace-nowrap py-3 pr-3 font-mono text-xs text-slate-200">
                                  {row.dateKey}
                                  <span className="ml-2 text-[11px] text-slate-400">
                                    ({row.inflowCount} ing.)
                                  </span>
                                </td>
                                <td className="py-3 pr-3">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1.5">
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        value={editingRateValue}
                                        onChange={(e) => setEditingRateValue(e.target.value)}
                                        placeholder="Ej: 54.23"
                                        className="w-28 rounded-lg border border-base-500 bg-base-800 px-2.5 py-1 text-xs text-white focus:border-emerald-400 focus:outline-none"
                                      />
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="primary"
                                        loading={upsertBcvRate.isPending}
                                        onClick={() => void handleSaveBcvRate(row.dateKey)}
                                        title="Guardar tasa BCV"
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </Button>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => setEditingDateKey(null)}
                                        title="Cancelar"
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-semibold text-white tabular">
                                        {formatBcvRate(row.bcvRate)}
                                      </span>
                                      {sourceMeta && (
                                        <span
                                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${sourceMeta.className}`}
                                          title={
                                            row.carriedFromDateKey
                                              ? `Heredada de ${row.carriedFromDateKey}`
                                              : undefined
                                          }
                                        >
                                          {sourceMeta.label}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td className="whitespace-nowrap py-3 pr-3 text-right font-semibold text-emerald-400 tabular">
                                  {formatBs(row.inflowBs)}
                                </td>
                                <td className="whitespace-nowrap py-3 pr-3 text-right font-semibold text-sky-300 tabular">
                                  {row.inflowUsd !== null ? formatUsd(row.inflowUsd) : '—'}
                                </td>
                                <td className="py-3 text-right">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    title={`Editar tasa BCV real del ${row.dateKey}`}
                                    aria-label={`Editar tasa BCV real del ${row.dateKey}`}
                                    onClick={() => startEditRate(row.dateKey, row.bcvRate)}
                                  >
                                    <Pencil className="h-4 w-4 text-slate-300" />
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </Card>
            </section>
          )}

          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="min-w-0 xl:col-span-1">
              <CardHeader
                title="Registrar retiro"
                description={`Descuenta Bs retirados de ${summary.cedula} · ${summary.phone}`}
                icon={<ArrowUpRight className="h-5 w-5" />}
              />
              <form onSubmit={handleRegisterWithdrawal} className="space-y-4">
                <Input
                  label="Monto retirado (Bs)"
                  type="text"
                  inputMode="decimal"
                  placeholder="Ej: 15000 o 15000.50"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  required
                />
                <Input
                  label="Concepto / Nota"
                  type="text"
                  placeholder="Ej: Cambio a USDT / Entrega al titular"
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  maxLength={300}
                  required
                />
                <Input
                  label="Referencia bancaria (opcional)"
                  type="text"
                  placeholder="Ej: 00458912"
                  value={refInput}
                  onChange={(e) => setRefInput(e.target.value)}
                  maxLength={60}
                />
                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  loading={createWithdrawal.isPending}
                >
                  Guardar retiro
                </Button>
              </form>
            </Card>

            <Card className="min-w-0 xl:col-span-2">
              <CardHeader
                className="flex-col gap-3 sm:flex-row sm:items-start"
                title="Movimientos de la cuenta"
                description={
                  fromDate || toDate
                    ? `Mostrando ${movements.length} movimientos · Ingresos en rango: ${formatBs(report?.filteredInflowBs)} · Retiros en rango: ${formatBs(report?.filteredWithdrawalBs)}`
                    : `${movements.length} movimientos registrados en ${summary.label}`
                }
                icon={<Calendar className="h-5 w-5" />}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    leftIcon={<Download className="h-4 w-4" />}
                    disabled={movements.length === 0}
                    onClick={() => downloadCsv(movements, summary.accountKey, summary, usdBcv)}
                  >
                    Exportar CSV
                  </Button>
                }
              />

              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                <Input
                  label="Desde"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
                <Input
                  label="Hasta"
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    fullWidth
                    disabled={!fromDate && !toDate}
                    onClick={() => {
                      setFromDate('');
                      setToDate('');
                    }}
                  >
                    Limpiar fechas
                  </Button>
                </div>
              </div>

              {movements.length === 0 ? (
                <EmptyState
                  icon={<Landmark className="h-8 w-8 text-slate-500" />}
                  title="Sin movimientos en este rango"
                  description="Cuando entren pagos verificados o registres un retiro aparecerán aquí."
                />
              ) : (
                <>
                  <div className="space-y-3 md:hidden">
                    {movements.map((entry) => {
                      const isWithdrawal = entry.type === 'withdrawal';
                      const badge = SOURCE_META[entry.source] ?? SOURCE_META.web;
                      return (
                        <article
                          key={entry.id}
                          className="rounded-xl border border-base-600/80 bg-base-900/70 p-3.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                            <span
                              className={`shrink-0 text-base font-bold tabular ${
                                isWithdrawal ? 'text-rose-400' : 'text-emerald-400'
                              }`}
                            >
                              {isWithdrawal ? '-' : '+'}
                              {formatBs(entry.amountBs)}
                            </span>
                          </div>

                          <div className="mt-2.5 space-y-1.5">
                            {(entry.orderId || entry.reference) && (
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                                {entry.orderId && (
                                  <Link
                                    to={ROUTES.adminOrder(entry.orderId)}
                                    className="break-all font-semibold text-neon-ice hover:underline"
                                  >
                                    {entry.orderCode || entry.orderId}
                                  </Link>
                                )}
                                {entry.reference ? (
                                  <span className="break-all font-mono text-xs text-slate-300">
                                    Ref: {entry.reference}
                                  </span>
                                ) : entry.orderId ? (
                                  <span className="font-mono text-xs text-slate-500">Ref: —</span>
                                ) : null}
                              </div>
                            )}
                            {entry.note && (
                              <p className="whitespace-normal break-words text-xs leading-relaxed text-slate-300">
                                {entry.note}
                              </p>
                            )}
                            {!entry.orderId && !entry.reference && !entry.note && (
                              <p className="text-xs text-slate-500">—</p>
                            )}
                          </div>

                          <div className="mt-3 flex items-center justify-between gap-2 border-t border-base-700/70 pt-2.5">
                            <span className="text-[11px] text-slate-400">
                              {formatDateTime(entry.createdAt)}
                            </span>
                            {isWithdrawal && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title="Eliminar retiro"
                                aria-label="Eliminar retiro"
                                loading={deleteWithdrawal.isPending}
                                onClick={() => void handleDeleteWithdrawal(entry)}
                                className="h-8 shrink-0 px-2.5 text-xs text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
                                leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                              >
                                Eliminar
                              </Button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>

                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[680px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-base-600 text-xs uppercase tracking-wider text-slate-400">
                          <th className="py-2.5 pr-3">Fecha / Hora</th>
                          <th className="py-2.5 pr-3">Origen</th>
                          <th className="py-2.5 pr-3">Referencia</th>
                          <th className="py-2.5 pr-3">Orden / Nota</th>
                          <th className="py-2.5 pr-3 text-right">Monto (Bs)</th>
                          <th className="py-2.5 text-right">Acción</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-base-700/70">
                        {movements.map((entry) => {
                          const isWithdrawal = entry.type === 'withdrawal';
                          const badge = SOURCE_META[entry.source] ?? SOURCE_META.web;
                          return (
                            <tr key={entry.id} className="hover:bg-base-800/50">
                              <td className="whitespace-nowrap py-3 pr-3 text-xs text-slate-300">
                                {formatDateTime(entry.createdAt)}
                              </td>
                              <td className="py-3 pr-3">
                                <span
                                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                                >
                                  {badge.label}
                                </span>
                              </td>
                              <td className="py-3 pr-3 font-mono text-xs text-slate-300">
                                {entry.reference || '—'}
                              </td>
                              <td className="py-3 pr-3 text-xs text-slate-300">
                                <div className="flex flex-col gap-0.5">
                                  {entry.orderId && (
                                    <Link
                                      to={ROUTES.adminOrder(entry.orderId)}
                                      className="font-semibold text-neon-ice hover:underline"
                                    >
                                      {entry.orderCode || entry.orderId}
                                    </Link>
                                  )}
                                  {entry.note && (
                                    <span className="text-slate-400">{entry.note}</span>
                                  )}
                                  {!entry.orderId && !entry.note && (
                                    <span className="text-slate-500">—</span>
                                  )}
                                </div>
                              </td>
                              <td
                                className={`whitespace-nowrap py-3 pr-3 text-right font-semibold tabular ${
                                  isWithdrawal ? 'text-rose-400' : 'text-emerald-400'
                                }`}
                              >
                                {isWithdrawal ? '-' : '+'}
                                {formatBs(entry.amountBs)}
                              </td>
                              <td className="py-3 text-right">
                                {isWithdrawal ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    title="Eliminar retiro"
                                    aria-label="Eliminar retiro"
                                    loading={deleteWithdrawal.isPending}
                                    onClick={() => void handleDeleteWithdrawal(entry)}
                                  >
                                    <Trash2 className="h-4 w-4 text-rose-400" />
                                  </Button>
                                ) : (
                                  <span className="text-xs text-slate-600">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
