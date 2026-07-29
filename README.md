# PCIA Control Center

Interface de supervision (front-end uniquement) pour un PC dédié IA : services et connexions sous forme de graphe interactif, matériel, ventilation avec courbes éditables, profils, alertes et historiques.

**Toutes les données sont simulées** : aucun back-end n'est requis. L'application tourne entièrement dans le navigateur.

---

## Prérequis

- **Node.js 18+** (testé avec Node 22)
- npm

## Installation & lancement

```bash
npm install
npm run dev
```

Puis ouvrir l'URL affichée (par défaut `http://localhost:5173`).

### Build de production

```bash
npm run build     # génère dist/
npm run preview   # sert le build localement
```

---

## Aperçu fonctionnel

### Onglet « Programmes »
- Graphe interactif (React Flow) des services et connexions : déplacement, zoom, minimap.
- Ajout / modification / masquage / suppression de services et connexions manuels.
- Groupes : création, couleurs, notes, repli/dépli (nœud unique avec compteurs), déplacement groupé.
- Corrections manuelles **prioritaires** sur les détections automatiques, avec conservation de la détection d'origine (encart « Détection d'origine », bouton « Restaurer la version détectée »).
- Gestion des conflits détection ↔ correction : bannière avec **Conserver ma version / Accepter la détection / Comparer**.
- Disposition : organisation automatique (dagre, gauche → droite), mémoriser / restaurer / réinitialiser la disposition, recherche, filtres par état et type.
- Raccourcis : `Ctrl+Z` / `Ctrl+Y` (annuler/rétablir), `Suppr` (supprimer la sélection, avec confirmation), `F` (ajuster la vue), `Échap` (fermer / désélectionner).

### Onglet « Hardware & Ventilation »
- Cartes de synthèse (état global, CPU, GPU le plus chaud, NVMe, profil actif, alertes).
- Schéma du boîtier : ventilateurs et matériels cliquables, liaisons sortie → matériel refroidi, RPM en direct.
- Réglages par sortie ventilateur : mode **Auto (courbe) / Manuel / Test 30 s / Arrêté**, PWM minimum, seuil d'alerte RPM, matériel attribué, capteur de référence (capteur unique, GPU le plus chaud, max/moyenne d'une sélection).
- **Éditeur de courbe** température → PWM : 2 à 6 points, glisser-déposer, double-clic pour ajouter, saisie numérique, zones thermiques colorées, marqueur temps réel (temp/PWM/RPM). Application immédiate. Annulation locale, restauration de la courbe précédente ou de celle du profil, bouton « Forcer 100 % ».
- Profils : Silencieux, Équilibré, Performance, Refroidissement maximal (prédéfinis restaurables) + profils personnalisés (créer, dupliquer, renommer, supprimer). Toute modification manuelle d'une courbe bascule sur « Personnalisé ». Application globale ou par sortie.
- Historiques 60 min (pas de 10 s) : températures et ventilateurs (RPM / % PWM / les deux), légendes cliquables, repères d'événements (alertes, changements de profil).
- Journal d'événements filtrable (catégorie, niveau, recherche, période).

### Transverse
- En-tête : état machine, compteur d'alertes (tiroir avec acquittement / répétition 15 min / historique), horodatage de la dernière actualisation, état du back-end simulé.
- Alertes 4 niveaux (info / avertissement / critique / erreur), navigation directe vers l'élément concerné.
- **Panneau démo** (coin bas-droit) : déclencheurs de scénarios — montée en température V100, ventilateur bloqué, arrêt de service, perte de connexion, nouveau service détecté, présence/absence de la GTX 1080, erreur de sauvegarde, détection en conflit, retour à la normale, coupure du back-end simulé, réinitialisation complète.
- Persistance locale (`localStorage`, clé `pcia-config`) : dispositions, éléments manuels, corrections, masquages, courbes, profils, préférences.

---

## Architecture

```
src/
├── types/          # Modèles TypeScript (services, connexions, matériel, ventilateurs, alertes…)
├── mocks/
│   ├── seed.ts     # Données initiales simulées (services, connexions, matériel, courbes, profils)
│   └── engine.ts   # Moteur de simulation (tick 2 s, dérive des métriques, alertes, scénarios démo)
├── services/
│   └── dataService.ts   # ★ Contrat d'accès aux données (point de branchement back-end)
├── store/          # Zustand : données live, configuration persistée (undo/redo), état UI
├── features/
│   ├── programs/   # Graphe React Flow, panneau latéral, modales, barre d'outils
│   └── hardware/   # Schéma, réglages ventilateurs, éditeur de courbe, profils, historiques
├── components/     # En-tête, alertes, panneau démo, bannière de conflit, communs
├── utils/          # Courbes (interpolation), formatage, libellés FR
└── styles/         # Thème sombre (tokens CSS) + styles applicatifs
```

## Brancher un vrai back-end

L'UI ne parle **jamais** directement au moteur de simulation : tout passe par l'interface `DataService` définie dans `src/services/dataService.ts` (abonnement aux snapshots, actions sur les ventilateurs, résolution de conflits, journal…).

Pour connecter une vraie API :
1. Implémenter une nouvelle classe respectant l'interface `DataService` (HTTP/REST, WebSocket, SSE…).
2. La substituer à l'implémentation mock exportée en bas du fichier.
3. Supprimer (ou conserver pour le mode démo) le dossier `src/mocks/`.

Le format d'échange attendu est le type `Snapshot` (`src/types/index.ts`).

## Simplifications assumées

- Les groupes ne sont pas redimensionnables manuellement : leur cadre est calculé à partir de la position de leurs membres (avec marge). Léger décalage possible du cadre pendant le drag d'un membre, recalé au relâchement.
- Pas de multi-sélection dans le graphe.
- L'acquittement des alertes n'est pas persisté entre rechargements (cosmétique, données simulées).
- Pas de zoom horizontal sur les graphiques d'historique (fenêtre fixe de 60 min).
- Avertissement de taille de chunk au build (>500 kB) : acceptable pour une application interne ; un code-splitting par onglet est possible si nécessaire.

## Stack

React 18 · TypeScript · Vite · @xyflow/react (React Flow v12) · @dagrejs/dagre · Zustand (persist) · Recharts · SVG maison pour l'éditeur de courbe.
