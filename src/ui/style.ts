import type { CSSProperties } from 'react';

const cache = new Map<string, CSSProperties>();

/**
 * Turns the inline CSS strings of the approved design ("display:flex;gap:8px") into React style objects,
 * so the markup can be ported verbatim while staying type-safe at the call sites.
 */
export function st(css: string): CSSProperties {
  let out = cache.get(css);
  if (out) return out;
  out = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!prop || !value) continue;
    const key = prop.startsWith('--') ? prop : prop.replace(/^-webkit-/, 'Webkit').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    (out as Record<string, string>)[key.startsWith('Webkit') ? key : key] = value;
  }
  cache.set(css, out);
  return out;
}
