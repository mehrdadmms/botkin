// Kins: Botkin's bot avatars. Simple glossy shapes, two tilted eyes, blush and a smile.
// Each handle always gets the same kin (shape, color, eyes, antenna) from a hash.

const SHAPES = {
  ball: { d: "M50 12a40 40 0 1 1 0 80a40 40 0 1 1 0-80Z", face: 52 },
  squircle: { d: "M38 14h24c18 0 26 8 26 26v24c0 18-8 26-26 26H38c-18 0-26-8-26-26V40c0-18 8-26 26-26Z", face: 52 },
  blob: { d: "M50 12C78 10 92 32 88 56C85 80 66 90 46 88C22 86 8 70 12 46C15 26 30 13 50 12Z", face: 50 },
  bean: { d: "M34 28h32a26 26 0 0 1 0 52H34a26 26 0 0 1 0-52Z", face: 54 },
  gumdrop: { d: "M50 14c6 0 10 4 14 11l24 47c4 10-2 16-12 16H24c-10 0-16-6-12-16l24-47c4-7 8-11 14-11Z", face: 64 },
  cloud: { d: "M30 84C16 84 8 74 10 62c2-10 10-15 18-14c0-14 12-24 24-22c10 1 18 8 20 18c12 0 20 10 18 22c-2 11-10 18-20 18Z", face: 62 },
  heart: { d: "M50 88C30 74 10 60 10 40c0-14 10-24 23-24c8 0 14 4 17 11c3-7 9-11 17-11c13 0 23 10 23 24c0 20-20 34-40 48Z", face: 44 },
  egg: { d: "M50 12c20 0 34 22 34 44s-14 36-34 36s-34-14-34-36s14-44 34-44Z", face: 58 },
};
const SHAPE_NAMES = Object.keys(SHAPES);
const COLORS = ["#1d7bff", "#ff6a13", "#00b39b", "#ff2d55", "#ff3ea5", "#8b5cf6", "#ffa800", "#22c55e", "#0ea5e9"];

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

let uid = 0;
/** SVG markup for the kin of `seed` (a bot handle). */
export function kin(seed, { size = 40, mood } = {}) {
  const h = hash(seed);
  const name = SHAPE_NAMES[h % SHAPE_NAMES.length];
  const { d, face } = SHAPES[name];
  const color = COLORS[(h >>> 4) % COLORS.length];
  const eyes = mood ?? ["oval", "oval", "happy", "sparkle"][(h >>> 8) % 4];
  const antenna = ["ball", "squircle", "egg", "bean"].includes(name) && (h >>> 12) % 3 === 0;
  const id = `k${h.toString(36)}${uid++}`;
  const y = face;
  const eye = (x, tilt) =>
    eyes === "happy"
      ? `<path d="M${x - 4} ${y - 2}q4 -6 8 0" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>`
      : `<g class="kin-eye" style="transform-origin:${x}px ${y - 3}px"><ellipse cx="${x}" cy="${y - 3}" rx="3.6" ry="6.4" fill="#fff" transform="rotate(${tilt} ${x} ${y - 3})"/>${
          eyes === "sparkle" ? `<circle cx="${x + 1}" cy="${y - 6}" r="1.3" fill="${color}"/>` : ""}</g>`;
  return `<svg class="kin" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" style="--blink-delay:${(h % 50) / 10}s">
    <defs><radialGradient id="${id}" cx="35%" cy="28%" r="80%">
      <stop offset="0" stop-color="${shade(color, 0.18)}"/><stop offset="1" stop-color="${shade(color, -0.12)}"/></radialGradient></defs>
    ${antenna ? `<line x1="50" y1="14" x2="50" y2="4" stroke="${shade(color, -0.2)}" stroke-width="3" stroke-linecap="round"/>
      <path d="M50 6c-2-3-7-2-6 2c1 2 4 4 6 5c2-1 5-3 6-5c1-4-4-5-6-2Z" fill="#ff4d7d"/>` : ""}
    <path d="${d}" fill="url(#${id})"/>
    <ellipse cx="34" cy="${Math.min(y - 20, 30)}" rx="12" ry="7" fill="#fff" opacity="0.28" transform="rotate(-25 34 ${Math.min(y - 20, 30)})"/>
    ${eye(41, -10)}${eye(59, 10)}
    <ellipse cx="31" cy="${y + 7}" rx="6" ry="3.4" fill="#ff8fb4" opacity="0.6"/>
    <ellipse cx="69" cy="${y + 7}" rx="6" ry="3.4" fill="#ff8fb4" opacity="0.6"/>
    <path d="M45 ${y + 6}q5 5 10 0" fill="none" stroke="${shade(color, -0.35)}" stroke-width="2.6" stroke-linecap="round"/>
  </svg>`;
}

/** Little heart burst from an element, for celebrating (copying, friend moments). */
export function hearts(el) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 10; i++) {
    const s = document.createElement("span");
    s.className = "heart-pop";
    s.textContent = ["❤", "✦", "♥"][i % 3];
    s.style.left = `${r.left + r.width / 2}px`;
    s.style.top = `${r.top + r.height / 2}px`;
    s.style.setProperty("--dx", `${(Math.random() - 0.5) * 140}px`);
    s.style.setProperty("--dy", `${-40 - Math.random() * 90}px`);
    s.style.color = COLORS[i % COLORS.length];
    document.body.append(s);
    setTimeout(() => s.remove(), 900);
  }
}
