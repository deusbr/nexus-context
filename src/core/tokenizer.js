// Local UTF-8 heuristic calibrated against cl100k_base/o200k_base on the
// reproducible synthetic corpus in reports/calibrate-tokenizer.mjs. Language
// and structure affect coefficients; this never represents provider usage.
export function estimateTokens(text) {
  text = String(text ?? '');
  const len = text.length;
  if (!len) return 0;

  let start = 0;
  while (start < len && (text.charCodeAt(start) <= 32)) start++;
  const firstCode = start < len ? text.charCodeAt(start) : 0;
  const json = firstCode === 123 || firstCode === 91; // '{' or '['
  const sample = len > 4096 ? text.slice(0, 4096) : text;
  const log = !json && /\b(?:INFO|WARN|DEBUG|ERROR|HTTP)\b|^\d{4}-\d\d-/m.test(sample);
  const code = !json && !log && /\b(?:const|function|export|return|import|class)\b/.test(sample);

  let portuguese = false;
  if (!json && !log && !code) {
    let diacritics = 0;
    const scanLen = Math.min(len, 16384);
    for (let i = 0; i < scanLen; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0x00c0 && c <= 0x024f) diacritics++;
    }
    portuguese = diacritics / scanLen > 0.015;
  }

  const latinWeight = json ? 0.25 : log ? 0.25 : code ? 0.20 : portuguese ? 0.35 : 0.14;
  const punctuationWeight = json ? 0.65 : log ? 0.55 : portuguese ? 0.65 : 0.5;
  const extLatinWeight = portuguese ? 0.9 : 0.65;

  let units = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c <= 127) {
      if (c >= 48 && c <= 57) {
        units += log ? 0.5 : latinWeight;
      } else if (
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c === 95 ||
        c === 32 ||
        (c >= 9 && c <= 13)
      ) {
        units += latinWeight;
      } else {
        units += punctuationWeight;
      }
    } else if (c <= 255) {
      units += extLatinWeight;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        units += 2; // 4 UTF-8 bytes / 2
        i++;
      } else {
        units += 1.5;
      }
    } else if (c <= 2047) {
      units += 1; // 2 UTF-8 bytes / 2
    } else {
      units += 1.5; // 3 UTF-8 bytes / 2
    }
  }
  return Math.ceil(units);
}

export function budget(value, fallback) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('maxTokens deve ser inteiro positivo.');
  return n;
}

export function clipText(text, maxTokens) {
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join('')) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  // Classification can change on a prefix. Every accepted prefix is measured
  // explicitly; the result is bounded even if it is not the longest possible.
  return chars.slice(0, lo).join('');
}
