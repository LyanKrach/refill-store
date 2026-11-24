import { useEffect, useId, useMemo, useState } from 'react';
import { CheckCircle2, Coins } from 'lucide-react';
import { formatRefillCoins, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

interface WalletMixControlProps {
  walletEnabled: boolean;
  walletBalanceUsd: number;
  /** Total de la orden antes de aplicar RefillCoins (ya con descuentos/cupones). */
  orderTotalUsd: number;
  useWallet: boolean;
  onUseWalletChange: (next: boolean) => void;
  walletAmountUsd: number | undefined;
  onWalletAmountUsdChange: (next: number | undefined) => void;
  /** Monto restante calculado por el servidor (opcional, para mostrar cobertura total). */
  amountDueUsd?: number | null;
  disabled?: boolean;
  className?: string;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Control de pago mixto con RefillCoins:
 *  - Switch de 1 clic para aplicar el máximo utilizable.
 *  - Input numérico con debounce breve + botón "Máx" para elegir un monto parcial.
 */
export function WalletMixControl({
  walletEnabled,
  walletBalanceUsd,
  orderTotalUsd,
  useWallet,
  onUseWalletChange,
  walletAmountUsd,
  onWalletAmountUsdChange,
  amountDueUsd,
  disabled = false,
  className,
}: WalletMixControlProps) {
  const inputId = useId();
  const maxUsable = useMemo(
    () => Math.max(0, round2(Math.min(walletBalanceUsd, orderTotalUsd))),
    [walletBalanceUsd, orderTotalUsd]
  );

  const [rawInput, setRawInput] = useState<string>(() =>
    (walletAmountUsd ?? maxUsable).toFixed(2)
  );

  // Sincroniza el campo si maxUsable baja (ej. se aplica un cupón) o si cambia externamente.
  useEffect(() => {
    if (!useWallet) return;
    if (walletAmountUsd === undefined) {
      setRawInput(maxUsable.toFixed(2));
      onWalletAmountUsdChange(maxUsable);
      return;
    }
    if (walletAmountUsd > maxUsable + 0.001) {
      setRawInput(maxUsable.toFixed(2));
      onWalletAmountUsdChange(maxUsable);
    }
  }, [useWallet, maxUsable, walletAmountUsd, onWalletAmountUsdChange]);

  const parsedValue = Number.parseFloat(rawInput.replace(',', '.'));
  const validationError = useMemo(() => {
    if (!useWallet) return null;
    if (rawInput.trim() === '' || Number.isNaN(parsedValue)) {
      return 'Ingresa un monto en USD.';
    }
    if (parsedValue < 0.01) {
      return 'El monto mínimo a usar es $0.01.';
    }
    if (parsedValue > maxUsable + 0.001) {
      return `El máximo disponible para esta orden es ${formatUsd(maxUsable)}.`;
    }
    return null;
  }, [useWallet, rawInput, parsedValue, maxUsable]);

  // Debounce breve al escribir para no disparar price-preview por cada tecla.
  useEffect(() => {
    if (!useWallet) return undefined;
    if (rawInput.trim() === '' || !Number.isFinite(parsedValue)) return undefined;

    const clamped = round2(Math.min(maxUsable, Math.max(0.01, parsedValue)));
    if (walletAmountUsd !== undefined && Math.abs(clamped - walletAmountUsd) < 0.001) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      onWalletAmountUsdChange(clamped);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [useWallet, rawInput, parsedValue, maxUsable, walletAmountUsd, onWalletAmountUsdChange]);

  const handleBlur = () => {
    if (!useWallet) return;
    if (rawInput.trim() === '' || !Number.isFinite(parsedValue)) {
      setRawInput(maxUsable.toFixed(2));
      onWalletAmountUsdChange(maxUsable);
      return;
    }
    const clamped = round2(Math.min(maxUsable, Math.max(0.01, parsedValue)));
    setRawInput(clamped.toFixed(2));
    onWalletAmountUsdChange(clamped);
  };

  if (!walletEnabled || walletBalanceUsd <= 0 || orderTotalUsd <= 0) {
    return null;
  }

  const effectiveDue =
    amountDueUsd !== undefined && amountDueUsd !== null
      ? amountDueUsd
      : Math.max(0, round2(orderTotalUsd - (walletAmountUsd ?? maxUsable)));
  const coversAll = useWallet && effectiveDue <= 0;

  const handleToggle = () => {
    if (disabled) return;
    const next = !useWallet;
    onUseWalletChange(next);
    if (next) {
      setRawInput(maxUsable.toFixed(2));
      onWalletAmountUsdChange(maxUsable);
    } else {
      onWalletAmountUsdChange(undefined);
    }
  };

  const handleMaxClick = () => {
    if (disabled) return;
    setRawInput(maxUsable.toFixed(2));
    onWalletAmountUsdChange(maxUsable);
  };

  return (
    <div
      className={cn(
        'rounded-2xl border p-4 transition-colors',
        useWallet
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-base-600 bg-base-800/70',
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
            <Coins className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">
              Usar mis RefillCoins disponibles ({formatRefillCoins(walletBalanceUsd)})
            </p>
            <p className="text-xs text-slate-400">
              {useWallet
                ? coversAll
                  ? 'Se descuenta todo de tu saldo al instante.'
                  : 'Paga una parte con tu saldo y el resto por banco o Binance.'
                : `Puedes aplicar hasta ${formatUsd(maxUsable)} a esta orden.`}
            </p>
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={useWallet}
          aria-label={`Usar mis RefillCoins disponibles (${formatRefillCoins(walletBalanceUsd)})`}
          disabled={disabled}
          onClick={handleToggle}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400/50 disabled:cursor-not-allowed disabled:opacity-50',
            useWallet
              ? 'border-amber-400 bg-amber-500'
              : 'border-base-500 bg-base-700'
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
              useWallet ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>
      </div>

      {useWallet && (
        <div className="mt-3 border-t border-amber-500/20 pt-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-[180px] flex-1">
              <label
                htmlFor={inputId}
                className="mb-1 block text-xs font-medium text-slate-300"
              >
                Monto a usar (USD)
              </label>
              <div className="relative flex items-center">
                <span className="pointer-events-none absolute left-3 text-xs font-semibold text-slate-400">
                  $
                </span>
                <input
                  id={inputId}
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  max={maxUsable}
                  step="0.01"
                  disabled={disabled}
                  value={rawInput}
                  onChange={(e) => setRawInput(e.target.value)}
                  onBlur={handleBlur}
                  className={cn(
                    'input-base h-9 pl-7 pr-14 text-sm tabular',
                    validationError && 'border-red-500/60 focus:border-red-500 focus:ring-red-500/30'
                  )}
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={handleMaxClick}
                  className="absolute right-1.5 rounded-lg bg-amber-500/20 px-2.5 py-1 text-[11px] font-bold text-amber-300 transition hover:bg-amber-500/30 disabled:opacity-50"
                >
                  Máx
                </button>
              </div>
            </div>

            {coversAll && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                Cubre el 100 % de tu orden
              </span>
            )}
          </div>

          {validationError && (
            <p className="mt-1.5 text-xs text-red-400">{validationError}</p>
          )}
        </div>
      )}
    </div>
  );
}
