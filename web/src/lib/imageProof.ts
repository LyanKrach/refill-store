/**
 * Prepara la captura de comprobante bancario antes de enviarla al backend.
 *
 * Mantiene sin recomprimir capturas nítidas pequeñas y reduce fotos pesadas
 * de cámara móvil (> 1.5 MB o > 1800 px) para que la lectura con Gemini Vision
 * sea rápida sin superar los límites del servidor.
 */
import type { SupportedProofMimeType } from '@/types/models';

export const ACCEPTED_PROOF_MIME_TYPES: ReadonlySet<SupportedProofMimeType> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const MAX_RAW_FILE_BYTES = 12 * 1024 * 1024;
const DIRECT_SEND_BYTES = 1.5 * 1024 * 1024;
const MAX_DIMENSION = 1800;

export interface PreparedProofImage {
  imageBase64: string;
  mimeType: SupportedProofMimeType;
  previewUrl: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('No se pudo leer la imagen seleccionada.'));
    };
    reader.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo decodificar la imagen.'));
    img.src = src;
  });
}

function splitDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export async function preparePaymentProofImage(file: File): Promise<PreparedProofImage> {
  if (!ACCEPTED_PROOF_MIME_TYPES.has(file.type as SupportedProofMimeType)) {
    throw new Error('Formato no compatible. Sube una imagen JPG, PNG o WEBP.');
  }
  if (file.size <= 0) {
    throw new Error('La imagen seleccionada está vacía.');
  }
  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error('La captura es demasiado pesada (máximo 12 MB).');
  }

  const originalMime = file.type as SupportedProofMimeType;
  const dataUrl = await readFileAsDataUrl(file);

  if (file.size <= DIRECT_SEND_BYTES) {
    return {
      imageBase64: splitDataUrl(dataUrl),
      mimeType: originalMime,
      previewUrl: dataUrl,
    };
  }

  try {
    const img = await loadImage(dataUrl);
    const largestSide = Math.max(img.naturalWidth, img.naturalHeight);
    if (largestSide <= MAX_DIMENSION && file.size <= 4 * 1024 * 1024) {
      return {
        imageBase64: splitDataUrl(dataUrl),
        mimeType: originalMime,
        previewUrl: dataUrl,
      };
    }

    const scale = largestSide > MAX_DIMENSION ? MAX_DIMENSION / largestSide : 1;
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        imageBase64: splitDataUrl(dataUrl),
        mimeType: originalMime,
        previewUrl: dataUrl,
      };
    }

    ctx.drawImage(img, 0, 0, width, height);
    const outMime: SupportedProofMimeType = originalMime === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const resizedUrl = canvas.toDataURL(outMime, 0.88);
    return {
      imageBase64: splitDataUrl(resizedUrl),
      mimeType: outMime,
      previewUrl: resizedUrl,
    };
  } catch {
    return {
      imageBase64: splitDataUrl(dataUrl),
      mimeType: originalMime,
      previewUrl: dataUrl,
    };
  }
}
