/** Génération des icônes PNG de la PWA — sans aucune dépendance.
 *
 *  Ni `sharp`, ni ImageMagick, ni librsvg ne sont supposés présents : le projet
 *  doit se construire sur un Ubuntu Server sans environnement graphique. Ce
 *  script rastérise donc la marque lui-même et encode le PNG à la main
 *  (`zlib.deflateSync` de Node plus les quatre morceaux obligatoires du format).
 *
 *  Les icônes produites sont **commitées** : la construction du front-end n'en
 *  dépend pas. Ce script sert à les régénérer si la marque change.
 *
 *      node scripts/generate-icons.mjs
 *
 *  Marque : carré arrondi sur dégradé, portant un rotor à cinq pales. Aucun
 *  texte — rastériser une police sans bibliothèque donnerait un résultat
 *  approximatif, et un pictogramme géométrique reste lisible à 48 px.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

// Couleurs reprises de src/styles/tokens.css — à garder synchronisées.
const BG = [16, 18, 22];          // --bg
const ACCENT = [77, 157, 255];    // --accent
const ACCENT_DIM = [43, 92, 153]; // --accent-dim
const INK = [8, 16, 26];          // --text-on-accent

// =====================================================================
// Encodage PNG
// =====================================================================

/** Table CRC-32, calculée une fois. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode un buffer RGBA (largeur × hauteur × 4) en PNG 8 bits. */
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // profondeur
  header[9] = 6;   // type couleur : RGBA
  header[10] = 0;  // compression
  header[11] = 0;  // filtre
  header[12] = 0;  // entrelacement

  // Une ligne = un octet de filtre (0 = aucun) suivi des pixels.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// =====================================================================
// Rastérisation
// =====================================================================

/** Toile RGBA avec échantillonnage 3×3 par pixel : sans anticrénelage, un
 *  rotor de quelques dizaines de pixels serait franchement laid. */
function createCanvas(size) {
  const data = Buffer.alloc(size * size * 4);
  const SS = 3;

  /** Peint chaque pixel selon une fonction (x, y) → [r,g,b,a] | null. */
  function paint(shade) {
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let r = 0, g = 0, b = 0, a = 0, hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = px + (sx + 0.5) / SS;
            const y = py + (sy + 0.5) / SS;
            const sample = shade(x, y);
            if (sample) {
              r += sample[0]; g += sample[1]; b += sample[2];
              a += sample[3] ?? 255;
              hits++;
            }
          }
        }
        if (hits === 0) continue;
        const total = SS * SS;
        const coverage = a / total / 255;
        const idx = (py * size + px) * 4;
        const srcR = r / hits, srcG = g / hits, srcB = b / hits;
        // Composition « source-over » sur ce qui est déjà peint.
        const dstA = data[idx + 3] / 255;
        const outA = coverage + dstA * (1 - coverage);
        if (outA === 0) continue;
        data[idx] = Math.round((srcR * coverage + data[idx] * dstA * (1 - coverage)) / outA);
        data[idx + 1] = Math.round((srcG * coverage + data[idx + 1] * dstA * (1 - coverage)) / outA);
        data[idx + 2] = Math.round((srcB * coverage + data[idx + 2] * dstA * (1 - coverage)) / outA);
        data[idx + 3] = Math.round(outA * 255);
      }
    }
  }

  return { data, paint };
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Distance signée à un rectangle arrondi centré. */
function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Dessine la marque.
 *
 * @param size    côté de l'image
 * @param padding fraction de bord laissée libre. Les icônes « maskable » sont
 *                rognées par le système (jusqu'à ~20 % de chaque côté) : la
 *                marque y est réduite pour rester entière dans la zone sûre.
 * @param opaqueBackground remplit tout le carré (exigé pour maskable et pour
 *                l'icône Apple, qui n'accepte pas la transparence).
 */
function drawMark(size, padding, opaqueBackground) {
  const canvas = createCanvas(size);
  const c = size / 2;
  const half = size * (0.5 - padding);
  const radius = half * 0.42;

  // Fond
  if (opaqueBackground) {
    canvas.paint(() => [...BG, 255]);
  }

  // Plaque : dégradé diagonal accent sombre → accent, comme le logo de l'en-tête.
  canvas.paint((x, y) => {
    const d = roundedRect(x, y, c, c, half, half, radius);
    if (d > 0) return null;
    const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
    return [...mix(ACCENT_DIM, ACCENT, t), 255];
  });

  // Rotor : cinq pales et un moyeu, évidés dans la plaque.
  const blades = 5;
  const rOuter = half * 0.62;
  const rInner = half * 0.17;
  canvas.paint((x, y) => {
    const dx = x - c, dy = y - c;
    const r = Math.hypot(dx, dy);
    if (r > rOuter || r < rInner * 0.55) return null;

    // Pale incurvée : l'angle admissible se décale avec le rayon.
    const angle = Math.atan2(dy, dx);
    const sweep = angle + (r / rOuter) * 0.9;
    const sector = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const bladeWidth = 0.42;
    const local = (sector * blades) / (2 * Math.PI) % 1;
    const onBlade = local < bladeWidth;
    // Le moyeu est plein.
    if (r < rInner) return [...INK, 255];
    return onBlade ? [...INK, 255] : null;
  });

  return encodePng(canvas.data, size, size);
}

// =====================================================================
// Sortie
// =====================================================================

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  // Icônes « any » : marge modérée, fond opaque pour un rendu correct partout.
  { file: 'icon-192.png', size: 192, padding: 0.06, opaque: true },
  { file: 'icon-512.png', size: 512, padding: 0.06, opaque: true },
  // Icônes « maskable » : la marque tient dans la zone sûre (~80 % du côté),
  // le système peut la rogner en cercle ou en goutte sans l'amputer.
  { file: 'icon-maskable-192.png', size: 192, padding: 0.19, opaque: true },
  { file: 'icon-maskable-512.png', size: 512, padding: 0.19, opaque: true },
  // iOS : l'icône d'écran d'accueil est toujours rognée en carré arrondi par le
  // système et n'accepte pas la transparence.
  { file: 'apple-touch-icon-180.png', size: 180, padding: 0.08, opaque: true },
  // Favicon d'onglet.
  { file: 'favicon-32.png', size: 32, padding: 0.04, opaque: true },
];

for (const target of targets) {
  const png = drawMark(target.size, target.padding, target.opaque);
  writeFileSync(join(OUT_DIR, target.file), png);
  console.log(`${target.file.padEnd(28)} ${String(png.length).padStart(7)} octets`);
}

console.log(`\nIcônes écrites dans ${OUT_DIR}`);
