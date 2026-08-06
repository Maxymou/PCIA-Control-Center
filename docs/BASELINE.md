# Base de référence avant la refonte responsive / PWA

Relevé exécuté sur la branche `claude/pcia-responsive-pwa-refactor-l14szn`, au commit
`5d854e5` (identique à `origin/main`), **avant toute modification**.

Environnement : Node.js v22.22.2, npm 10.9.7, Linux.

## Commandes exécutées

| Commande | Résultat | Détail |
|---|---|---|
| `npm ci` | ✅ | 0 vulnérabilité |
| `npm run build` | ✅ | `dist/` (index.html + assets) et `dist-server/` produits |
| `npm test` | ✅ | **9 fichiers, 212 tests, 212 réussis**, 229 s |
| `npm run typecheck` | ✅ | `tsc -b` + `tsc -p server/tsconfig.json --noEmit`, aucune erreur |

Scripts absents du `package.json` (non exécutables) : `lint`, `test:unit`,
`test:integration`, `test:e2e`.

## Sortie du build (référence de taille)

```
dist/index.html                   0.40 kB │ gzip:   0.28 kB
dist/assets/index-BiOjjNKe.css   27.97 kB │ gzip:   5.61 kB
dist/assets/index-VuZKmIXz.js   877.51 kB │ gzip: 262.00 kB
```

Avertissement Vite préexistant : le bundle dépasse 500 kB (React Flow + Recharts).
Ce n'est pas une régression introduite par la refonte.

## Échecs préexistants

**Aucun.** L'intégralité de la suite passe avant modification. Tout échec constaté
après une étape de refonte est donc imputable à cette étape et doit être corrigé
avant de poursuivre.

## Périmètre couvert par les 212 tests serveur

| Fichier | Couverture |
|---|---|
| `server/test/curve.test.ts` | validation et interpolation des courbes |
| `server/test/safety.test.ts` | capteurs, températures, ventilateur bloqué, planchers |
| `server/test/hwmon.test.ts` | identité stable des contrôleurs, pannes matérielles |
| `server/test/sensors.test.ts` | agrégation et association des capteurs |
| `server/test/engine.test.ts` | transitions d'état, failsafe, verrou, arrêt |
| `server/test/calibration.test.ts` | assistant de calibration, retour BIOS |
| `server/test/repositories.test.ts` | SQLite, migrations |
| `server/test/api.test.ts` | routes REST, snapshot, profils, services |
| `server/test/deployment.test.ts` | systemd, udev, verrou moteur, `install.sh` |

Ces tests ne touchent aucun matériel réel et doivent rester **inchangés** : la refonte
ne concerne que le front-end (plus les en-têtes de cache PWA du serveur HTTP).
