# Retour à la version précédente

La refonte ne touche ni la base SQLite, ni les migrations, ni les unités
systemd, ni la règle udev, ni le moteur de ventilation. **Un retour arrière se
limite donc à redéployer le front-end et le serveur d'application précédents.**

Aucune donnée utilisateur n'est perdue : disposition du graphe, services et
connexions manuels, corrections, notes, profils personnalisés et calibrations
sont stockés côté serveur (SQLite) dans des schémas inchangés.

---

## 1. Redéployer la version précédente

```bash
cd /chemin/vers/PCIA-Control-Center
git log --oneline                 # repérer le commit visé
git checkout <commit-precedent>
npm ci
npm run build
sudo ./packaging/install.sh
```

Le script réinstalle `/opt/pcia-control-center`, **sauvegarde** la configuration
existante sans l'écraser, et redémarre les deux services.

Vérification :

```bash
systemctl status pcia-control-center pcia-fan-control
curl -s http://127.0.0.1:4321/api/health
```

---

## 2. Le cas particulier du service worker

Un service worker **survit à un redéploiement** : il reste installé dans le
navigateur de chaque utilisateur et peut continuer à servir la coquille mise en
cache. C'est le seul élément de la refonte qui ne disparaît pas en revenant en
arrière côté serveur.

Trois mécanismes le rendent inoffensif :

1. **`sw.js` est servi en `no-cache`.** Le navigateur revérifie le fichier à
   chaque chargement. S'il a disparu (retour à une version antérieure à la PWA),
   l'enregistrement échoue et le worker est écarté.
2. **La navigation est toujours réseau d'abord.** Tant que le serveur répond,
   l'utilisateur reçoit la version servie par le serveur, jamais celle du cache.
3. **Aucune donnée d'API n'est mise en cache.** Un worker périmé ne peut pas
   afficher de mesures obsolètes : il n'en détient aucune.

### Purge immédiate, côté utilisateur

En cas de doute, dans la console du navigateur :

```js
navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
caches.keys().then((ks) => ks.filter((k) => k.startsWith('pcia-')).forEach((k) => caches.delete(k)));
location.reload();
```

La même opération est disponible sous forme de fonction exportée,
`unregisterServiceWorker()` dans
[`src/pwa/register.ts`](../src/pwa/register.ts), utilisable depuis un correctif
si nécessaire.

### Purge forcée, côté serveur

Pour neutraliser à distance un worker déployé, servir un `sw.js` qui se
désinstalle lui-même :

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', async () => {
  await self.registration.unregister();
  const names = await caches.keys();
  await Promise.all(names.map((n) => caches.delete(n)));
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.navigate(c.url));
});
```

Déposer ce fichier à la place de `dist/sw.js`. Comme il est servi en `no-cache`,
il est récupéré au chargement suivant et supprime le worker de tous les
navigateurs concernés.

---

## 3. Revenir sur une partie seulement

Les commits de la refonte sont découpés par sujet et peuvent être annulés
séparément :

```bash
git log --oneline --no-merges     # repérer le commit à annuler
git revert <commit>
npm run build && npm test
sudo ./packaging/install.sh
```

Dépendances entre commits :

| Commit | Peut être annulé seul ? |
|---|---|
| PWA (manifest, worker, icônes) | oui — retire l'installabilité, rien d'autre |
| Accessibilité | oui |
| Tests d'interface | oui |
| Ventilation (sécurité, calibration) | oui — la section revient à ses réglages seuls |
| Services (vue liste) | oui |
| Matériel (inventaire) | oui |
| Navigation à six sections | non — les sections en dépendent |
| Viewport et design system | non — tout le reste en dépend |

---

## 4. Ce qu'un retour arrière ne change pas

- la base SQLite et son schéma ;
- `/etc/pcia-control-center/config.yaml` ;
- les unités systemd et la règle udev ;
- l'état de calibration des sorties ;
- le moteur de ventilation, qui n'a pas été modifié.

Le moteur étant un processus distinct, la régulation continue pendant tout le
redéploiement : arrêter ou remplacer le serveur web n'interrompt pas la
ventilation.

---

## 5. Vérification après retour arrière

```bash
systemctl status pcia-control-center pcia-fan-control
curl -s http://127.0.0.1:4321/api/health
curl -s http://127.0.0.1:4321/api/snapshot | head -c 200
node /opt/pcia-control-center/dist-server/server/src/cli.js status
```

Dans le navigateur, après un rechargement forcé : l'interface attendue
s'affiche, aucune erreur en console, et les sorties de ventilation présentent
l'état publié par le moteur.
