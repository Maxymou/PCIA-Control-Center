/** État de sécurité d'une sortie de ventilation.
 *
 *  Le moteur publie, pour chaque sortie, qui la pilote réellement, où en est sa
 *  calibration, si son ventilateur est bloqué, depuis quand son capteur de
 *  référence est perdu et combien d'écritures ont échoué. Ces informations
 *  étaient présentes dans chaque instantané mais n'étaient affichées nulle part.
 *
 *  Ce panneau ne décide de rien : il montre ce que le moteur publie et propose
 *  les deux commandes existantes — restituer au BIOS, reprendre le contrôle
 *  logiciel — chacune derrière une confirmation qui en énonce les conséquences.
 *  Le front-end n'est pas une seconde source de vérité pour la sécurité.
 */

import { useState } from 'react';
import { useLiveStore } from '../../store/useLiveStore';
import { dataService } from '../../services/dataService';
import { StatusDot } from '../../components/Common';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Tooltip } from '../../ui/Tooltip';
import { useConnectionState } from '../../ui/useConnectionState';
import { fmtDateTime } from '../../utils/format';
import {
  BIOS_RETURN_LABELS, CALIBRATION_STATE_LABELS, CALIBRATION_STATE_SEVERITY,
  FAN_CONTROL_STATE_HELP, FAN_CONTROL_STATE_LABELS, FAN_CONTROL_STATE_SEVERITY,
  RPM_VALIDATION_LABELS,
} from '../../utils/labels';
import type { FanId, FanOutputState } from '../../types';

type PendingCommand = 'return-to-bios' | 'take-software-control' | null;

export function FanSafetyPanel({ fanId, displayName }: { fanId: FanId; displayName: string }) {
  const outputs = useLiveStore((s) => s.snap.fanOutputs);
  const records = useLiveStore((s) => s.snap.calibration);
  const engine = useLiveStore((s) => s.snap.system?.fanEngine);
  const capabilities = useLiveStore((s) => s.snap.system?.capabilities);
  const link = useConnectionState();
  const [pending, setPending] = useState<PendingCommand>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const commands = dataService.fanCommands;
  const output = outputs?.find((o) => o.id === fanId);
  const record = records?.find((r) => r.fanId === fanId);

  // Simulation navigateur : le back-end ne publie ni état de contrôle ni
  // calibration. On le dit, plutôt que d'inventer un état rassurant.
  if (!outputs) {
    return (
      <section className="card card-pad" aria-labelledby={`securite-${fanId}`}>
        <h3 className="card-title" id={`securite-${fanId}`}>Sécurité et contrôle</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Aucun back-end ne publie l’état réel des sorties : contrôle BIOS ou
          logiciel, calibration et détection de blocage sont indisponibles en
          simulation navigateur.
        </p>
      </section>
    );
  }

  if (!output) {
    return (
      <section className="card card-pad" aria-labelledby={`securite-${fanId}`}>
        <h3 className="card-title" id={`securite-${fanId}`}>Sécurité et contrôle</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Le moteur ne publie aucun état pour cette sortie.
        </p>
      </section>
    );
  }

  const blockedReason = !commands
    ? 'aucun back-end ne peut exécuter cette commande.'
    : !link.commandsEnabled
      ? (link.blockedReason ?? 'la liaison avec le back-end n’est pas fiable.')
      : engine && !engine.online
        ? 'le moteur de ventilation ne répond pas.'
        : null;

  const run = async (command: Exclude<PendingCommand, null>) => {
    if (!commands) return;
    setFeedback(null);
    if (command === 'return-to-bios') await commands.returnToBios(fanId);
    else await commands.takeSoftwareControl(fanId);
    // Le message n'est affiché qu'après résolution : jamais par anticipation.
    setPending(null);
    setFeedback(
      command === 'return-to-bios'
        ? 'Commande acceptée par le serveur. L’état réel de la sortie est celui affiché ci-dessus, publié par le moteur.'
        : 'Commande acceptée par le serveur. La reprise n’est effective que si le moteur la confirme ci-dessus.',
    );
  };

  return (
    <section className="card card-pad" aria-labelledby={`securite-${fanId}`}>
      <div className="spread">
        <h3 className="card-title" id={`securite-${fanId}`} style={{ margin: 0 }}>
          Sécurité et contrôle
        </h3>
        {engine && !engine.online && (
          <span className="badge critical">Moteur hors ligne</span>
        )}
      </div>

      <SafetyAlerts output={output} />

      <dl className="kv" style={{ marginTop: 'var(--sp-2)' }}>
        <dt>Pilotage</dt>
        <dd>
          <Tooltip content={FAN_CONTROL_STATE_HELP[output.controlState]}>
            <span className="row tooltip-trigger">
              <StatusDot sev={FAN_CONTROL_STATE_SEVERITY[output.controlState]} />
              {FAN_CONTROL_STATE_LABELS[output.controlState]}
            </span>
          </Tooltip>
        </dd>

        <dt>Calibration</dt>
        <dd>
          <span className="row">
            <StatusDot sev={CALIBRATION_STATE_SEVERITY[output.calibrationState]} />
            {CALIBRATION_STATE_LABELS[output.calibrationState]}
          </span>
        </dd>

        <dt>Consigne demandée</dt>
        <dd className="mono">
          {output.requestedPwm} %
          {output.requestedPwm !== output.pwm && (
            <span className="muted"> — appliquée : {output.pwm} %</span>
          )}
        </dd>

        <dt>Sortie PWM liée</dt>
        <dd className="mono">{output.boundOutputKey ?? 'aucune'}</dd>

        {record && (
          <>
            <dt>Retour tachymétrique</dt>
            <dd>{record.rpmValidation ? RPM_VALIDATION_LABELS[record.rpmValidation] : 'non évalué'}</dd>

            <dt>Retour BIOS</dt>
            <dd>{record.biosReturn ? BIOS_RETURN_LABELS[record.biosReturn] : 'non évalué'}</dd>

            <dt>Minimum retenu</dt>
            <dd className="mono">
              {record.minimumPwm !== null ? `${record.minimumPwm} %` : 'non déterminé'}
            </dd>

            {record.calibratedAt && (
              <>
                <dt>Calibrée le</dt>
                <dd className="mono">{fmtDateTime(record.calibratedAt)}</dd>
              </>
            )}

            {record.invalidatedReason && (
              <>
                <dt>Invalidée</dt>
                <dd className="sev-warning">{record.invalidatedReason}</dd>
              </>
            )}
          </>
        )}

        {output.writeFailures > 0 && (
          <>
            <dt>Écritures échouées</dt>
            <dd className="sev-critical mono">{output.writeFailures}</dd>
          </>
        )}
        {output.lastWriteError && (
          <>
            <dt>Dernière erreur</dt>
            <dd className="small sev-critical">{output.lastWriteError}</dd>
          </>
        )}
      </dl>

      <div className="divider" />

      <div className="row row-wrap">
        <button
          type="button"
          onClick={() => setPending('return-to-bios')}
          disabled={blockedReason !== null || capabilities?.canReturnToBios === false}
        >
          Restituer au BIOS
        </button>
        <button
          type="button"
          onClick={() => setPending('take-software-control')}
          disabled={blockedReason !== null || capabilities?.canWritePwm === false}
        >
          Reprendre le contrôle logiciel
        </button>
      </div>

      {blockedReason && (
        <p className="small muted" style={{ margin: 'var(--sp-2) 0 0' }} role="status">
          Commandes indisponibles : {blockedReason}
        </p>
      )}
      {feedback && (
        <p className="small" style={{ margin: 'var(--sp-2) 0 0' }} role="status">
          {feedback}
        </p>
      )}

      {pending === 'return-to-bios' && (
        <ConfirmDialog
          action="Restituer cette sortie au BIOS"
          target={`${displayName} (${fanId})`}
          consequences={[
            'Le moteur de ventilation cesse d’écrire la consigne de cette sortie.',
            'La carte mère reprend la régulation avec sa propre courbe, que le logiciel ne connaît pas.',
            'La courbe, le profil et le mode configurés ici ne s’appliquent plus à cette sortie.',
            'Le moteur vérifie que la restitution a bien eu lieu et signale explicitement si elle n’a pas pu être confirmée.',
          ]}
          reversible="Réversible : « Reprendre le contrôle logiciel » rend la main au moteur, à condition que la sortie soit calibrée et autorisée."
          confirmLabel="Restituer au BIOS"
          blockedReason={blockedReason}
          onConfirm={() => run('return-to-bios')}
          onCancel={() => setPending(null)}
        />
      )}

      {pending === 'take-software-control' && (
        <ConfirmDialog
          action="Reprendre le contrôle logiciel"
          target={`${displayName} (${fanId})`}
          consequences={[
            'Le moteur de ventilation écrit à nouveau la consigne de cette sortie.',
            'La régulation suit la courbe configurée et le capteur de référence choisi.',
            'La carte mère cesse de réguler cette sortie.',
            record?.biosReturn !== 'CONFIRMED'
              ? 'Le retour au BIOS n’est pas confirmé pour cette sortie : la restitution pourrait ne pas fonctionner ensuite.'
              : 'Le retour au BIOS a été validé : la restitution reste possible.',
          ]}
          reversible="Réversible : « Restituer au BIOS » rend la main à la carte mère."
          confirmLabel="Reprendre le contrôle"
          destructive={record?.biosReturn !== 'CONFIRMED'}
          blockedReason={blockedReason}
          onConfirm={() => run('take-software-control')}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}

/** Conditions de sécurité en cours sur la sortie — jamais repliées. */
function SafetyAlerts({ output }: { output: FanOutputState }) {
  const items: { level: 'warning' | 'critical'; text: string }[] = [];

  if (output.stalled) {
    items.push({
      level: 'critical',
      text: output.stalledSince
        ? `Ventilateur bloqué depuis ${fmtDateTime(output.stalledSince)} : une consigne est appliquée mais aucune rotation n’est mesurée. Le moteur force cette sortie à 100 %.`
        : 'Ventilateur bloqué : une consigne est appliquée mais aucune rotation n’est mesurée. Le moteur force cette sortie à 100 %.',
    });
  }
  if (output.sensorLostSince) {
    items.push({
      level: 'critical',
      text: `Capteur de référence perdu depuis ${fmtDateTime(output.sensorLostSince)} : le moteur applique sa consigne de secours.`,
    });
  }
  if (output.controlState === 'FAILSAFE') {
    items.push({
      level: 'critical',
      text: 'Sécurité active : les écritures ont échoué de façon répétée. Le moteur tente de rendre la main au BIOS.',
    });
  }
  if (output.calibrationState === 'RESTRICTED') {
    items.push({
      level: 'warning',
      text: 'Sortie restreinte : utilisable manuellement, mais jamais reprise automatiquement au démarrage. Retour tachymétrique ou retour BIOS non confirmé.',
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="col" style={{ marginTop: 'var(--sp-2)' }}>
      {items.map((item) => (
        <div key={item.text} className={`banner banner--${item.level}`} role="alert">
          <span aria-hidden="true">{item.level === 'critical' ? '⛔' : '⚠'}</span>
          <div className="banner__body">{item.text}</div>
        </div>
      ))}
    </div>
  );
}
