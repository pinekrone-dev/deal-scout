export function fmtUSD(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function parseNum(v: string): number {
  if (!v) return 0;
  const cleaned = v.replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
