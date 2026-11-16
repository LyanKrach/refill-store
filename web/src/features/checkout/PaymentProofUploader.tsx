import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { CheckCircle2, ImageUp, Loader2, Sparkles, X } from 'lucide-react';
import { useAnalyzePaymentProof } from '@/hooks/useOrders';
import { ACCEPTED_PROOF_MIME_TYPES, preparePaymentProofImage } from '@/lib/imageProof';
import { cn, errorMessage } from '@/lib/utils';
import type { PaymentProofExtraction } from '@/types/models';

interface PaymentProofUploaderProps {
  orderId?: string;
  disabled?: boolean;
  onExtracted: (result: PaymentProofExtraction) => void;
  onClear?: () => void;
}

/**
 * Selector y zona de arrastre para analizar capturas de Pago Móvil / Transferencia
 * mediante Gemini Vision y autocompletar referencia, monto y banco emisor.
 */
export function PaymentProofUploader({
  orderId,
  disabled = false,
  onExtracted,
  onClear,
}: PaymentProofUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeqRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<{
    kind: 'success' | 'warning';
    text: string;
  } | null>(null);

  const analyzeProof = useAnalyzePaymentProof();

  const clearUpload = () => {
    requestSeqRef.current += 1;
    setPreviewUrl(null);
    setFileName('');
    setLocalError(null);
    setStatusNote(null);
    analyzeProof.reset();
    if (inputRef.current) inputRef.current.value = '';
    onClear?.();
  };

  const handleFile = async (file: File | undefined | null) => {
    if (!file || disabled) return;

    if (!ACCEPTED_PROOF_MIME_TYPES.has(file.type as 'image/jpeg' | 'image/png' | 'image/webp')) {
      setLocalError('Formato no compatible. Sube una captura JPG, PNG o WEBP.');
      setStatusNote(null);
      return;
    }

    const requestId = ++requestSeqRef.current;
    setLocalError(null);
    setStatusNote(null);

    try {
      const prepared = await preparePaymentProofImage(file);
      if (requestId !== requestSeqRef.current) return;

      setPreviewUrl(prepared.previewUrl);
      setFileName(file.name || 'comprobante');

      analyzeProof.mutate(
        {
          imageBase64: prepared.imageBase64,
          mimeType: prepared.mimeType,
          orderId,
        },
        {
          onSuccess: (result) => {
            if (requestId !== requestSeqRef.current) return;
            onExtracted(result);
            if (result.success && result.reference) {
              setStatusNote({
                kind: 'success',
                text: 'Referencia detectada y completada automáticamente.',
              });
            } else {
              setStatusNote({
                kind: 'warning',
                text: 'No se logró identificar la referencia con claridad. Escríbela abajo o intenta con otra captura.',
              });
            }
          },
          onError: (err) => {
            if (requestId !== requestSeqRef.current) return;
            setLocalError(
              errorMessage(err, 'No pudimos analizar el comprobante. Escribe la referencia manualmente.')
            );
          },
        }
      );
    } catch (err) {
      if (requestId !== requestSeqRef.current) return;
      setLocalError(errorMessage(err, 'No se pudo procesar la captura seleccionada.'));
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled || analyzeProof.isPending) return;
    const file = event.dataTransfer.files?.[0];
    void handleFile(file);
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (disabled || analyzeProof.isPending) return;
    const item = Array.from(event.clipboardData.items).find((entry) =>
      ACCEPTED_PROOF_MIME_TYPES.has(entry.type as 'image/jpeg' | 'image/png' | 'image/webp')
    );
    if (!item) return;
    event.preventDefault();
    void handleFile(item.getAsFile());
  };

  return (
    <div className="mb-3.5" onPaste={onPaste}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={disabled || analyzeProof.isPending}
        className="sr-only"
        aria-label="Subir captura de pago"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
        }}
      />

      {!previewUrl ? (
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={() => !disabled && inputRef.current?.click()}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'group flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed px-3.5 py-2.5 transition',
            dragging
              ? 'border-neon-red bg-neon-red/10'
              : 'border-base-500/80 bg-base-900/70 hover:border-neon-red/60 hover:bg-base-900',
            disabled && 'pointer-events-none opacity-50'
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neon-red/15 text-neon-red transition group-hover:bg-neon-red/20">
              <ImageUp className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-white sm:text-sm">
                📸 Subir captura de pago (o arrastrar imagen)
              </p>
              <p className="truncate text-[11px] text-slate-400">
                Autocompleta referencia, monto y banco con Gemini AI · JPG, PNG o WEBP
              </p>
            </div>
          </div>

          <span className="shrink-0 rounded-lg border border-base-500 bg-base-800 px-2.5 py-1 text-xs font-medium text-slate-200 group-hover:border-neon-red/50">
            Elegir
          </span>
        </div>
      ) : (
        <div className="rounded-xl border border-base-600 bg-base-900/80 p-3">
          <div className="flex items-start gap-3">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-base-600 bg-base-950">
              <img
                src={previewUrl}
                alt="Vista previa del comprobante de pago"
                className="h-full w-full object-cover"
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-xs font-medium text-slate-200">{fileName}</p>
                <button
                  type="button"
                  onClick={clearUpload}
                  aria-label="Eliminar captura de pago"
                  title="Eliminar captura"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-base-600 bg-base-800 text-xs text-slate-300 transition hover:border-red-500/60 hover:bg-red-500/15 hover:text-red-300"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>

              {analyzeProof.isPending ? (
                <div className="mt-1.5 flex items-center gap-2 text-xs font-medium text-amber-300">
                  <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden />
                  <Sparkles className="h-3.5 w-3.5 animate-pulse shrink-0 text-neon-red" aria-hidden />
                  <span>Analizando comprobante con Gemini AI...</span>
                </div>
              ) : statusNote ? (
                <p
                  className={cn(
                    'mt-1.5 flex items-start gap-1.5 text-xs',
                    statusNote.kind === 'success' ? 'text-emerald-400' : 'text-amber-300'
                  )}
                >
                  {statusNote.kind === 'success' && (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  <span>{statusNote.text}</span>
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {localError && (
        <p className="mt-1.5 text-xs text-red-400" role="alert">
          {localError}
        </p>
      )}
    </div>
  );
}
