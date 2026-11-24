import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Download,
  Landmark,
  RefreshCw,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import {
  useAdminBankLedger,
  useCreateBankWithdrawal,
  useDeleteBankWithdrawal,
} from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, Skeleton } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatDateTime, formatNumber, toDate } from '@/lib/format';
import type { BankLedgerEntry, BankLedgerSource } from '@/types/models';

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
  }
) {
  const header = [
    'FechaHoraCaracas',
    'Tipo',
    'Origen',
    'Referencia',
    'Orden',
    'ConceptoNota',
    'MontoBs',
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
    const signedAmount =
      m.type === 'withdrawal' ? -Math.abs(m.amountBs) : Math.abs(m.amountBs);
    return [
      fecha,
      m.type === 'withdrawal' ? 'Retiro' : 'Ingreso',
      SOURCE_META[m.source]?.label ?? m.source,
      m.reference ?? '',
      m.orderCode ?? m.orderId ?? '',
      m.note ?? '',
      signedAmount.toFixed(2),
      m.accountKey,
      m.createdBy ?? '',
    ]
      .map(csvEscape)
      .join(',');
  });

  rows.push('');
  rows.push(
    ['RESUMEN CUENTA', '', '', '', '', 'Total ingresado', summary.totalInflowBs.toFixed(2), accountKey, '']
      .map(csvEscape)
      .join(',')
  );
  rows.push(
    ['RESUMEN CUENTA', '', '', '', '', 'Total retirado', (-summary.totalWithdrawalBs).toFixed(2), accountKey, '']
      .map(csvEscape)
      .join(',')
  );
  rows.push(
    ['RESUMEN CUENTA', '', '', '', '', 'Saldo neto en cuenta', summary.netBalanceBs.toFixed(2), accountKey, '']
      .map(csvEscape)
      .join(',')
  );

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

  const [amountInput, setAmountInput] = useState<string>('');
  const [noteInput, setNoteInput] = useState<string>('');
  const [refInput, setRefInput] = useState<string>('');

  const ledgerQuery = useAdminBankLedger({
    accountKey: selectedAccount || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
  });

  const createWithdrawal = useCreateBankWithdrawal();
  const deleteWithdrawal = useDeleteBankWithdrawal();

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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Caja Bs (Cuentas)</h1>
          <p className="mt-1 text-sm text-slate-400">
            Conteo real al céntimo de bolívares acreditados (Web + WhatsApp) y retiros por cuenta bancaria.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {accountOptions.length > 0 && (
            <Select
              label="Cuenta bancaria"
              value={activeKey}
              onChange={(e) => setSelectedAccount(e.target.value)}
              options={accountOptions}
              containerClassName="sm:min-w-[340px]"
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

          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-1">
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

            <Card className="xl:col-span-2">
              <CardHeader
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
                    onClick={() => downloadCsv(movements, summary.accountKey, summary)}
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
                <div className="overflow-x-auto">
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
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
