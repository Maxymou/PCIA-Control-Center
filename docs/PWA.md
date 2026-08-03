# PWA, hors ligne et viewport iOS

Cette application pilote un refroidissement réel. La stratégie PWA en découle
entièrement : **le hors ligne ne doit jamais laisser croire que la supervision
continue, ni qu'une commande a abouti.**

---

## Stratégie de cache

Le service worker ([`src/pwa/sw-template.js`](../src/pwa/sw-template.js)) est
écrit à la main plutôt que généré par Workbox, parce que le comportement par
défaut de ce dernier est précisément celui qu'il faut interdire ici : mise en
cache opportuniste des réponses réseau et rejeu différé des requêtes.

| Requête | Politique |
|---|---|
| `/api/**`, `/ws/**` | **jamais interceptée** — le réseau, ou une erreur franche |
| méthode ≠ GET | jamais interceptée, jamais mise en file, jamais rejouée |
| navigation (document) | réseau d'abord, repli sur la coquille en cache |
| `/assets/**`, icônes, manifest | cache d'abord (noms hachés, donc immuables) |
| tout le reste | réseau seul |

Servir une température vieille de dix minutes comme si elle était actuelle, ou
rejouer une consigne de ventilation au retour du réseau sur un matériel dont
l'état a changé, serait dangereux. Le worker ne met en cache que la coquille
statique, dont les noms de fichiers sont hachés par Vite : une réponse périmée y
est impossible, puisqu'un contenu différent porte un nom différent.

Ces règles sont vérifiées deux fois : par lecture du code
(`src/pwa/pwa.test.ts`) et dans un vrai navigateur, réseau coupé — `/api/health`
doit échouer franchement au lieu d'être servie depuis un cache.

### Génération

Le plugin Vite local `pciaPwa()` ([`vite.config.ts`](../vite.config.ts)) injecte
dans le modèle la liste des ressources produites et une version **dérivée de
leur contenu** (SHA-256), jamais d'un horodatage : deux compilations identiques
produisent le même worker, donc aucune mise à jour inutile poussée aux
navigateurs.

### En-têtes serveur

`sw.js` et `manifest.webmanifest` sont servis en `Cache-Control: no-cache`
([`server/src/http/server.ts`](../server/src/http/server.ts)). Sans cela, un
worker figé par le cache HTTP survivrait à un redéploiement et continuerait de
servir l'ancienne interface. C'est aussi ce qui rend le retour arrière possible
(voir [ROLLBACK.md](ROLLBACK.md)).

---

## Comportement en cas de perte de liaison

Un seul endroit décide : [`useConnectionState.ts`](../src/ui/useConnectionState.ts).

| État | Condition | Commandes |
|---|---|---|
| `live` | données de moins de 15 s | autorisées |
| `stale` | plus de 15 s sans nouvelle mesure | **refusées** |
| `offline` | back-end injoignable ou appareil hors ligne | **refusées** |
| `simulation` | aucun back-end, moteur du navigateur | autorisées, tout est annoncé comme simulé |

L'état `stale` couvre le cas le plus dangereux : le WebSocket n'a pas signalé sa
perte, mais plus aucune mesure n'arrive. L'écran semble normal et ne l'est pas.

Ce que l'utilisateur voit :

- un bandeau **dans toutes les sections**, pas seulement la Vue d'ensemble — une
  donnée périmée doit se voir là où l'on agit ;
- l'heure exacte des dernières mesures et leur ancienneté ;
- la désactivation explicite des commandes matérielles ;
- la mention qu'**aucune commande n'est mise en attente**.

### Ce qui n'existe pas, volontairement

- aucune file d'attente de mutations ;
- aucune synchronisation différée (`background sync`) ;
- aucun rejeu automatique au retour du réseau ;
- aucun état optimiste : un succès n'est affiché qu'après réponse du serveur.

Une commande refusée hors ligne est **perdue**. L'utilisateur doit la réémettre
volontairement. C'est un choix : sur une machine dont les cartes sont refroidies
passivement, une consigne rejouée cinq minutes plus tard peut ne plus
correspondre à la situation thermique.

### Ce que le mode hors ligne permet

Uniquement de **démarrer l'interface** depuis le cache. Elle affiche alors
immédiatement son bandeau de perte de liaison et n'affiche aucune mesure : il
n'y a rien à superviser sans serveur.

---

## Mises à jour

Une nouvelle version n'est **jamais** activée automatiquement : remplacer
l'application pendant qu'on règle une courbe ou qu'on mène une calibration
serait inacceptable. Un bandeau propose le rechargement ; l'utilisateur décide.
`skipWaiting()` n'est appelé qu'en réponse à ce geste.

---

## Viewport iOS

Aucune hauteur CSS usuelle ne convient sur iOS, et particulièrement en PWA
installée :

| Valeur | Problème |
|---|---|
| `100vh` | hauteur **barre d'URL rétractée** : le bas de l'écran est inatteignable tant qu'elle est visible |
| `100dvh` | **suit le clavier** : tout le shell se rétracte à la saisie |
| première mesure au lancement | Safari annonce pendant quelques centaines de millisecondes une hauteur qui n'est pas la hauteur finale |

[`src/ui/viewport.ts`](../src/ui/viewport.ts) calcule donc deux variables,
écrites là et nulle part ailleurs :

**`--app-height`** — hauteur **stable**, gérée par un repère haut : elle ne
diminue jamais tant que l'orientation ne change pas. L'ouverture du clavier ne
rétracte donc pas l'interface. Employée par `html`, `body`, `#root`, le shell,
les superpositions et les modales.

**`--vvh`** — hauteur **réellement visible**, clavier compris. Réservée aux rares
écrans devant suivre le clavier (`.app-viewport--keyboard`).

### Détection d'une rotation

Le repère haut est réinitialisé sur l'**inversion du rapport largeur/hauteur**,
et non sur le seul événement `orientationchange`, qui se déclenche à contretemps
et parfois avant que les dimensions n'aient changé. Sans cette réinitialisation,
le passage en paysage conserverait la hauteur du mode portrait.

### Stabilisation au démarrage

Mesure immédiate, puis deux `requestAnimationFrame`, puis une salve différée
(0, 60, 150, 300, 600, 1000 ms) couvrant les animations de barre d'outils d'iOS
et la stabilisation tardive de la PWA installée. Ensuite : `resize`,
`orientationchange`, `pageshow`, `visibilitychange`, `visualViewport.resize`.

**Une rotation n'est jamais nécessaire pour corriger l'affichage.**

### Économie de repeints

Les écritures dans le DOM sont filtrées à 2 px près : un flux temps réel ne doit
pas provoquer de repeint pour une variation de barre d'outils.

### Classe plein écran

Une seule façon autorisée d'occuper l'écran :

```css
.app-viewport {
  position: fixed;
  inset: 0 auto auto 0;
  width: 100%;
  height: var(--app-height);
}
```

`100vh`, `min-height: 100vh` et `position: fixed; inset: 0` ne figurent nulle
part ailleurs. Un test le vérifie (`src/ui/accessibility.test.tsx`).

---

## Meta viewport — compromis assumé

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

`maximum-scale=1` et `user-scalable=no` sont **volontairement absents**. Les
ajouter bloquerait le zoom et violerait le critère WCAG 2.2 AA 1.4.4
(redimensionnement du texte) sur une interface qui affiche des températures et
des consignes de ventilation — exactement le genre de valeurs qu'un utilisateur
malvoyant doit pouvoir agrandir.

Le problème que ces attributs sont censés résoudre — le zoom involontaire d'iOS
à la mise au point d'un champ — est traité autrement : tous les champs passent à
16 px sur pointeur grossier, seuil en dessous duquel iOS zoome de force. Le
résultat est le même, sans sacrifier l'accessibilité.

Ce choix est vérifié par un test : ajouter `user-scalable=no` fait échouer la
suite.

---

## Scénarios iOS

Vérifiés automatiquement (jsdom, `src/ui/viewport.test.ts`) :

- lancement à froid, écriture initiale des variables ;
- ouverture du clavier — `--app-height` inchangée, `--vvh` réduite ;
- fermeture du clavier ;
- barre d'outils rétractable non confondue avec un clavier ;
- rotation portrait → paysage → portrait ;
- redimensionnement sans rotation ;
- agrandissement de la fenêtre.

Vérifiés dans Chromium : démarrage à froid, feuille mobile contenue dans
`--app-height`, pied de feuille atteignable, absence de débordement horizontal,
service worker et cache, perte puis retour du réseau.

**Non vérifiables dans cet environnement** — à contrôler sur un appareil réel :

- rendu effectif des zones sûres (`env(safe-area-inset-*)` vaut 0 dans Chromium
  émulé, y compris en profil iPhone) ;
- PWA réellement installée depuis l'écran d'accueil iOS ;
- comportement de Safari lui-même, dont le moteur diffère de Chromium ;
- barre d'état `black-translucent` et zone de l'indicateur d'accueil ;
- passage arrière-plan → premier plan sur iOS.

---

## Installation

### Ordinateur (Chrome, Edge)

Icône d'installation dans la barre d'adresse, ou menu ⋮ → « Installer PCIA
Control Center ».

### Android (Chrome)

Menu ⋮ → « Ajouter à l'écran d'accueil » / « Installer l'application ». Les
icônes `maskable` respectent la zone sûre : le système peut les rogner en cercle
ou en goutte sans amputer la marque.

### iPhone (Safari)

Safari uniquement — les autres navigateurs iOS ne permettent pas l'installation.
Bouton Partager → « Sur l'écran d'accueil ».

L'application s'ouvre alors sans barre d'adresse, avec sa propre icône, et le
fond correspond exactement à celui du manifest (aucun flash blanc au lancement).

### Prérequis

Un contexte sécurisé est nécessaire à l'enregistrement du service worker :
`localhost`/`127.0.0.1`, ou HTTPS. **Sur une adresse IP locale en HTTP simple —
le cas d'usage habituel `http://IP_PCIA:4321` — les navigateurs refusent
d'enregistrer un service worker.** L'application reste alors pleinement
fonctionnelle, mais sans installation ni démarrage hors ligne. Pour en
bénéficier sur le réseau local, placer un reverse proxy TLS devant le port 4321.
