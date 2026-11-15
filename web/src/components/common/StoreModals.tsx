/**
 * Modales y avisos flotantes de la tienda: Stack compacto desplegable.
 *
 * Muestra TODOS los modales con `active === true` ordenados por `sortOrder`.
 * Aunque el popup automático inicial ya se haya visto (`once` / `daily`),
 * los avisos activos permanecen accesibles en el stack compacto inferior
 * (salvo descarte explícito en la sesión) para que ninguno desaparezca.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  X,
} from 'lucide-react';
import { useStoreModals } from '@/hooks/useMisc';
import { useRechargeTour } from '@/features/tour/useRechargeTour';
import { Button } from '@/components/ui/Button';
import { resolveNavigationTarget, useSmartStoreNavigate } from '@/lib/scrollTargets';
import { cn } from '@/lib/utils';
import type { StoreModal } from '@/types/models';

/** Marca de «ya lo vio» para el popup automático inicial, por modal. */
const KEY = (id: string) => `refill.modal.${id}`;

const LEADING_EMOJI_RE =
  /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

function getModalOrder(modal: StoreModal): number {
  const withLegacy = modal as StoreModal & { order?: number };
  const raw = Number(modal.sortOrder ?? withLegacy.order ?? 99);
  return Number.isFinite(raw) ? raw : 99;
}

function getModalDisplayMeta(modal: StoreModal): {
  emoji: string;
  shortTitle: string;
} {
  const rawTitle = (modal.title || modal.ctaLabel || 'Aviso').trim();
  const emojiMatch = rawTitle.match(LEADING_EMOJI_RE);

  let emoji = emojiMatch?.[1] ?? '';
  const textWithoutEmoji = emojiMatch ? rawTitle.slice(emojiMatch[0].length).trim() : rawTitle;

  if (!emoji) {
    const haystack = `${rawTitle} ${modal.ctaLabel || ''}`;
    if (/refillcoin|saldo|wallet|moneda/i.test(haystack)) emoji = '👛';
    else if (/cómo|como\s+recargar|tutorial|paso|gu[ií]a/i.test(haystack)) emoji = '🎓';
    else if (/evo|diamant|free\s*fire|caja|fragment/i.test(haystack)) emoji = '🔥';
    else if (/stream|netflix|disney|hbo|prime|flujo/i.test(haystack)) emoji = '🚀';
    else emoji = '📢';
  }

  let shortTitle = textWithoutEmoji.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (shortTitle.length > 34) {
    const cutByConnector = shortTitle.split(/\s+(?:y\s+compra|para\s+que)\b/i)[0]?.trim();
    if (cutByConnector && cutByConnector.length >= 10) {
      shortTitle = cutByConnector;
    }
  }
  shortTitle = shortTitle.replace(/[.:,;]+$/, '').trim() || rawTitle;

  return { emoji, shortTitle };
}

/**
 * ¿Toca mostrarlo solo al entrar?
 *
 * Todo lo que falle al leer el almacenamiento se resuelve como «sí»: en modo
 * privado es preferible enseñar el aviso de más que no enseñarlo nunca.
 * Esto sólo controla la apertura automática inicial; nunca oculta el aviso del stack.
 */
function shouldAutoOpen(modal: StoreModal): boolean {
  if (modal.frequency === 'always') return true;
  if (modal.placement === 'manual') return false;

  try {
    const raw = localStorage.getItem(KEY(modal.id));
    if (!raw) return true;
    if (modal.frequency === 'once') return false;

    // `daily`: se repite al día siguiente.
    return Date.now() - Number(raw) > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function markSeen(modal: StoreModal): void {
  try {
    localStorage.setItem(KEY(modal.id), String(Date.now()));
  } catch {
    // Sin almacenamiento el modal volverá a salir. Es el fallo menos malo.
  }
}

function ModalCard({
  modal,
  stack,
  onSelectModal,
  onClose,
}: {
  modal: StoreModal;
  stack: StoreModal[];
  onSelectModal: (id: string) => void;
  onClose: () => void;
}) {
  const smartNavigate = useSmartStoreNavigate();
  const navTarget = resolveNavigationTarget(modal.ctaUrl, modal.scrollTarget);
  const currentIndex = Math.max(
    0,
    stack.findIndex((item) => item.id === modal.id)
  );
  const total = stack.length;
  const hasMultiple = total > 1;
  const activeMeta = getModalDisplayMeta(modal);

  // Cada línea del cuerpo es un paso: es como lo escribe quien lo redacta y
  // ahorra tener que meter un editor con formato.
  const steps = modal.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const goPrev = () => {
    if (!hasMultiple) return;
    const prevIndex = (currentIndex - 1 + total) % total;
    onSelectModal(stack[prevIndex].id);
  };

  const goNext = () => {
    if (!hasMultiple) return;
    const nextIndex = (currentIndex + 1) % total;
    onSelectModal(stack[nextIndex].id);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center overflow-x-hidden bg-black/75 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={modal.title}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ duration: 0.2 }}
        className="mx-auto box-border flex max-h-[82vh] w-full max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-base-600 bg-base-800 shadow-2xl sm:max-h-[88vh] sm:max-w-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="w-full min-w-0 shrink-0 border-b border-base-600 bg-base-800/95 px-4 py-3 backdrop-blur">
          <div className="flex min-w-0 items-start justify-between gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 shrink-0 text-lg leading-none" aria-hidden>
                  {activeMeta.emoji}
                </span>
                <h2 className="min-w-0 flex-1 break-words text-base font-bold leading-snug text-white">
                  {modal.title}
                </h2>
              </div>
              {hasMultiple && (
                <p className="mt-1 truncate text-[11px] font-semibold text-slate-400">
                  Aviso {currentIndex + 1} de {total} · toca otra pestaña para cambiar
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-base-700/70 text-slate-300 transition hover:bg-base-600 hover:text-white active:scale-95"
              aria-label="Cerrar aviso"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>

          {hasMultiple && (
            <div className="no-scrollbar mt-2.5 flex w-full min-w-0 gap-1.5 overflow-x-auto pb-0.5">
              {stack.map((item, idx) => {
                const itemMeta = getModalDisplayMeta(item);
                const selected = item.id === modal.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectModal(item.id)}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition',
                      selected
                        ? 'border-neon-red/60 bg-neon-red/15 text-white shadow-sm'
                        : 'border-base-600 bg-base-900/70 text-slate-400 hover:border-base-500 hover:text-slate-200'
                    )}
                  >
                    <span aria-hidden>{itemMeta.emoji}</span>
                    <span className="max-w-[130px] truncate">{itemMeta.shortTitle}</span>
                    <span className="text-[10px] opacity-70">{idx + 1}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4">
          {modal.videoUrl && (
            <div className="aspect-video overflow-hidden rounded-2xl bg-black">
              <iframe
                src={modal.videoUrl}
                title={modal.title}
                className="h-full w-full"
                allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          )}

          {modal.imageUrl && (
            <img
              src={modal.imageUrl}
              alt=""
              className="w-full rounded-2xl object-cover"
              loading="lazy"
            />
          )}

          {steps.length > 0 && (
            <ol className="space-y-2.5">
              {steps.map((step, index) => (
                <li key={index} className="flex min-w-0 gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-xs font-black text-white">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-sm leading-relaxed text-slate-300">
                    {step}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {modal.ctaLabel && navTarget.fullHref && (
            navTarget.isExternal ? (
              <a
                href={navTarget.fullHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
                className="block"
              >
                <Button fullWidth>{modal.ctaLabel}</Button>
              </a>
            ) : (
              <Button
                fullWidth
                onClick={() => smartNavigate(modal.ctaUrl, modal.scrollTarget, onClose)}
              >
                {modal.ctaLabel}
              </Button>
            )
          )}

          {hasMultiple && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-base-600/80 bg-base-900/60 p-1.5">
              <button
                type="button"
                onClick={goPrev}
                className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-bold text-slate-300 transition hover:bg-base-700 hover:text-white active:scale-95"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
                Anterior
              </button>
              <span className="text-xs font-bold tabular text-slate-400">
                {currentIndex + 1} / {total}
              </span>
              <button
                type="button"
                onClick={goNext}
                className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-bold text-slate-300 transition hover:bg-base-700 hover:text-white active:scale-95"
              >
                Siguiente
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <Button variant="secondary" fullWidth onClick={onClose}>
            Entendido
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

export function StoreModals() {
  const { pathname } = useLocation();
  const { data } = useStoreModals();
  const { active: isTutorialActive } = useRechargeTour();
  const [openId, setOpenId] = useState<string | null>(null);
  const [deckExpanded, setDeckExpanded] = useState(false);
  const [autoDone, setAutoDone] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);

  const isHome = pathname === '/';
  const isCheckoutOrGame = pathname.startsWith('/comprar') || pathname.startsWith('/juego/');

  // Todos los modales activos para web, estrictamente ordenados por `sortOrder` ascendente.
  const all = useMemo(
    () =>
      (data?.modals ?? [])
        .filter((modal) => modal.active !== false)
        .filter((modal) => !modal.audience || modal.audience === 'both' || modal.audience === 'web')
        .slice()
        .sort((a, b) => getModalOrder(a) - getModalOrder(b) || a.id.localeCompare(b.id)),
    [data]
  );

  /** Los que pueden abrirse solos automáticamente al entrar. */
  const forHere = useMemo(
    () => all.filter((modal) => modal.placement === 'store' || (isHome && modal.placement === 'home')),
    [all, isHome]
  );

  /**
   * Todos los modales activos visibles en el stack de esta pantalla
   * (sin importar si su frecuencia `once` / `daily` ya cerró el popup automático).
   */
  const reachable = useMemo(
    () =>
      all
        .filter((modal) => modal.placement !== 'home' || isHome)
        .filter((modal) => !dismissedIds.includes(modal.id)),
    [all, isHome, dismissedIds]
  );

  useEffect(() => {
    if (autoDone || isTutorialActive || forHere.length === 0) return;

    const candidate = forHere.find(shouldAutoOpen);
    if (candidate) setOpenId(candidate.id);
    setAutoDone(true);
  }, [forHere, autoDone, isTutorialActive]);

  // Si cambia la ruta (ej. sale de inicio), colapsa el stack desplegado.
  useEffect(() => {
    setDeckExpanded(false);
  }, [pathname]);

  // Ocultar temporalmente mientras el Tutorial Interactivo («¿Primera vez?») está activo.
  if (isTutorialActive) return null;

  const open = all.find((modal) => modal.id === openId) ?? null;
  const frontModal = reachable[0] ?? null;

  const selectModal = (id: string) => {
    const target = all.find((modal) => modal.id === id);
    if (target) markSeen(target);
    setDeckExpanded(false);
    setOpenId(id);
  };

  const close = () => {
    if (open) markSeen(open);
    setOpenId(null);
  };

  const dismissInSession = (id: string) => {
    const target = all.find((modal) => modal.id === id);
    if (target) markSeen(target);
    setDismissedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (openId === id) setOpenId(null);
  };

  if (all.length === 0) return null;

  // Posición segura que evita chocar con `BottomNav` (móvil), `Rex IA` (`right-4/right-6 bottom-24`)
  // y con las tarjetas principales:
  // - Móvil (< md): esquina inferior izquierda encima de `BottomNav`, opuesto a `Rex IA` (derecha).
  // - PC (>= md): esquina inferior derecha (`md:bottom-6 md:right-6`) debajo de `Rex IA` (`md:bottom-24`).
  const anchorPositionClass = isCheckoutOrGame
    ? 'bottom-[calc(8.75rem+env(safe-area-inset-bottom))] left-3 sm:left-4 md:bottom-24 md:left-6 md:right-auto'
    : 'bottom-[calc(5.25rem+env(safe-area-inset-bottom))] left-3 sm:left-4 md:bottom-6 md:left-auto md:right-6';

  return (
    <>
      <AnimatePresence>
        {open && (
          <ModalCard
            modal={open}
            stack={reachable.length > 0 ? reachable : [open]}
            onSelectModal={selectModal}
            onClose={close}
          />
        )}
      </AnimatePresence>

      {deckExpanded && !open && (
        <div
          className="fixed inset-0 z-[44] bg-black/25 backdrop-blur-[1px] md:bg-transparent md:backdrop-blur-none"
          aria-hidden
          onClick={() => setDeckExpanded(false)}
        />
      )}

      {frontModal && !open && (
        <div
          className={cn(
            'fixed flex max-w-[calc(100vw-6rem)] flex-col sm:max-w-[330px]',
            deckExpanded ? 'z-[45]' : 'z-40',
            isCheckoutOrGame ? 'items-start' : 'items-start md:items-end',
            anchorPositionClass
          )}
        >
          <AnimatePresence mode="wait">
            {deckExpanded ? (
              <motion.div
                key="expanded-stack"
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.18 }}
                className="w-[min(calc(100vw-2rem),310px)] rounded-2xl border border-base-600/90 bg-base-900/95 p-2.5 shadow-2xl backdrop-blur-xl"
              >
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Avisos activos ({reachable.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setDeckExpanded(false)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-base-800 hover:text-white"
                    aria-label="Minimizar lista de avisos"
                  >
                    Minimizar
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  {reachable.map((modal) => {
                    const meta = getModalDisplayMeta(modal);
                    return (
                      <div
                        key={modal.id}
                        className="group flex min-h-10 items-center gap-1 rounded-xl border border-base-600/80 bg-base-800/90 pr-1.5 transition hover:border-neon-red/50 hover:bg-base-800"
                      >
                        <button
                          type="button"
                          onClick={() => selectModal(modal.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs font-bold text-white"
                        >
                          <span className="shrink-0 text-sm leading-none" aria-hidden>
                            {meta.emoji}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{meta.shortTitle}</span>
                          <ChevronRight
                            className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-white"
                            aria-hidden
                          />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            dismissInSession(modal.id);
                          }}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-base-700 hover:text-slate-200"
                          aria-label={`Descartar ${meta.shortTitle}`}
                          title="Descartar por esta sesión"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="collapsed-stack"
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.16 }}
                className={cn('relative max-w-full', reachable.length >= 3 ? 'mt-3' : reachable.length === 2 ? 'mt-1.5' : '')}
              >
                {reachable.length >= 3 && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 -top-3 h-10 origin-bottom scale-[0.90] rounded-full border border-base-500/50 bg-base-800/80 shadow-md"
                  />
                )}
                {reachable.length >= 2 && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 -top-1.5 h-10 origin-bottom scale-95 rounded-full border border-base-500/70 bg-base-800/95 shadow-md"
                  />
                )}

                {(() => {
                  const frontMeta = getModalDisplayMeta(frontModal);
                  const hasMany = reachable.length > 1;
                  return (
                    <button
                      type="button"
                      onClick={() =>
                        hasMany ? setDeckExpanded(true) : selectModal(frontModal.id)
                      }
                      aria-expanded={hasMany ? deckExpanded : undefined}
                      aria-label={
                        hasMany
                          ? `Ver ${reachable.length} avisos activos`
                          : `Abrir ${frontMeta.shortTitle}`
                      }
                      className={cn(
                        'relative z-10 flex h-10 w-full max-w-[calc(100vw-6rem)] min-w-0 items-center gap-2 rounded-full border border-neon-red/40 bg-base-900/95 px-3 sm:max-w-[330px]',
                        'text-xs font-bold text-white shadow-glow backdrop-blur-md transition hover:border-neon-crimson active:scale-95'
                      )}
                    >
                      <span className="shrink-0 text-sm leading-none" aria-hidden>
                        {frontMeta.emoji}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{frontMeta.shortTitle}</span>
                      {hasMany && (
                        <>
                          <span className="shrink-0 rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-black text-white shadow-sm">
                            {reachable.length} avisos
                          </span>
                          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />
                        </>
                      )}
                    </button>
                  );
                })()}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </>
  );
}
