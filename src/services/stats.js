export function median(arr) {
  const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function mean(arr) {
  const a = arr.filter(x => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
export function pct(arr, value) {
  const a = arr.filter(x => Number.isFinite(x));
  if (!a.length) return null;
  return a.filter(x => x <= value).length / a.length;
}
export function stddev(arr) {
  const m = mean(arr);
  const a = arr.filter(x => Number.isFinite(x));
  return a.length ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : 0;
}
export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
export function daysSince(iso) {
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 86400000);
}
