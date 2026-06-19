// Money helpers. The backend sends prices as decimal STRINGS (e.g. "12.50", "-1.00").
// We do all cart arithmetic in integer cents to avoid IEEE-754 float drift, and format
// back to a 2-decimal string for display.

/** Parse a decimal string like "12.50" into integer cents (1250). Handles negatives and missing fraction. */
export function toCents(decimal: string | null | undefined): number {
  if (decimal == null) return 0
  const trimmed = String(decimal).trim()
  if (trimmed === '') return 0

  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = '0', fracRaw = ''] = unsigned.split('.')

  // Pad/truncate the fractional part to exactly 2 digits (round half-up on the 3rd digit).
  const frac2 = fracRaw.slice(0, 2).padEnd(2, '0')
  let cents = Number(whole) * 100 + Number(frac2)
  if (fracRaw.length > 2 && Number(fracRaw[2]) >= 5) cents += 1

  return negative ? -cents : cents
}

/** Format integer cents (1250) into a plain decimal string ("12.50"). */
export function centsToString(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/** Format integer cents for display with a currency symbol (default ₹). */
export function formatMoney(cents: number, symbol = '₹'): string {
  return `${symbol}${centsToString(cents)}`
}
