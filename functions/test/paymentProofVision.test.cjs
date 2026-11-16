const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAYMENT_PROOF_PROMPT,
  validateAndNormalizeProofImage,
  normalizeExtractedAmount,
  parsePaymentProofResponse,
  analyzePaymentProof,
} = require('../lib/services/paymentProofVision.js');

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

test('validateAndNormalizeProofImage acepta PNG con prefijo data URL y valida firma mágica', () => {
  const clean = validateAndNormalizeProofImage(`data:image/png;base64,${SAMPLE_PNG_BASE64}`, 'image/png');
  assert.equal(clean, SAMPLE_PNG_BASE64);

  assert.throws(
    () => validateAndNormalizeProofImage(SAMPLE_PNG_BASE64, 'image/jpeg'),
    /JPEG, PNG o WEBP/
  );
  assert.throws(
    () => validateAndNormalizeProofImage('no-es-base64!!!', 'image/png'),
    /Base64 válido/
  );
});

test('normalizeExtractedAmount normaliza montos bancarios venezolanos con puntos y comas', () => {
  assert.equal(normalizeExtractedAmount('Bs. 1.250,50'), '1250.50');
  assert.equal(normalizeExtractedAmount('125,50'), '125.50');
  assert.equal(normalizeExtractedAmount('1,250.50 USD'), '1250.50');
  assert.equal(normalizeExtractedAmount('1.250'), '1250.00');
  assert.equal(normalizeExtractedAmount('480.00'), '480.00');
  assert.equal(normalizeExtractedAmount(350), '350.00');
  assert.equal(normalizeExtractedAmount(''), '');
});

test('parsePaymentProofResponse extrae referencia numérica, monto y banco desde JSON o fences', () => {
  const parsed = parsePaymentProofResponse(`\`\`\`json
{
  "reference": "Ref: 0045-891234",
  "amount": "Bs.S 1.470,00",
  "bank": "  Banco   de Venezuela (BDV) ",
  "success": true
}
\`\`\``);

  assert.deepEqual(parsed, {
    reference: '0045891234',
    amount: '1470.00',
    bank: 'Banco de Venezuela (BDV)',
    success: true,
  });
});

test('parsePaymentProofResponse fuerza success=false y reference vacía cuando no hay referencia clara', () => {
  assert.deepEqual(
    parsePaymentProofResponse('{"reference":"12","amount":"100.00","bank":"Banesco","success":true}'),
    { reference: '', amount: '100.00', bank: 'Banesco', success: false }
  );
  assert.deepEqual(
    parsePaymentProofResponse('texto inesperado sin json'),
    { reference: '', amount: '', bank: '', success: false }
  );
});

test('analyzePaymentProof invoca el modelo multimodal con el prompt estructurado y devuelve resultado normalizado', async () => {
  let captured = null;
  const result = await analyzePaymentProof(
    { imageBase64: `data:image/png;base64,${SAMPLE_PNG_BASE64}`, mimeType: 'image/png' },
    {
      model: 'gemini-4-hydrogen',
      createInteraction: async (params) => {
        captured = params;
        return {
          outputText: JSON.stringify({
            reference: '89123456',
            amount: '980,50',
            bank: 'Mercantil',
            success: true,
          }),
        };
      },
    }
  );

  assert.equal(captured.model, 'gemini-4-hydrogen');
  assert.equal(captured.mimeType, 'image/png');
  assert.equal(captured.imageBase64, SAMPLE_PNG_BASE64);
  assert.equal(captured.prompt, PAYMENT_PROOF_PROMPT);
  assert.deepEqual(result, {
    reference: '89123456',
    amount: '980.50',
    bank: 'Mercantil',
    success: true,
  });
});
