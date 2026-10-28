// Kins: Botkin's bot avatars, in the Grok Bot style: a flat colored shape with two white pill eyes.
// Each handle always gets the same kin from a hash.

const SHAPES = [
  "M50 12a38 38 0 1 1 0 76a38 38 0 1 1 0-76Z", // ball
  "M38 14h24c18 0 26 8 26 26v20c0 18-8 26-26 26H38c-18 0-26-8-26-26V40c0-18 8-26 26-26Z", // squircle
  "M50 14C76 12 90 32 87 55C84 78 66 88 46 86C22 84 9 68 13 46C16 27 31 15 50 14Z", // blob
  "M34 30h32a22 22 0 0 1 0 44H34a22 22 0 0 1 0-44Z", // pill
  "M50 16c5 0 9 3 13 10l23 44c4 9-1 16-11 16H25c-10 0-15-7-11-16l23-44c4-7 8-10 13-10Z", // triangle
  "M50 12l30 17c4 2 6 6 6 10v22c0 4-2 8-6 10L50 88l-30-17c-4-2-6-6-6-10V39c0-4 2-8 6-10Z", // hexagon
  "M30 82C17 82 9 72 11 61c2-9 9-14 17-13c0-13 11-22 23-20c9 1 17 8 19 17c11 0 19 10 17 21c-2 10-10 16-19 16Z", // cloud
  "M50 10c8 12 32 34 32 52a32 32 0 0 1-64 0c0-18 24-40 32-52Z", // drop
];
const COLORS = ["#1d7bff", "#ff6a13", "#00b39b", "#ff2d55", "#ff3ea5", "#8b5cf6", "#ffa800", "#8b5a2b"];

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** SVG markup for the kin of `seed` (a bot handle). */
export function kin(seed, size = 40) {
  const h = hash(seed);
  const shape = SHAPES[h % SHAPES.length];
  const color = COLORS[(h >>> 4) % COLORS.length];
  // Rotation lives on the <g> so the blink (a CSS scale on the rect) doesn't fight it.
  const eye = (x) =>
    `<g transform="rotate(12 ${x + 3.5} 48)"><rect class="kin-eye" x="${x}" y="40" width="7" height="16" rx="3.5" fill="#fff"/></g>`;
  return `<svg class="kin" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" style="--d:${(h % 50) / 10}s">` +
    `<path d="${shape}" fill="${color}"/>${eye(45)}${eye(58)}</svg>`;
}
