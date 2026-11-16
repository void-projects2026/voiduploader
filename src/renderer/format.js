export function fmtBytes(n) {
  if (!n || n < 0) return '0 KB';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function fmtSpeed(bps) {
  if (!bps || bps < 1) return '';
  return bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

// 1,2,3,5,6 -> "1-3, 5-6"
export function compressRanges(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const out = [];
  let i = 0;
  while (i < a.length) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j += 1;
    out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}
