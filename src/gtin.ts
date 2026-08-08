/**
 * GTIN / barcode utilities.
 *
 * All barcodes are stored internally as a 14-digit GTIN (zero-padded) so that
 * UPC-A (12), EAN-13 (13) and EAN-8 (8) collapse to a single canonical key.
 * The iOS scanner applies the same normalization; keeping it here lets the
 * backend clean imported EANs from invoices/price files identically.
 */

/** Restricted-circulation / variable-weight GS1 prefixes that must not be treated
 *  as stable product identifiers (in-store, variable weight, coupons). */
const RESTRICTED_PREFIXES = ['02', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29'];

export class GtinError extends Error {}

/** Compute the GS1 mod-10 check digit for a numeric body (without its check digit). */
export function computeCheckDigit(bodyDigits: string): number {
  let sum = 0;
  // Weights alternate 3,1,3,1... from the RIGHTMOST body digit.
  for (let i = 0; i < bodyDigits.length; i++) {
    const digit = Number(bodyDigits[bodyDigits.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** Validate a full-length numeric GTIN (8/12/13/14) against its check digit. */
export function isValidGtin(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  return computeCheckDigit(body) === check;
}

/**
 * Normalize a scanned/imported barcode to a canonical 14-digit GTIN.
 * Throws GtinError on invalid check digit, wrong length, or a restricted prefix
 * (variable-weight/in-store codes are not stable product identifiers).
 */
export function normalizeToGtin14(raw: string): string {
  const digits = raw.trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(digits)) {
    throw new GtinError(`Barcode is not numeric: "${raw}"`);
  }
  if (![8, 12, 13, 14].includes(digits.length)) {
    throw new GtinError(`Unexpected barcode length ${digits.length}: "${raw}"`);
  }
  if (!isValidGtin(digits)) {
    throw new GtinError(`Invalid check digit: "${raw}"`);
  }
  const padded = digits.padStart(14, '0');
  // Check the GS1 prefix on the significant part (EAN-13 first two digits).
  const prefix2 = padded.slice(1, 3);
  if (RESTRICTED_PREFIXES.includes(prefix2)) {
    throw new GtinError(
      `Restricted/variable-weight prefix ${prefix2} — not a stable product code: "${raw}"`,
    );
  }
  return padded;
}

/** True if a barcode is a variable-weight/in-store restricted code (reject at scan). */
export function isRestrictedBarcode(raw: string): boolean {
  const digits = raw.trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  const padded = digits.padStart(14, '0');
  return RESTRICTED_PREFIXES.includes(padded.slice(1, 3));
}
