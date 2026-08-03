/** Artefacts de la PWA : manifest, icônes, politique de cache du worker.
 *
 *  Ces tests lisent les fichiers du dépôt plutôt que d'exercer une API : ce sont
 *  des garanties de contenu. La plus importante — le service worker ne met
 *  jamais en cache les données vivantes — est vérifiée deux fois : par lecture
 *  du code, et dans un vrai navigateur lors des contrôles de non-régression.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, unknown>;

  it('est installable : nom, portée, point d’entrée et affichage autonome', () => {
    expect(manifest.name).toBe('PCIA Control Center');
    expect(manifest.short_name).toBe('PCIA');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('emploie exactement la couleur de fond réelle de l’application', () => {
    // Une divergence entre ces trois valeurs produit un flash blanc au
    // lancement de la PWA installée.
    const tokens = read('src/styles/tokens.css');
    const bg = /--bg:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
    expect(bg).toBeTruthy();
    expect(manifest.background_color).toBe(bg);
    expect(manifest.theme_color).toBe(bg);
    expect(read('index.html')).toContain(`content="${bg}"`);
  });

  it('fournit des icônes 192 et 512, dont des variantes maskable', () => {
    const icons = manifest.icons as { sizes: string; purpose: string; src: string }[];
    const any = icons.filter((i) => i.purpose === 'any');
    const maskable = icons.filter((i) => i.purpose === 'maskable');
    expect(any.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    expect(maskable.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
  });

  it('référence des icônes qui existent réellement et sont de vrais PNG', () => {
    const icons = manifest.icons as { src: string }[];
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const icon of icons) {
      const bytes = readFileSync(join(ROOT, 'public', icon.src));
      expect(bytes.subarray(0, 8), `${icon.src} n'est pas un PNG`).toEqual(signature);
    }
  });
});

describe('métadonnées iOS', () => {
  const html = read('index.html');

  it('déclare l’application autonome et le style de barre d’état', () => {
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="PCIA Control Center"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
  });

  it('couvre les encoches avec viewport-fit=cover', () => {
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it('ne bloque pas le zoom d’accessibilité', () => {
    // Choix documenté : bloquer le zoom violerait WCAG 2.2 AA 1.4.4 sur une
    // interface affichant des températures et des consignes de ventilation.
    const viewport = /name="viewport"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(viewport).not.toContain('user-scalable=no');
    expect(viewport).not.toContain('maximum-scale');
  });

  it('déclare une icône d’écran d’accueil, que le manifest ne suffit pas à fournir', () => {
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it('peint le fond avant tout script, contre le flash blanc au démarrage', () => {
    expect(html).toMatch(/html,\s*body,\s*#root\s*\{[^}]*background-color:\s*#101216/s);
  });
});

describe('service worker — politique de cache', () => {
  const sw = read('src/pwa/sw-template.js');

  it('ne met jamais en cache les données vivantes', () => {
    // La fonction de reconnaissance existe et couvre les deux préfixes.
    expect(sw).toMatch(/function isLiveData\(url\)/);
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toContain("url.pathname.startsWith('/ws/')");
    // Et elle provoque une sortie *avant* toute prise en charge.
    expect(sw).toMatch(/if \(isLiveData\(url\)\) return;/);
  });

  it('sort avant toute réponse pour les requêtes non GET', () => {
    const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
    const guard = fetchHandler.indexOf("request.method !== 'GET'");
    const firstRespond = fetchHandler.indexOf('respondWith');
    expect(guard).toBeGreaterThan(-1);
    // Aucune mutation ne peut atteindre une branche qui répondrait à sa place.
    expect(guard).toBeLessThan(firstRespond);
  });

  it('n’implémente aucune file d’attente ni synchronisation différée', () => {
    // `background sync` et une file de rejeu sont exactement ce qu'il ne faut
    // pas sur une application qui envoie des consignes de ventilation : une
    // requête différée serait rejouée sur un matériel dont l'état a changé.
    // On cible les API réelles, pas le mot « synchronisation » des commentaires.
    expect(sw).not.toMatch(/addEventListener\(\s*['"]sync['"]/);
    expect(sw).not.toMatch(/addEventListener\(\s*['"]periodicsync['"]/);
    expect(sw).not.toMatch(/\bBackgroundSync\b/);
    expect(sw).not.toMatch(/\bindexedDB\b/i);
    // Aucune structure de rejeu : ni tableau de requêtes en attente, ni relance.
    expect(sw).not.toMatch(/\bqueue\b/i);
    expect(sw).not.toMatch(/\breplay\b/i);
  });

  it('sert la navigation par le réseau d’abord', () => {
    expect(sw).toMatch(/async function handleNavigation[\s\S]*?const response = await fetch\(request\)/);
  });

  it('n’active pas une nouvelle version sans geste de l’utilisateur', () => {
    // `skipWaiting` n'est appelé qu'en réponse à un message explicite.
    const calls = sw.match(/self\.skipWaiting\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(sw).toMatch(/'pcia:skip-waiting'\) self\.skipWaiting\(\)/);
  });

  it('purge les caches des versions précédentes à l’activation', () => {
    expect(sw).toMatch(/caches\.delete\(name\)/);
  });
});

describe('génération du service worker', () => {
  const config = read('vite.config.ts');

  it('précache la coquille et la page hors ligne', () => {
    expect(config).toContain("'/index.html'");
    expect(config).toContain("'/offline.html'");
    expect(config).toContain("'/manifest.webmanifest'");
  });

  it('ne précache que du statique — jamais une route d’API', () => {
    const precache = /const precache = \[([\s\S]*?)\];/.exec(config)?.[1] ?? '';
    expect(precache).not.toContain('/api/');
    expect(precache).not.toContain('/ws/');
  });

  it('dérive la version du contenu, pas d’un horodatage', () => {
    // Un horodatage pousserait une mise à jour à chaque compilation, même
    // identique, et déclencherait des bandeaux de mise à jour injustifiés.
    expect(config).toMatch(/createHash\('sha256'\)[\s\S]*?\.update\(precache/);
    expect(config).not.toMatch(/Date\.now\(\)/);
  });
});

describe('page hors ligne', () => {
  const html = read('public/offline.html');

  it('explique qu’aucune commande n’a été mise en attente', () => {
    // Le texte est mis en forme sur plusieurs lignes : on compare le contenu
    // normalisé, pas la mise en page du fichier source.
    const text = html.replace(/\s+/g, ' ');
    expect(text).toMatch(/aucune commande n’a été mise en attente/i);
    expect(text).toMatch(/rien ne sera envoyé automatiquement/i);
  });

  it('n’affiche aucune mesure', () => {
    // Une page hors ligne ne doit pas donner l'illusion d'une supervision.
    expect(html).not.toMatch(/\d+\s*°C/);
    expect(html).not.toMatch(/\d+\s*RPM/);
  });

  it('emploie le même fond que l’application', () => {
    expect(html).toContain('#101216');
  });
});
