# PCIA Control Center

Supervision et pilotage d'un PC dédié à l'IA sous Ubuntu : matériel, services et
connexions sous forme de graphe interactif, ventilation avec courbes éditables,
profils, alertes et historiques.

L'interface est **responsive et installable en PWA** : utilisable au poste de
travail comme au doigt sur tablette, téléphone Android ou iPhone depuis l'écran
d'accueil.

L'application se compose d'une interface web (React) et d'un back-end en deux
processus : un serveur d'application et un **moteur de ventilation autonome**.

```
http://IP_PCIA:4321/          interface
http://IP_PCIA:4321/api/      API REST
ws://IP_PCIA:4321/ws/live     flux temps réel
```

---

## Sommaire

- [Architecture](#architecture)
- [Interface](#interface)
- [Installation en application (PWA)](#installation-en-application-pwa)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Modes d'exécution](#modes-dexécution)
- [Configuration](#configuration)
- [Calibration des ventilateurs](#calibration-des-ventilateurs)
- [Sécurités](#sécurités)
- [API REST](#api-rest)
- [WebSocket](#websocket)
- [Outil en ligne de commande](#outil-en-ligne-de-commande)
- [Développement](#développement)
- [Tests](#tests)
- [Documentation technique](#documentation-technique)
- [Limites connues](#limites-connues)
- [Dépannage](#dépannage)
- [Désinstallation](#désinstallation)

---

## Architecture

```
Navigateur
    │  HTTP + WebSocket (port 4321)
    ▼
pcia-control-center.service           ← serveur d'application
    ├── sert le front-end compilé (dist/)
    ├── API REST + WebSocket
    ├── supervision matérielle (CPU, RAM, NVMe, GPU)
    ├── détection des services et des connexions
    ├── alertes, événements, historique
    └── base SQLite (configuration + mesures)
              │
              │  socket Unix (commandes)   +   SQLite (configuration, lecture)
              ▼
pcia-fan-control.service              ← moteur de ventilation
    ├── lecture des capteurs
    ├── calcul des consignes (courbes)
    ├── écriture des sorties PWM
    ├── lecture des RPM
    ├── sécurités et failsafe
    ├── restitution au BIOS
    └── heartbeat
```

**Le moteur de ventilation ne dépend pas de l'API.** Il lit sa configuration
directement en base et ses capteurs directement dans `/sys`. L'arrêt, le
plantage ou le redémarrage du serveur web n'interrompt pas la régulation. Un
verrou exclusif (`/run/pcia-control-center/fan-engine.lock`) garantit qu'un seul
processus écrit les sorties PWM à un instant donné.

### Arborescence

```
src/                    front-end React
├── types/              modèles de données — contrat partagé avec le back-end
├── services/           ★ couche de données
│   ├── dataService.ts    proxy : choisit la source au démarrage
│   ├── apiProvider.ts    back-end réel (REST + WebSocket)
│   ├── mockProvider.ts   simulation locale (sans back-end)
│   └── apiClient.ts      client HTTP + WebSocket avec reconnexion
├── mocks/              moteur de simulation navigateur (mode hors ligne)
├── store/              Zustand : données live, configuration, état UI
├── styles/             design system : jetons, socle, composants, mise en page
├── ui/                 ★ primitives d'interface
│   ├── viewport.ts       hauteurs --app-height / --vvh (gestion iOS)
│   ├── useBreakpoint.ts  points de rupture et nature du pointeur
│   ├── AppShell.tsx      ossature et navigations
│   ├── Modal.tsx         modale et feuille mobile (piège de focus)
│   ├── Tooltip.tsx       infobulle accessible, recadrée dans la fenêtre
│   ├── ConfirmDialog.tsx confirmation énonçant action, cible et conséquences
│   ├── Measure.tsx       affichage d'une mesure avec sa provenance
│   └── useConnectionState.ts  décide seul si les commandes sont autorisées
├── sections/           les six sections de l'application
├── pwa/                service worker et enregistrement
├── features/           graphe des services, matériel et ventilation
└── components/         en-tête, alertes, panneau de démonstration

server/src/
├── index.ts            serveur d'application (API + front-end + WebSocket)
├── fand.ts             daemon de ventilation
├── cli.ts              outil d'administration
├── config.ts           configuration YAML + variables d'environnement
├── contract.ts         types partagés avec le front-end
├── runtime.ts          résolution du mode (matériel / démonstration)
├── db/                 SQLite : migrations et repositories
├── hwmon/              abstraction des contrôleurs (sysfs réel / simulé)
├── hardware/           CPU, mémoire, stockage, GPU, capteurs, inventaire
├── discovery/          services, connexions, sockets, fusion des corrections
├── fan/                courbes, moteur, sécurités, calibration, IPC, verrou
├── app/                orchestrateur, alertes, passerelle vers le moteur
├── http/               serveur Fastify, routes, WebSocket, contrôle d'accès
└── demo/               monde simulé du mode démonstration

server/test/            212 tests serveur (aucun n'accède au matériel réel)
src/**/*.test.tsx       135 tests d'interface (jsdom)
public/                 manifest, icônes, page hors ligne
scripts/                génération des icônes PNG (sans dépendance)
docs/                   documentation technique
packaging/              unités systemd, règle udev, scripts d'installation
```

---

## Interface

Six sections, accessibles par une navigation latérale sur ordinateur et par une
barre basse sur téléphone :

| Section | Contenu |
|---|---|
| **Vue d'ensemble** | état global, mode d'exécution, CPU, GPU le plus chaud, puissance GPU, stockage, profil actif, alertes, état des cinq sorties, points d'attention |
| **Matériel** | inventaire complet des composants, schéma des attributions, historique des températures |
| **Services et connexions** | graphe interactif, vue liste, ajout manuel, corrections, groupes, masquage |
| **Ventilation** | profils, sorties, état de sécurité, courbes éditables, assistant de calibration, historique |
| **Alertes et événements** | alertes actives et historiques, journal filtrable |
| **Paramètres** | préférences d'affichage, source des données, capacités détectées, disposition, mode démonstration |

### Adaptation à l'écran

| Largeur | Comportement |
|---|---|
| ≥ 1280 px | navigation latérale déployée, vue dense, panneaux de détail permanents |
| 768–1279 px | navigation réduite aux icônes, deux colonnes |
| < 768 px | barre de navigation basse, une colonne, panneaux en feuilles mobiles |

Certaines fonctions ont une **présentation mobile distincte**, jamais une
version amputée : le graphe des services devient une liste triée par gravité
(la bascule vers le graphe reste disponible), le tableau de ventilation devient
une carte par sortie sans perdre une colonne, et les points de courbe se règlent
au champ numérique en plus du glissement.

Sur écran tactile, toutes les commandes passent automatiquement à 44 × 44 px,
quelle que soit la taille de l'écran.

### Provenance des données

Une valeur **simulée** — mode démonstration ou simulation navigateur — est
soulignée en pointillés et annoncée comme telle. Une valeur absente indique sa
cause : « indisponible », « aucun capteur » ou « erreur de lecture ». Une valeur
inconnue n'est jamais présentée comme une mesure réelle.

### Accessibilité

Conforme WCAG 2.2 niveau AA, vérifié par audit axe-core sur chaque section, en
ordinateur et en mobile, ainsi qu'avec les superpositions ouvertes : navigation
clavier complète, focus visible, piège de focus dans les modales, contrastes
mesurés sur le fond réel des cartes, état jamais porté par la seule couleur,
alternative textuelle pour le schéma matériel et les courbes, et respect de
`prefers-reduced-motion`.

Le zoom d'accessibilité n'est **pas** bloqué : voir
[docs/PWA.md](docs/PWA.md#meta-viewport--compromis-assumé) pour le compromis
retenu.

---

## Installation en application (PWA)

> **Prérequis : un contexte sécurisé.** Les navigateurs n'enregistrent un
> service worker — et ne proposent l'installation — que sur `localhost`,
> `127.0.0.1` ou **HTTPS**. Sur une adresse IP locale en HTTP simple, cas
> habituel de `http://IP_PCIA:4321`, l'application reste pleinement
> fonctionnelle mais **n'est ni installable ni disponible hors ligne**. Pour en
> bénéficier sur le réseau local, placer un reverse proxy TLS devant le
> port 4321.

### Ordinateur — Chrome, Edge

Icône d'installation dans la barre d'adresse, ou menu ⋮ → « Installer PCIA
Control Center ».

### Android — Chrome

Menu ⋮ → « Ajouter à l'écran d'accueil ». Les icônes *maskable* respectent la
zone sûre : le système peut les rogner en cercle ou en goutte sans amputer la
marque.

### iPhone — Safari

Safari uniquement, les autres navigateurs iOS ne permettent pas l'installation.
Bouton Partager → « Sur l'écran d'accueil ».

L'application s'ouvre alors sans barre d'adresse, avec sa propre icône, en
respectant les encoches et la zone de l'indicateur d'accueil.

### Fonctionnement hors connexion

Cette application pilote un refroidissement réel : le mode hors ligne est
volontairement **minimal**.

Ce qui fonctionne : l'interface démarre depuis le cache et affiche
immédiatement son état de liaison.

Ce qui ne fonctionne pas, délibérément :

- **aucune mesure n'est affichée** — sans serveur, il n'y a rien à superviser,
  et montrer des valeurs mémorisées serait trompeur ;
- **les commandes matérielles sont désactivées**, avec le motif affiché ;
- **aucune commande n'est mise en file d'attente**, aucune n'est rejouée au
  retour du réseau. Une action refusée doit être réémise volontairement.

Les données du serveur ne sont **jamais** mises en cache : une requête `/api/`
échoue franchement plutôt que de renvoyer une valeur périmée.

Les commandes sont également désactivées **en ligne** dès que plus aucune mesure
n'est reçue depuis 15 secondes — le cas où la liaison se croit ouverte mais ne
transmet plus rien.

### Mises à jour

Une nouvelle version n'est jamais appliquée d'office : un bandeau propose le
rechargement. Recharger l'interface n'a aucun effet sur la ventilation, qui est
pilotée par un processus serveur indépendant.

---

## Prérequis

**Obligatoire :**

- Ubuntu 22.04 ou plus récent (toute distribution avec `systemd` et `/sys` convient)
- Node.js **22 ou plus récent**, npm
  (version validée sur la machine de référence : Node.js 22.22.1)

```bash
sudo apt install nodejs npm
node -v      # doit afficher v22.x ou plus
```

Si les dépôts de la distribution fournissent une version antérieure à 22,
installer Node.js 22 depuis [NodeSource](https://github.com/nodesource/distributions).
Le script d'installation refuse de continuer avec une version antérieure à 22.

**Recommandé** — chaque outil absent dégrade une fonction sans empêcher le
démarrage ; l'interface indique alors ce qui est indisponible :

```bash
sudo apt install lm-sensors smartmontools nvme-cli pciutils
sudo sensors-detect        # détecte le contrôleur Super-IO de la carte mère
```

Le paquet Ubuntu s'appelle `lm-sensors`, mais la commande installée est
`sensors` (`/usr/bin/sensors`) : c'est elle que le script d'installation teste.

| Outil | Sans lui |
|---|---|
| `sensors` — paquet `lm-sensors` (module Super-IO) | pas de sorties PWM ni de RPM : supervision seule |
| `nvidia-smi` (pilote NVIDIA) | pas de température, charge ni consommation GPU |
| `nvme-cli` ou `smartctl` | pas d'état SMART ni de santé du SSD |
| `systemctl` | pas de détection des services système |
| `docker` | pas de détection des conteneurs (aucune erreur levée) |
| `ss` | corrélation des connexions dégradée (repli sur `/proc/net`) |

Pour la carte mère **MSI X299**, le contrôleur est généralement un Nuvoton
`nct6795`/`nct6797`. Si `sensors` ne le montre pas après `sensors-detect` :

```bash
sudo modprobe nct6775
echo nct6775 | sudo tee -a /etc/modules   # chargement au démarrage
```

---

## Installation

### Installation automatique

```bash
git clone https://github.com/Maxymou/PCIA-Control-Center.git
cd PCIA-Control-Center
sudo ./packaging/install.sh
```

Le script :

1. vérifie les prérequis (Node.js 22 minimum, npm, `sensors`, `nvidia-smi`,
   `smartctl`) et signale les outils manquants ;
2. crée l'utilisateur et le groupe système `pcia` (sans shell, sans répertoire
   personnel) ;
3. installe les dépendances de développement puis compile le front-end et le
   back-end ;
4. **réinstalle ensuite les seules dépendances de production** (`npm ci --omit=dev`) :
   Vite, Vitest, TypeScript, `tsx` et les plugins de build ne sont jamais copiés
   dans `/opt/pcia-control-center/node_modules` ;
5. installe dans `/opt/pcia-control-center`, en `root:root`, avec des
   permissions explicites (`u=rwX,go=rX`) indépendantes de l'umask du build :
   le compte `pcia` peut traverser et lire, rien ne lui est inscriptible ;
6. installe la configuration dans `/etc/pcia-control-center/config.yaml`
   (une configuration existante est **sauvegardée**, jamais écrasée) ;
7. crée `/var/lib/pcia-control-center` pour la base SQLite ;
8. installe la règle udev donnant au groupe `pcia` le droit d'écrire les
   fichiers `pwm*` — le service n'est **jamais exécuté en root** ;
9. installe et démarre les deux services systemd.

Le script ne modifie **pas** le pare-feu sans y être invité (`--open-firewall`),
n'active **pas** le contrôle PWM et ne lance **pas** de calibration.

#### Simulation (`--dry-run`)

```bash
sudo ./packaging/install.sh --dry-run
# ou, sans droits, sur un clone Git jamais compilé :
bash packaging/install.sh --dry-run --prefix /tmp/pcia-control-center-test
```

`--dry-run` affiche l'intégralité des étapes prévues et sort avec le code `0`,
y compris sur un clone neuf où `dist/`, `dist-server/` et `node_modules/`
n'existent pas encore. Rien n'est compilé, copié, supprimé ni modifié : aucun
utilisateur créé, aucune unité systemd installée, aucune règle udev déposée,
aucun service démarré, aucun contrôle PWM activé.

#### N'ajoutez aucun compte humain au groupe `pcia`

Le groupe `pcia` donne le droit d'écrire directement dans
`/sys/class/hwmon/*/pwm*`. Y ajouter un compte utilisateur permettrait de
piloter les ventilateurs **en dehors de toutes les sécurités applicatives** :
plancher des cartes passives, restitution au BIOS, détection de blocage,
consigne de secours en cas de perte de capteur. Ce groupe est réservé au compte
de service `pcia` utilisé par `pcia-fan-control.service`.

### Ouverture du port

Si UFW est actif :

```bash
sudo ufw allow 4321/tcp
```

### Installation manuelle

```bash
npm ci                        # dépendances de build incluses
npm run build                 # front-end (dist/) + back-end (dist-server/)
npm ci --omit=dev             # node_modules de production uniquement
sudo mkdir -p /etc/pcia-control-center /var/lib/pcia-control-center
sudo cp packaging/config.example.yaml /etc/pcia-control-center/config.yaml
sudo cp packaging/systemd/*.service /etc/systemd/system/
sudo cp packaging/udev/99-pcia-hwmon.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger --action=add --subsystem-match=hwmon
sudo systemctl daemon-reload
sudo systemctl enable --now pcia-fan-control pcia-control-center
```

### Lancement sans installation

```bash
npm install && npm run build
PCIA_MODE=demo PCIA_DB=./pcia.db PCIA_RUNTIME_DIR=./run npm run server
```

L'interface est alors disponible sur `http://localhost:4321/`.

---

## Modes d'exécution

| Mode | Comportement |
|---|---|
| `hardware` | mesures réelles uniquement. Ce qui n'est pas mesurable est absent, **jamais simulé**. |
| `demo` | tout est simulé et **annoncé comme tel** dans l'interface. Aucune écriture n'atteint le matériel. |
| `auto` (défaut) | `hardware` si `/sys/class/hwmon` est lisible, sinon `demo`. |

```bash
PCIA_MODE=hardware    # ou demo, ou auto
```

Le mode effectif est affiché dans l'en-tête de l'interface (« matériel »,
« démonstration » ou « simulé ») et renvoyé par `GET /api/health`.

**Mode démonstration** — utilisable sur n'importe quelle machine, sans
privilège : deux Tesla V100 simulées, GTX 1080 présente ou absente au choix,
cinq sorties de ventilation, services et connexions, et tous les scénarios du
panneau de démonstration (montée en température, ventilateur bloqué, arrêt de
service, perte de connexion, détection contradictoire…).

**Mode simulation navigateur** — si aucun back-end ne répond, le front-end
bascule seul sur son moteur de simulation local. L'en-tête affiche « simulé ».

---

## Configuration

Fichier : `/etc/pcia-control-center/config.yaml`
(modèle commenté : [`packaging/config.example.yaml`](packaging/config.example.yaml)).

Les variables d'environnement sont prioritaires :

| Variable | Effet |
|---|---|
| `PCIA_HOST` | adresse d'écoute (défaut `0.0.0.0`) |
| `PCIA_PORT` | port (défaut `4321`) |
| `PCIA_MODE` | `hardware`, `demo` ou `auto` |
| `PCIA_CONFIG` | chemin du fichier YAML |
| `PCIA_DB` | chemin de la base SQLite |
| `PCIA_RUNTIME_DIR` | répertoire runtime (socket, verrou, état) |
| `PCIA_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `PCIA_LOG_FORMAT` | `json` (journald) ou `text` |
| `PCIA_LAN_ONLY` | `false` pour lever la restriction réseau local |
| `PCIA_AUTH_MODE` | `none` ou `token` |
| `PCIA_TOKEN` | jeton des actions sensibles |
| `PCIA_REQUIRE_BIOS_RETURN` | `false` pour lever l'exigence de retour BIOS validé |

Emplacements respectant les conventions Linux :

```
/etc/pcia-control-center/     configuration
/var/lib/pcia-control-center/ base SQLite
/run/pcia-control-center/     socket, verrou, fichier d'état
journalctl                    journaux (aucun fichier de log propre)
```

### Un seul moteur de ventilation — `fan_control.embedded`

Le serveur web peut héberger un moteur de ventilation embarqué. En production
il ne doit **jamais** le faire : `pcia-fan-control.service` est l'unique moteur.

| Valeur | Usage |
|---|---|
| `never` | **configuration livrée** (`packaging/config.example.yaml`). Le serveur web ne construit aucun `FanHost` et pilote le daemon par IPC. Aucune course possible sur le verrou. |
| `auto` | **défaut logiciel du code**, pour le développement, le mode démonstration et une exécution mono-processus sans daemon. Le moteur embarqué ne démarre que si le verrou est libre. |
| `always` | déploiement mono-processus volontaire, sans systemd. Si le verrou est déjà détenu, le serveur reste en supervision seule. |

```yaml
fan_control:
  embedded: never      # production systemd
```

En production, le serveur web communique donc avec le daemon par IPC :

```
/run/pcia-control-center/fand.sock          socket de commande
/run/pcia-control-center/fan-engine.lock    verrou exclusif du moteur
/run/pcia-control-center/fand-state.json    état + heartbeat
```

Les deux unités déclarent `RuntimeDirectory=pcia-control-center` **et**
`RuntimeDirectoryPreserve=yes` : sans cette dernière directive, arrêter ou
redémarrer l'un des deux services supprimerait le répertoire encore utilisé par
l'autre, qui échouerait ensuite sur `EACCES: permission denied, mkdir
'/run/pcia-control-center'`. Le répertoire reste `pcia:pcia` en mode `0750`.

#### Mise à jour depuis une version antérieure

Le script d'installation **ne modifie jamais** une configuration existante : il
la sauvegarde et dépose le nouveau modèle en `config.example.yaml`. Après une
mise à jour, un `/etc/pcia-control-center/config.yaml` hérité contenant :

```yaml
fan_control:
  embedded: auto
```

doit être passé à `embedded: never` pour un déploiement systemd standard, sans
quoi le serveur web tenterait de démarrer un second moteur.

Si ces répertoires ne sont pas accessibles en écriture (exécution sans droits),
le back-end se replie sur `~/.local/state/pcia-control-center/` **et le signale**.

### Sécurité réseau

L'application est conçue pour un **réseau local**.

- `security.lan_only: true` (défaut) refuse les requêtes venant d'adresses non
  privées. L'application n'est jamais exposée publiquement par défaut.
- `security.auth_mode: token` exige un jeton (`Authorization: Bearer …` ou
  en-tête `X-PCIA-Token`) pour toutes les **actions sensibles** : calibration,
  écriture PWM, changement de profil, test à 100 %, retour BIOS, modification
  des seuils, actions sur les services, import de configuration.
- `security.allow_sensitive_actions: false` les désactive globalement
  (supervision en lecture seule).

Aucun secret n'est journalisé, ni inclus dans l'export de configuration ou le
rapport de diagnostic.

---

## Calibration des ventilateurs

> **Au premier démarrage, aucune sortie n'est pilotée par le logiciel.**
> Toutes restent sous contrôle du BIOS. C'est délibéré : rien ne permet de
> deviner quelle sortie PWM correspond à quel ventilateur physique.

### Pourquoi la calibration est indispensable

Le noyau expose `pwm1`, `pwm2`, `fan1_input`… sans indiquer :

- quel ventilateur physique répond à quelle sortie ;
- quelle entrée tachymétrique correspond à quelle sortie (`pwm1` ↔ `fan1_input`
  est une convention fréquente, **pas une garantie**) ;
- si le contrôleur rend la main au BIOS quand le logiciel se retire ;
- à quelle consigne minimale un ventilateur donné démarre et se maintient.

Ces quatre points ne s'obtiennent que par l'observation.

### Les six étapes

| Étape | Ce qu'elle fait | État atteint |
|---|---|---|
| 1. Détection | inventorie contrôleurs, sorties, capteurs. **Aucune prise de contrôle.** | `DETECTED` |
| 2. Identification | fait varier la consigne et observe **tous** les tachymètres du contrôleur ; l'utilisateur confirme quel ventilateur a réagi | `IDENTIFIED` |
| 3. Retour RPM | vérifie corrélation, plage plausible, stabilité, retour après changement | `RPM_CONFIRMED` |
| 4. Minimum | descend prudemment jusqu'à l'instabilité, remonte, ajoute une marge | — |
| 5. Contrôle logiciel | écriture acceptée, RPM cohérent, stabilité, absence de débordement sur une autre sortie, pas de surchauffe, reprise possible | `SOFTWARE_CONTROL_VALIDATED` |
| 6. Retour BIOS | repasse en mode matériel et **vérifie** que le système ne reste pas figé sur la dernière consigne logicielle | `BIOS_RETURN_VALIDATED` |

Puis `AUTHORIZED` : la sortie sera pilotée automatiquement aux démarrages suivants.

L'état initial (mode `pwm_enable`, consigne, RPM, température, horodatage) est
mémorisé **avant toute écriture**. Annulation et arrêt d'urgence le restaurent.
Toute étape est interrompue si la température dépasse `abort_temperature_c`.

### Résultats possibles

Retour RPM : `CONFIRMED`, `PROBABLE`, `NOT_AVAILABLE`, `INCONSISTENT`, `FAILED`
Retour BIOS : `CONFIRMED`, `PROBABLE`, `NOT_CONFIRMED`, `IMPOSSIBLE`, `UNKNOWN`

**Seul `CONFIRMED` autorise par défaut le contrôle automatique au démarrage.**
Une sortie sans tachymètre, ou dont le retour BIOS n'est pas confirmé, devient
`RESTRICTED` : utilisable manuellement, jamais reprise automatiquement.

### Revalidation automatique

À chaque démarrage, le moteur retrouve les sorties calibrées par leur
**empreinte stable** (pilote + bus + adresse + modalias), jamais par `hwmon4`.
La calibration est invalidée — et la sortie rendue au BIOS — si :

- la sortie PWM a disparu ;
- le contrôleur a été remplacé ;
- le retour tachymétrique a disparu ;
- la sortie n'est plus inscriptible ;
- la version du BIOS a changé ;
- la version du noyau a changé.

### Sorties par défaut

| Sortie | Attribution initiale | Capteur de référence |
|---|---|---|
| `CPU_FAN1` | CPU | température CPU |
| `SYS_FAN1` | boîtier avant | GPU le plus chaud |
| `SYS_FAN2` | boîtier arrière | température CPU |
| `SYS_FAN3` | PCIe 1 — Tesla V100 n°1 | Tesla V100 n°1 |
| `SYS_FAN4` | PCIe 2 — Tesla V100 n°2 | Tesla V100 n°2 |

Toutes configurables. Le matériel attribué et le capteur de référence sont deux
notions distinctes : `SYS_FAN1` peut souffler sur la façade tout en suivant la
température du GPU le plus chaud.

### Tesla V100 — cartes passives

Les Tesla V100 PCIe n'ont **pas de ventilateur intégré**. Elles dépendent
entièrement du flux d'air du boîtier. En conséquence :

- `SYS_FAN3` et `SYS_FAN4` ont un plancher de **35 %** que rien ne contourne —
  ni un profil, ni une consigne manuelle à 0 %, ni une courbe importée ;
- ce plancher est appliqué dans les quatre profils prédéfinis, y compris
  « Silencieux » ;
- la détection de minimum leur applique une marge de sécurité doublée.

---

## Sécurités

Politique **fail-safe** : en cas de doute, on ventile davantage.

| Situation | Réponse |
|---|---|
| Capteur de référence indisponible | vitesse de secours (défaut 80 %) + alerte |
| Capteur indisponible > 15 s | 100 % + alerte critique |
| Température de référence ≥ 90 °C | 100 % immédiat |
| Courbe invalide en base | dernière courbe valide conservée + événement |
| Configuration absente | contrôle laissé au BIOS |
| Sortie non calibrée | contrôle laissé au BIOS |
| Ventilateur bloqué | 100 % sur cette sortie + alerte critique |
| Échecs d'écriture PWM répétés | `FAILSAFE`, tentative de retour BIOS, alerte critique |
| Moteur injoignable | alerte critique dans l'interface ; systemd le redémarre |
| Arrêt normal | consigne sûre → restitution au BIOS → vérification |

### Détection de ventilateur bloqué

Un RPM nul ne déclenche jamais à lui seul une alerte. Les **trois** conditions
doivent être réunies simultanément :

1. consigne PWM supérieure au seuil (défaut 30 %) ;
2. RPM nul sur plusieurs lectures consécutives (défaut 3) ;
3. condition maintenue au-delà du délai (défaut 10 s).

La détection est automatiquement désactivée pour les sorties sans tachymètre.
Un ventilateur volontairement arrêté ne produit donc aucune alerte.

---

## API REST

Toutes les réponses d'erreur suivent la même forme :

```json
{ "error": "INVALID_CURVE", "message": "Courbe refusée.", "details": ["…"] }
```

### Système

```
GET  /api/health                    sonde de vie
GET  /api/system/status             mode, dégradation, capacités, moteur
GET  /api/system/capabilities       capacités seules
GET  /api/snapshot                  état complet (resynchronisation)
GET  /api/hardware                  composants
GET  /api/hardware/cpu
GET  /api/hardware/gpus             GPU + association emplacement ↔ UUID
GET  /api/hardware/storage
POST /api/hardware/refresh          redécouverte explicite
GET  /api/sensors                   capteurs, sorties PWM, associations
PUT  /api/sensors/mapping           force l'association d'un capteur
GET  /api/history?minutes=60
GET  /api/diagnostics               rapport complet, sans secret
```

### Services et connexions

```
GET    /api/services?includeHidden=true
GET    /api/services/:id
POST   /api/services/manual
PUT    /api/services/:id
DELETE /api/services/:id                     (services manuels uniquement)
POST   /api/services/:id/hide | /show

GET    /api/connections?includeLowConfidence=true
GET    /api/connections/:id
POST   /api/connections/manual
PUT    /api/connections/:id                  correction manuelle
DELETE /api/connections/:id                  (connexions manuelles uniquement)
POST   /api/connections/:id/hide | /show
POST   /api/connections/:id/restore-detected
POST   /api/connections/:id/resolve-conflict { "acceptDetection": true|false }
PUT    /api/connections/:id/note
```

Un service ou une connexion **détectés** ne se suppriment pas : ils se masquent.

### Ventilation

```
GET  /api/fans                      configurations, état live, calibration
GET  /api/fans/:id
PUT  /api/fans/:id/configuration    nom, matériel, capteur, minimum, seuils
PUT  /api/fans/:id/curve            validée puis appliquée immédiatement
PUT  /api/fans/:id/mode             auto | manual | full | test
POST /api/fans/:id/test             { "seconds": 30 }
POST /api/fans/:id/stop-test
POST /api/fans/:id/force-max
POST /api/fans/:id/clear-force-max
POST /api/fans/:id/return-to-bios
POST /api/fans/:id/take-software-control
```

### Profils

```
GET    /api/fan-profiles
POST   /api/fan-profiles
PUT    /api/fan-profiles/:id        sur un prédéfini : crée une copie personnalisée
DELETE /api/fan-profiles/:id        prédéfinis protégés
POST   /api/fan-profiles/:id/apply  { "fanId": "SYS_FAN3" } (facultatif)
POST   /api/fan-profiles/:id/duplicate
POST   /api/fan-profiles/:id/restore
```

### Calibration

```
GET  /api/calibration
POST /api/calibration/discover
POST /api/calibration/:fanId/start                    { "outputKey": "…" }
POST /api/calibration/:fanId/identify
POST /api/calibration/:fanId/confirm-identification
POST /api/calibration/:fanId/test-rpm
POST /api/calibration/:fanId/detect-minimum
POST /api/calibration/:fanId/test-software-control
POST /api/calibration/:fanId/test-bios-return
POST /api/calibration/:fanId/authorize
POST /api/calibration/:fanId/cancel
POST /api/calibration/:fanId/emergency-stop
POST /api/calibration/:fanId/reset
```

Les étapes longues répondent `202` et rendent la main immédiatement : la
progression est diffusée par WebSocket et lisible via `GET /api/calibration`.

### Alertes, événements, configuration

```
GET  /api/alerts?all=true
POST /api/alerts/:id/acknowledge | /snooze | /unsnooze
GET  /api/events?limit=200
POST /api/events
POST /api/history/markers
GET  /api/groups   |  PUT /api/groups
GET  /api/config   |  GET /api/config/ui   |  PUT /api/config/ui
GET  /api/config/export
POST /api/config/import
POST /api/config/reset          { "includeCalibration": false }
GET  /api/demo    |  POST /api/demo/:scenario   (mode démo uniquement)
```

Une alerte acquittée **reste active** tant que sa cause existe.

---

## WebSocket

```
ws://IP_PCIA:4321/ws/live
```

Chaque message est typé :

```json
{ "type": "snapshot", "timestamp": 1730000000000, "schema": 1, "payload": { … } }
```

Types : `snapshot`, `system.status`, `hardware.updated`, `sensor.updated`,
`gpu.updated`, `fan.updated`, `fan.mode_changed`, `fan.curve_changed`,
`service.updated`, `connection.updated`, `connection.conflict`, `alert.created`,
`alert.updated`, `alert.resolved`, `event.created`, `calibration.updated`,
`backend.health`, `fan_controller.health`, `pong`.

À la connexion, un `snapshot` complet est envoyé immédiatement : la reprise
après coupure ne demande aucune logique particulière. Le client se reconnecte
avec un délai exponentiel plafonné à 15 s et bascule entre-temps sur un
rafraîchissement REST périodique.

---

## Outil en ligne de commande

```bash
pcia-control-center status                 # état général et sorties
pcia-control-center discover               # contrôleurs, sorties, capteurs
pcia-control-center diagnostics [fichier]  # rapport JSON complet
pcia-control-center fans                   # détail par sortie
pcia-control-center return-to-bios [ID]    # restitution au BIOS
pcia-control-center export-config <f>
pcia-control-center import-config <f>
pcia-control-center reset-demo
```

Après installation :

```bash
node /opt/pcia-control-center/dist-server/server/src/cli.js status
```

`return-to-bios` agit sur le matériel. Elle n'est exécutée que si le moteur
répond, journalise systématiquement son résultat, et signale explicitement si la
restitution n'a pas pu être confirmée. Sans argument, elle traite les cinq
sorties.

---

## Développement

```bash
npm install

npm run dev            # front-end seul (port 5173, proxy /api et /ws vers 4321)
npm run server:dev     # back-end en rechargement à chaud
npm run build          # front-end + back-end
npm run typecheck
npm test
```

Sans back-end lancé, `npm run dev` bascule automatiquement sur la simulation
locale : le développement de l'interface reste possible seul.

Pour forcer une source de données :

```bash
VITE_PCIA_PROVIDER=mock npm run dev      # simulation locale imposée
VITE_PCIA_API=http://192.168.1.50:4321 npm run dev   # back-end distant
```

Le service worker n'est **pas** enregistré en développement : il masquerait le
rechargement à chaud. Pour l'éprouver, compiler puis servir avec le back-end :

```bash
npm run build
PCIA_MODE=demo PCIA_DB=./tmp.db PCIA_RUNTIME_DIR=./run npm run server
```

### Régénérer les icônes

```bash
node scripts/generate-icons.mjs
```

Rastérisation et encodage PNG en JavaScript pur : ni `sharp`, ni ImageMagick, ni
librsvg ne sont requis — le projet doit se construire sur un Ubuntu Server sans
environnement graphique. Les icônes produites sont commitées, la compilation du
front-end n'en dépend pas.

### Brancher une autre source de données

Tout passe par l'interface `DataService` (`src/services/types.ts`). Une
implémentation supplémentaire se substitue aux deux existantes sans modifier un
seul composant.

---

## Tests

```bash
npm test                         # les deux suites
npx vitest run --project server  # serveur seul
npx vitest run --project web     # interface seule
```

**347 tests** répartis en deux projets aux contraintes opposées.

### Serveur — 212 tests

Aucun n'accède au matériel réel : tout passe par un backend hwmon simulé qui
reproduit variation de RPM, panne de capteur, écriture refusée, retour BIOS,
changement d'index `hwmon`, disparition d'une sortie et remplacement d'un
contrôleur. Aucune calibration ni aucun contrôle PWM réel n'est exécuté, et la
suite ne laisse **aucun rejet de promesse non géré**.

Ils s'exécutent en environnement Node, dans un seul processus et sans
parallélisme : ils partagent des répertoires temporaires et des verrous de
moteur.

### Interface — 135 tests

En jsdom, parallélisables. `src/test/setup.ts` fournit ce que jsdom n'implémente
pas et dont la refonte dépend : `matchMedia` évaluant réellement les largeurs et
la nature du pointeur, un `visualViewport` pilotable, `ResizeObserver`, et des
utilitaires simulant l'ouverture du clavier, une rotation et une coupure réseau.

| Fichier | Couverture |
|---|---|
| `src/ui/viewport.test.ts` | hauteurs iOS : clavier, rotation, stabilisation |
| `src/ui/useConnectionState.test.tsx` | refus des commandes hors ligne et sur données périmées |
| `src/ui/overlays.test.tsx` | piège de focus, Échap, feuilles, confirmations |
| `src/ui/Measure.test.tsx` | provenance : réel, simulé, indisponible, absent |
| `src/ui/Navigation.test.tsx` | navigation responsive et noms accessibles |
| `src/ui/accessibility.test.tsx` | contrastes calculés, cibles tactiles, rôles |
| `src/features/hardware/CurveEditor.test.tsx` | clavier, saisie numérique, contraintes |
| `src/pwa/pwa.test.ts` | manifest, icônes, politique de cache du worker |
| `src/store/useConfigStore.test.ts` | disposition, services manuels, corrections |

| Fichier | Couverture |
|---|---|
| `curve.test.ts` | validation et interpolation (identique au front-end) |
| `safety.test.ts` | capteurs, températures, ventilateur bloqué, planchers |
| `hwmon.test.ts` | identité stable, scénarios de panne matérielle |
| `sensors.test.ts` | agrégation et association des capteurs |
| `engine.test.ts` | transitions d'état, failsafe, verrou, arrêt, redémarrage |
| `calibration.test.ts` | parcours complet, refus, restauration, arrêt d'urgence, arrêt pendant une calibration |
| `deployment.test.ts` | exclusivité du moteur, runtime partagé, verrou orphelin, configuration livrée, unités systemd |
| `repositories.test.ts` | migrations, corrections, conflits, historique |
| `api.test.ts` | routes REST, WebSocket, export/import, mode démo |

`deployment.test.ts` couvre en particulier la topologie systemd réelle :

- arrêt du serveur web pendant que le daemon reste actif ;
- redémarrages répétés du serveur sans destruction du runtime du daemon ;
- exclusivité entre moteur autonome et moteur embarqué ;
- absence de double moteur en production (`embedded: never`) ;
- reprise d'un verrou orphelin et détection d'un verrou vivant ;
- configuration livrée à `never`, défaut logiciel conservé à `auto` ;
- absence d'activation automatique du PWM ;
- priorité des variables d'environnement sur le fichier YAML ;
- `StartLimit*` en `[Unit]`, `RuntimeDirectoryPreserve=yes`, `AF_NETLINK`
  réservé au serveur web.

Vérification des unités systemd :

```bash
systemd-analyze verify \
  packaging/systemd/pcia-control-center.service \
  packaging/systemd/pcia-fan-control.service
```

---

## Documentation technique

| Document | Contenu |
|---|---|
| [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) | jetons, contrastes, cibles tactiles, règles d'ajout d'un composant |
| [docs/RESPONSIVE.md](docs/RESPONSIVE.md) | points de rupture, présentations mobiles, zones sûres, procédure de contrôle |
| [docs/PWA.md](docs/PWA.md) | stratégie de cache, comportement hors ligne, viewport iOS, installation |
| [docs/ROLLBACK.md](docs/ROLLBACK.md) | retour à la version précédente, purge du service worker |
| [docs/BASELINE.md](docs/BASELINE.md) | état de référence relevé avant la refonte |

---

## Limites connues

Ces limites sont **matérielles ou structurelles**. Elles sont documentées telles
quelles plutôt que masquées.

### Installation en PWA : HTTPS requis

Les navigateurs n'enregistrent un service worker — et ne proposent donc
l'installation ni le démarrage hors ligne — que dans un **contexte sécurisé** :
`localhost`, `127.0.0.1` ou HTTPS. Une adresse IP locale en HTTP simple, cas
habituel de `http://IP_PCIA:4321`, n'en est pas un.

Conséquence : depuis un téléphone du réseau local, l'interface est pleinement
utilisable et responsive, mais **ne peut pas être installée** telle quelle.

C'est une contrainte de la plateforme web, indépendante de l'application. Pour
la lever, placer un reverse proxy TLS devant le port 4321 — un certificat auto
signé ou une autorité locale suffit, à condition qu'il soit approuvé sur
l'appareil.

Vérification depuis la console du navigateur :

```js
window.isSecureContext   // doit valoir true
```

### Restitution au BIOS après un arrêt brutal

En cas d'arrêt propre (`systemctl stop`, `SIGTERM`, extinction), le moteur
applique une consigne sûre, remet le mode matériel et vérifie le résultat.

**En cas de crash brutal** (coupure d'alimentation, `SIGKILL`, panique noyau),
aucun logiciel ne peut restituer quoi que ce soit : le processus n'existe plus.
Le comportement dépend alors entièrement du contrôleur :

- la plupart des Super-IO conservent la dernière consigne écrite ;
- certains repassent seuls en mode automatique après un délai ;
- d'autres restent figés jusqu'au prochain démarrage.

Le moteur écrit systématiquement une consigne **suffisante** avant toute
descente, ce qui limite le risque, mais **la restitution après crash brutal
n'est pas garantie et ne peut pas l'être**. Un redémarrage rend toujours la main
au BIOS.

C'est précisément pourquoi `require_bios_return_validation` est actif par
défaut : une sortie dont le retour BIOS n'a pas été observé ne passe jamais
automatiquement sous contrôle logiciel.

### Corrélation PWM ↔ tachymètre

Rien dans `/sys` ne relie une sortie PWM à une entrée tachymétrique. L'index
identique n'est qu'un **candidat**, jamais une certitude — seule l'étape
d'identification de la calibration l'établit.

### Modes `pwm_enable`

Les valeurs acceptées ne sont pas énumérables via sysfs et varient selon le
pilote. Le back-end n'en suppose aucune : il relève le mode observé **avant**
toute prise de contrôle (c'est le mode « BIOS ») et sonde le mode manuel pendant
la calibration. Un pilote refusant le mode manuel rend la sortie inutilisable —
et le dit.

### Détection des connexions

- Sans privilège suffisant, les propriétaires de sockets appartenant à d'autres
  utilisateurs sont invisibles : les connexions correspondantes ne sont pas
  rattachées à un service. Le nombre de connexions non résolues est signalé.
- Une connexion déduite d'une variable d'environnement ou d'une déclaration
  `docker-compose` prouve une **configuration**, pas un trafic : elle est
  marquée `MEDIUM`.
- La co-appartenance à un réseau Docker ne prouve rien : `LOW`, masquée par
  défaut.

Chaque connexion porte sa méthode de détection et son niveau de confiance.
Aucune déduction n'est présentée comme certaine.

### Consommation

- CPU : lue via RAPL (`/sys/class/powercap`), absente sur certains matériels.
- GPU : `nvidia-smi`. Les Tesla V100 remontent bien `power.draw`.
- Alimentation globale : non mesurable sans matériel dédié — non affichée.

### Températures de boîtier

`case-front` et `case-rear` n'existent que si un capteur porte un libellé
explicite (`Front intake`, `Rear exhaust`…). Sinon, ces composants sont marqués
non installés et l'interface les masque, plutôt que d'afficher une valeur
arbitraire. Une association manuelle reste possible via
`PUT /api/sensors/mapping`.

### Interface

- Le graphe React Flow mesure ses nœuds via `ResizeObserver` ; dans certains
  navigateurs sans affichage (captures automatisées), les nœuds peuvent rester
  invisibles. Comportement propre à React Flow, présent avant l'ajout du
  back-end.
- Avertissement de taille de bundle au build (> 500 kB) : acceptable pour une
  application interne.

### À vérifier sur le PC IA réel

Les fonctions suivantes sont implémentées, testées sur matériel simulé, mais
n'ont pas pu être validées sur la machine cible :

- [ ] détection du Super-IO MSI X299 et présence des sorties `pwm1`…`pwm5` ;
- [ ] correspondance réelle entre sorties PWM et connecteurs de la carte mère
      (c'est l'objet de l'étape d'identification) ;
- [ ] acceptation du mode manuel (`pwm*_enable = 1`) par le pilote `nct6775` ;
- [ ] **retour effectif au BIOS** et absence de figeage sur la dernière consigne ;
- [ ] seuils de démarrage réels des ventilateurs installés ;
- [ ] efficacité du refroidissement des V100 aux consignes retenues ;
- [ ] lecture de la consommation CPU via RAPL sur le i9-10980XE ;
- [ ] permissions effectives de la règle udev après redémarrage.

Dérouler `pcia-control-center discover` puis la calibration sortie par sortie
répond à l'ensemble de ces points.

---

## Dépannage

**L'interface n'est pas accessible depuis le réseau**

```bash
systemctl status pcia-control-center
sudo ufw allow 4321/tcp
ss -tlnp | grep 4321          # doit écouter sur 0.0.0.0
```

Vérifier aussi `security.lan_only` : les adresses non privées sont refusées.

**Aucune sortie PWM détectée**

```bash
sensors                                  # le contrôleur apparaît-il ?
sudo sensors-detect
sudo modprobe nct6775
ls /sys/class/hwmon/hwmon*/pwm*
node /opt/pcia-control-center/dist-server/server/src/cli.js discover
```

**Sorties détectées mais « non inscriptibles »**

```bash
ls -l /sys/class/hwmon/hwmon*/pwm1        # groupe attendu : pcia
sudo udevadm control --reload-rules
sudo udevadm trigger --action=add --subsystem-match=hwmon
id pcia                                    # doit appartenir au groupe pcia
```

`--action=add` est indispensable : la règle `99-pcia-hwmon.rules` ne se
déclenche que sur `ACTION=="add"`. Sans cette option, `udevadm` émet un
événement « change » et rien n'est appliqué. La règle n'active **aucun**
contrôle PWM : elle ne fait qu'attribuer les fichiers `pwm*` au groupe `pcia`
et y ajouter le droit d'écriture.

**Le moteur de ventilation est signalé hors ligne**

```bash
systemctl status pcia-fan-control
journalctl -u pcia-fan-control -n 100 --no-pager
ls -l /run/pcia-control-center/            # fand.sock, fan-engine.lock
```

Si le verrou est détenu par un processus disparu, il est repris
automatiquement au démarrage suivant.

**`ERR_SYSTEM_ERROR: uv_interface_addresses returned Unknown system error 97`**

Le serveur web plante au démarrage. `os.networkInterfaces()`, appelé par
Fastify, interroge le noyau via **Netlink** sous Linux. Le durcissement de
l'unité doit donc autoriser cette famille d'adresses :

```ini
# pcia-control-center.service, section [Service]
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
```

Le daemon de ventilation, lui, n'énumère jamais les interfaces réseau :
`AF_NETLINK` ne lui est **pas** accordé (`RestrictAddressFamilies=AF_UNIX`).

**`EACCES: permission denied, mkdir '/run/pcia-control-center'`**

Le répertoire runtime est partagé par les deux services. Sans
`RuntimeDirectoryPreserve=yes`, arrêter ou redémarrer l'un supprime le
répertoire encore utilisé par l'autre. Les deux unités livrées déclarent :

```ini
RuntimeDirectory=pcia-control-center
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
```

Vérifier l'état attendu :

```bash
ls -ld /run/pcia-control-center            # drwxr-x--- pcia pcia
```

**Un service redémarre en boucle sans que systemd ne l'arrête**

`StartLimitIntervalSec` et `StartLimitBurst` appartiennent à la section
`[Unit]`. Placées dans `[Service]`, systemd les ignore :

```bash
systemd-analyze verify /etc/systemd/system/pcia-*.service
# ... Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.
```

**Les ventilateurs semblent figés après un arrêt**

```bash
sudo systemctl start pcia-fan-control
node /opt/pcia-control-center/dist-server/server/src/cli.js return-to-bios
```

Si la restitution n'est pas confirmée, redémarrer la machine : le BIOS reprend
systématiquement la main au démarrage.

**Les GPU ne remontent pas**

```bash
nvidia-smi
sudo -u pcia nvidia-smi        # accessible à l'utilisateur du service ?
```

**Repartir de zéro**

```bash
sudo systemctl stop pcia-control-center pcia-fan-control
sudo rm /var/lib/pcia-control-center/pcia.db*
sudo systemctl start pcia-fan-control pcia-control-center
```

La calibration est perdue : toutes les sorties repassent sous contrôle BIOS.

---

## Désinstallation

```bash
sudo ./packaging/uninstall.sh            # conserve configuration et données
sudo ./packaging/uninstall.sh --purge    # supprime après archivage dans /root
```

Le script restitue d'abord les sorties au BIOS, puis arrête les services.

### Restauration d'une configuration

```bash
node /opt/pcia-control-center/dist-server/server/src/cli.js import-config sauvegarde.json
sudo systemctl restart pcia-control-center pcia-fan-control
```

La **calibration n'est jamais importée** : elle décrit le matériel de la machine
d'origine et doit être refaite localement.

---

## Stack

React 18 · TypeScript · Vite · @xyflow/react · @dagrejs/dagre · Zustand · Recharts
Node.js 22+ (validé sur 22.22.1) · Fastify · better-sqlite3 · zod · ws · Vitest

Aucune dépendance d'exécution n'a été ajoutée par la refonte responsive et PWA :
le service worker, le manifest et les icônes sont produits par du code du dépôt.
Seules quatre dépendances de **développement** ont été ajoutées pour les tests
d'interface — `jsdom`, `@testing-library/react`, `@testing-library/user-event`
et `@testing-library/jest-dom` — toutes sous licence MIT. Elles ne sont jamais
déployées : l'installation réinstalle les dépendances de production seules
(`npm ci --omit=dev`).

L'application ne charge **aucune ressource distante** : ni police, ni script, ni
image. Elle reste utilisable sur un réseau local isolé, sans aucune télémétrie.
