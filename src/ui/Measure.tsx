/** Affichage d'une mesure, avec sa provenance.
 *
 *  Règle absolue de cette application : **on ne présente jamais une donnée
 *  inconnue ou simulée comme une mesure réelle**. Une valeur absente n'est pas
 *  un « 0 », et un capteur en panne n'est pas une valeur manquante.
 *
 *  Cinq provenances, visuellement distinctes et annoncées aux lecteurs d'écran :
 *
 *   `real`      mesure réelle du matériel ;
 *   `simulated` valeur produite par une simulation (mode démo ou navigateur) ;
 *   `missing`   la machine ne sait pas la mesurer (outil ou capacité absente) ;
 *   `absent`    le capteur n'existe pas sur ce matériel ;
 *   `error`     lecture tentée et échouée.
 *
 *  La distinction ne repose pas que sur la couleur : la valeur simulée est
 *  soulignée en pointillés, les valeurs indisponibles sont en italique, et un
 *  texte explicite accompagne chaque cas.
 */

import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import { useConnectionState } from './useConnectionState';
import { useLiveStore } from '../store/useLiveStore';
import type { BackendCapabilities } from '../types';

export type Provenance = 'real' | 'simulated' | 'missing' | 'absent' | 'error';

const PROVENANCE_TEXT: Record<Provenance, string> = {
  real: 'Mesure réelle',
  simulated: 'Valeur simulée — ne correspond à aucun matériel',
  missing: 'Mesure indisponible sur cette machine',
  absent: 'Aucun capteur pour cette grandeur',
  error: 'Échec de lecture du capteur',
};

/** Texte affiché à la place de la valeur quand il n'y en a pas. */
const PLACEHOLDER: Record<Exclude<Provenance, 'real' | 'simulated'>, string> = {
  missing: 'indisponible',
  absent: 'aucun capteur',
  error: 'erreur de lecture',
};

export interface MeasureProps {
  /** Valeur numérique, ou `null`/`undefined` si elle n'a pas pu être obtenue. */
  value: number | null | undefined;
  unit?: string;
  /** Nombre de décimales. */
  digits?: number;
  /** Provenance quand la valeur est présente. */
  provenance?: Provenance;
  /** Provenance à retenir quand la valeur est absente. */
  missingAs?: Exclude<Provenance, 'real' | 'simulated'>;
  /** Classe supplémentaire (gravité : `sev-warning`…). */
  className?: string;
  /** Explication complémentaire ajoutée à l'infobulle. */
  hint?: ReactNode;
}

export function Measure({
  value,
  unit,
  digits = 0,
  provenance = 'real',
  missingAs = 'missing',
  className = '',
  hint,
}: MeasureProps) {
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const effective: Provenance = hasValue ? provenance : missingAs;

  const body = hasValue ? (
    <>
      <span className="measure__value">{value.toFixed(digits)}</span>
      {unit && <span className="measure__unit">{unit}</span>}
    </>
  ) : (
    <span className="measure__value">{PLACEHOLDER[effective as keyof typeof PLACEHOLDER]}</span>
  );

  const explanation = (
    <>
      {PROVENANCE_TEXT[effective]}
      {hint && <> — {hint}</>}
    </>
  );

  return (
    <Tooltip content={explanation}>
      <span className={`measure measure--${effective} ${className}`.trim()}>
        {body}
        {/* Le lecteur d'écran entend la provenance sans avoir à ouvrir
            l'infobulle : la couleur et le soulignement ne suffisent pas. */}
        <span className="sr-only"> ({PROVENANCE_TEXT[effective]})</span>
      </span>
    </Tooltip>
  );
}

/** Provenance courante des mesures, déduite du mode d'exécution et des
 *  capacités annoncées par le back-end.
 *
 *  En mode démonstration ou en simulation navigateur, **toute** valeur est
 *  simulée : il n'y a pas de valeur réelle à distinguer. En mode matériel, une
 *  grandeur dont la capacité correspondante est absente (pas de `nvidia-smi`,
 *  pas de `lm-sensors`…) est déclarée indisponible plutôt qu'affichée comme un
 *  tiret ambigu. */
export function useProvenance(): {
  /** Provenance d'une valeur présente. */
  base: Provenance;
  /** Provenance à retenir pour une valeur absente, selon la capacité requise. */
  missingFor(capability?: keyof BackendCapabilities): Exclude<Provenance, 'real' | 'simulated'>;
} {
  const link = useConnectionState();
  const capabilities = useLiveStore((s) => s.snap.system?.capabilities);

  return {
    base: link.simulated ? 'simulated' : 'real',
    missingFor(capability) {
      // Deux causes bien distinctes, qu'un simple tiret confondait :
      //  - la machine ne sait pas mesurer cette grandeur du tout (outil absent,
      //    capacité désactivée) : « indisponible » ;
      //  - elle sait la mesurer en général, mais ce composant-ci n'expose aucun
      //    capteur : « aucun capteur ».
      // On ne déclare jamais « erreur de lecture » par déduction : seule une
      // erreur réellement remontée par le back-end le justifie.
      if (capability && capabilities && capabilities[capability] === false) return 'missing';
      return capabilities ? 'absent' : 'missing';
    },
  };
}

/** Badge de provenance, pour qualifier tout un bloc plutôt qu'une valeur. */
export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  if (provenance === 'real') return null;
  return (
    <span className={`badge ${provenance === 'simulated' ? 'simulated' : ''}`}>
      {provenance === 'simulated' ? 'Simulé' : PROVENANCE_TEXT[provenance]}
    </span>
  );
}
