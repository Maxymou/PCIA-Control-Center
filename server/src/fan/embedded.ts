/** Politique du moteur de ventilation embarqué dans le serveur web.
 *
 *  Un seul processus doit écrire les sorties PWM. Trois configurations :
 *
 *   - `never`  : **valeur de la configuration livrée**. En production systemd,
 *     `pcia-fan-control.service` est l'unique moteur ; le serveur web le pilote
 *     par IPC. Aucun `FanHost` n'est construit, donc aucune tentative
 *     d'acquisition du verrou : la course est impossible par construction.
 *   - `auto`   : **défaut logiciel**, utile en développement, en démonstration
 *     et pour une exécution mono-processus sans daemon. Le moteur embarqué ne
 *     démarre que si le verrou est libre.
 *   - `always` : déploiement mono-processus volontaire. Si le verrou est déjà
 *     détenu, le serveur reste en supervision seule plutôt que d'écrire à deux.
 */

import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { FanHost } from './host.js';

const log = createLogger('fan.embedded');

export type EmbeddedOutcome =
  /** `embedded: never` — aucun moteur embarqué n'est même envisagé. */
  | 'disabled'
  /** Verrou obtenu : le serveur web héberge le moteur. */
  | 'started'
  /** Un daemon détient le verrou : pilotage par IPC. */
  | 'external'
  /** `always` demandé mais verrou déjà détenu : supervision seule. */
  | 'blocked';

export interface EmbeddedFanEngine {
  host: FanHost | null;
  outcome: EmbeddedOutcome;
  /** PID du détenteur du verrou, quand il est connu. */
  heldBy: number | null;
}

/** Applique la politique `fan_control.embedded`.
 *
 *  `build` n'est appelé que si un moteur embarqué est envisageable : en
 *  `never`, aucun `FanHost` n'est instancié et le verrou n'est jamais touché.
 */
export function startEmbeddedFanHost(config: AppConfig, build: () => FanHost): EmbeddedFanEngine {
  if (config.fanControl.embedded === 'never') {
    log.info('Moteur embarqué désactivé (fan_control.embedded = never) — le daemon est l’unique moteur');
    return { host: null, outcome: 'disabled', heldBy: null };
  }

  const candidate = build();
  const started = candidate.start();
  if (started.started) {
    return { host: candidate, outcome: 'started', heldBy: started.heldBy };
  }

  if (config.fanControl.embedded === 'always') {
    log.error('Moteur embarqué imposé mais verrou déjà détenu — supervision seule', { pid: started.heldBy });
    return { host: null, outcome: 'blocked', heldBy: started.heldBy };
  }

  log.info('Moteur externe détecté : l’API se contente de le piloter', { pid: started.heldBy });
  return { host: null, outcome: 'external', heldBy: started.heldBy };
}
