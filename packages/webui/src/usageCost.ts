/** Saved USD estimates only; token counts and live model prices are not a pricing source. */
export const formatUsdCost = (value: number): string => {
  if (value === 0) return '$0.00 USD'
  if (value < 0.0001) return '< $0.0001 USD'
  return `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} USD`
}
