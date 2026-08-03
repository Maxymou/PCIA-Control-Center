/** Sections de l'application.
 *
 *  Une seule déclaration alimente la navigation latérale, la navigation basse,
 *  les titres de page et le routage des alertes : ajouter une section ne demande
 *  de toucher à rien d'autre.
 */

export type SectionId =
  | 'overview'
  | 'hardware'
  | 'services'
  | 'fans'
  | 'alerts'
  | 'settings';

export interface SectionDefinition {
  id: SectionId;
  /** Libellé complet — titre de page et nom accessible. */
  label: string;
  /** Libellé de la navigation latérale, quand le libellé complet y serait
   *  tronqué. Le nom accessible reste toujours le libellé complet. */
  navLabel?: string;
  /** Libellé court pour la navigation basse (largeur d'un cinquième d'écran). */
  shortLabel: string;
  /** Pictogramme décoratif : jamais seul porteur de sens, toujours doublé du
   *  libellé, y compris quand la navigation latérale est réduite (le libellé
   *  passe alors en infobulle et en `aria-label`). */
  icon: string;
  /** Description annoncée par les technologies d'assistance. */
  description: string;
  /** Section affichée dans la navigation basse mobile (5 entrées maximum, la
   *  sixième reste atteignable depuis l'en-tête et la Vue d'ensemble). */
  inBottomNav: boolean;
}

export const SECTIONS: SectionDefinition[] = [
  {
    id: 'overview',
    label: 'Vue d’ensemble',
    shortLabel: 'Résumé',
    icon: '◉',
    description: 'État global du serveur, matériel, services critiques et alertes actives',
    inBottomNav: true,
  },
  {
    id: 'hardware',
    label: 'Matériel',
    shortLabel: 'Matériel',
    icon: '▤',
    description: 'CPU, mémoire, stockage, cartes graphiques, capteurs et températures',
    inBottomNav: true,
  },
  {
    id: 'services',
    label: 'Services et connexions',
    navLabel: 'Services',
    shortLabel: 'Services',
    icon: '⬡',
    description: 'Graphe des services détectés, conteneurs Docker et connexions',
    inBottomNav: true,
  },
  {
    id: 'fans',
    label: 'Ventilation',
    shortLabel: 'Ventil.',
    icon: '✳',
    description: 'Sorties PWM, courbes, profils, calibration et sécurités thermiques',
    inBottomNav: true,
  },
  {
    id: 'alerts',
    label: 'Alertes et événements',
    navLabel: 'Alertes',
    shortLabel: 'Alertes',
    icon: '⚠',
    description: 'Alertes actives, historique et journal des événements',
    inBottomNav: true,
  },
  {
    id: 'settings',
    label: 'Paramètres',
    shortLabel: 'Réglages',
    icon: '⚙',
    description: 'Préférences d’affichage, source de données, diagnostic et application installée',
    inBottomNav: false,
  },
];

export const SECTION_BY_ID: Record<SectionId, SectionDefinition> = Object.fromEntries(
  SECTIONS.map((section) => [section.id, section]),
) as Record<SectionId, SectionDefinition>;

export const BOTTOM_NAV_SECTIONS = SECTIONS.filter((section) => section.inBottomNav);
