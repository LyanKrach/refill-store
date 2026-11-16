/**
 * Extracción estructurada de comprobantes bancarios de Venezuela usando Gemini Vision.
 *
 * Se ejecuta exclusivamente en Cloud Functions para nunca exponer `GEMINI_API_KEY`
 * al navegador. Usa la API de Interacciones de `@google/genai` (`v1beta`) con
 * `store: false` para no retener capturas bancarias del cliente.
 */
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, geminiVisionModel } from '../config/env';
import { invalidArgument, providerError } from '../lib/errors';
import { normalizeReference } from '../lib/ids';
import { log } from '../lib/logger';

export const SUPPORTED_PROOF_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedProofMimeType = (typeof SUPPORTED_PROOF_MIME_TYPES)[number];

export const MAX_PROOF_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB

export const PAYMENT_PROOF_PROMPT = [
  'Analiza este comprobante de pago bancario de Venezuela (Pago Móvil o Transferencia).',
  'Extrae estrictamente los siguientes datos en formato JSON plano (sin markdown ni bloques de código extra, solo el JSON):',
  '{',
  '  "reference": "últimos 4 a 8 dígitos o número de referencia numérico de la transacción",',
  '  "amount": "monto exacto con decimales si aparece (ej. 125.50)",',
  '  "bank": "nombre del banco emisor o receptor si se detecta (ej. Banesco, Mercantil, BDV)",',
  '  "success": true',
  '}',
  'Si no logras identificar con claridad el número de referencia, pon "reference": "" y "success": false.',
].join('\n');

export interface PaymentProofExtraction {
  reference: string;
  amount: string;
  bank: string;
  success: boolean;
}

export interface AnalyzePaymentProofInput {
  imageBase64: string;
  mimeType: SupportedProofMimeType;
}

export interface PaymentProofVisionDeps {
  apiKey?: string;
  model?: string;
  createInteraction?: (params: {
    model: string;
    prompt: string;
    imageBase64: string;
    mimeType: SupportedProofMimeType;
  }) => Promise<{ outputText: string | null }>;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    reference: {
      type: 'string',
      description: 'Solo dígitos del número de referencia de la transacción bancaria.',
    },
    amount: {
      type: 'string',
      description: 'Monto numérico con punto decimal si aparece (ej. 125.50).',
    },
    bank: {
      type: 'string',
      description: 'Nombre del banco emisor o receptor si se identifica.',
    },
    success: {
      type: 'boolean',
      description: 'true solo si se identificó con claridad el número de referencia.',
    },
  },
  required: ['reference', 'amount', 'bank', 'success'],
} as const;

function matchesImageSignature(buf: Buffer, mimeType: SupportedProofMimeType): boolean {
  if (mimeType === 'image/png') {
    return (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (mimeType === 'image/jpeg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mimeType === 'image/webp') {
    return (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

/** Valida que el Base64 corresponda a una imagen real JPEG/PNG/WEBP dentro del tope permitido. */
export function validateAndNormalizeProofImage(
  rawBase64: string,
  mimeType: SupportedProofMimeType
): string {
  const stripped = rawBase64
    .trim()
    .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    .replace(/\s+/g, '');

  if (!stripped || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
    throw invalidArgument('La imagen no tiene un formato Base64 válido.');
  }

  const approxBytes = Math.floor((stripped.length * 3) / 4);
  if (approxBytes === 0 || approxBytes > MAX_PROOF_IMAGE_BYTES) {
    throw invalidArgument('La captura supera el tamaño máximo permitido (5 MB).');
  }

  const buffer = Buffer.from(stripped, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_PROOF_IMAGE_BYTES) {
    throw invalidArgument('La captura supera el tamaño máximo permitido (5 MB).');
  }

  if (!matchesImageSignature(buffer, mimeType)) {
    throw invalidArgument('El archivo no coincide con una imagen JPEG, PNG o WEBP válida.');
  }

  return stripped;
}

/** Convierte montos bancarios venezolanos (`Bs. 1.250,50`, `125,50`, `125.50`) a formato decimal plano. */
export function normalizeExtractedAmount(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw.toFixed(2);
  }
  if (typeof raw !== 'string') return '';

  const cleaned = raw.trim().replace(/[^\d.,]/g, '');
  if (!cleaned) return '';

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma !== -1 && lastDot !== -1) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const decimals = cleaned.length - lastComma - 1;
    normalized =
      decimals > 0 && decimals <= 2
        ? cleaned.slice(0, lastComma).replace(/,/g, '') + '.' + cleaned.slice(lastComma + 1)
        : cleaned.replace(/,/g, '');
  } else if (lastDot !== -1) {
    normalized = /^\d{1,3}(?:\.\d{3})+$/.test(cleaned)
      ? cleaned.replace(/\./g, '')
      : cleaned;
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value.toFixed(2);
}

/** Parsea y normaliza la respuesta JSON devuelta por Gemini Vision. */
export function parsePaymentProofResponse(raw: string): PaymentProofExtraction {
  const empty: PaymentProofExtraction = { reference: '', amount: '', bank: '', success: false };
  try {
    const withoutFence = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const candidate = withoutFence.match(/\{[\s\S]*\}/)?.[0] ?? withoutFence;
    const parsed = JSON.parse(candidate) as {
      reference?: unknown;
      amount?: unknown;
      bank?: unknown;
      success?: unknown;
    };

    const reference =
      typeof parsed.reference === 'string' || typeof parsed.reference === 'number'
        ? normalizeReference(String(parsed.reference), false)
        : '';
    const amount = normalizeExtractedAmount(parsed.amount);
    const bank =
      typeof parsed.bank === 'string'
        ? parsed.bank.replace(/\s+/g, ' ').trim().slice(0, 60)
        : '';

    if (parsed.success !== true || reference.length < 4) {
      return { reference: '', amount, bank, success: false };
    }

    return {
      reference: reference.slice(0, 40),
      amount,
      bank,
      success: true,
    };
  } catch {
    return empty;
  }
}

function readConfiguredGeminiApiKey(): string {
  try {
    const fromSecret = GEMINI_API_KEY.value().trim();
    if (fromSecret) return fromSecret;
  } catch {
    // Fuera de Cloud Functions el secreto se lee desde variable de entorno local si existe.
  }
  return (process.env.GEMINI_API_KEY ?? '').trim();
}

export async function analyzePaymentProof(
  input: AnalyzePaymentProofInput,
  deps: PaymentProofVisionDeps = {}
): Promise<PaymentProofExtraction> {
  const cleanBase64 = validateAndNormalizeProofImage(input.imageBase64, input.mimeType);
  const model = deps.model ?? geminiVisionModel();

  let outputText: string | null = null;
  if (deps.createInteraction) {
    const res = await deps.createInteraction({
      model,
      prompt: PAYMENT_PROOF_PROMPT,
      imageBase64: cleanBase64,
      mimeType: input.mimeType,
    });
    outputText = res.outputText;
  } else {
    const apiKey = (deps.apiKey ?? readConfiguredGeminiApiKey()).trim();
    if (!apiKey) {
      throw providerError('El lector de comprobantes no está configurado en este momento.');
    }

    const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
    try {
      const interaction = await ai.interactions.create(
        {
          model,
          store: false,
          input: [
            { type: 'text', text: PAYMENT_PROOF_PROMPT },
            {
              type: 'image',
              data: cleanBase64,
              mime_type: input.mimeType,
              resolution: 'high',
            },
          ],
          generation_config: {
            max_output_tokens: 250,
            thinking_level: 'low',
          },
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: EXTRACTION_SCHEMA,
          },
        },
        { timeout_ms: 25_000 }
      );
      outputText = interaction.output_text ?? null;
    } catch (error) {
      log.warn('Error llamando a Gemini Vision para comprobante de pago', {
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw providerError(
        'No pudimos analizar el comprobante en este momento. Ingresa la referencia manualmente.'
      );
    }
  }

  if (!outputText) {
    return { reference: '', amount: '', bank: '', success: false };
  }

  return parsePaymentProofResponse(outputText);
}
