/** Assistant de calibration d'une sortie de ventilation.
 *
 *  Chaque bouton de cet écran déclenche une commande qui **atteint réellement le
 *  matériel** : variation de consigne, descente jusqu'à l'instabilité, prise de
 *  contrôle logiciel, restitution au BIOS. L'interface n'implémente aucune
 *  logique de calibration : elle appelle les routes existantes, affiche ce que
 *  le moteur publie, et n'anticipe jamais un résultat.
 *
 *  Trois garanties tenues ici :
 *   - aucune étape n'est présentée comme réussie avant que le moteur ne l'ait
 *     publiée dans son enregistrement de calibration ;
 *   - l'arrêt d'urgence est atteignable en permanence pendant une étape ;
 *   - toute étape agissant sur le matériel passe par une confirmation qui en
 *     énonce les conséquences.
 */

import { useCallback, useEffect, useState } from 'react';
import { dataService } from '../../services/dataService';
import { useLiveStore } from '../../store/useLiveStore';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Modal } from '../../ui/Modal';
import { useConnectionState } from '../../ui/useConnectionState';
import {
  BIOS_RETURN_LABELS, CALIBRATION_STATE_LABELS, CALIBRATION_STEP_LABELS,
  RPM_VALIDATION_LABELS,
} from '../../utils/labels';
import type {
  CalibrationOverview,
} from '../../services/dataService';
import type {
  CalibrationRecord, CalibrationSession, DiscoveredPwmOutput, FanId, HardwareId, HwmonDiscovery,
} from '../../types';

/** Description des six étapes, telles que le moteur les enchaîne. */
interface StepDefinition {
  id: string;
  title: string;
  /** Ce que l'étape fait réellement au matériel. */
  what: string;
  consequences: string[];
  /** État de calibration atteint lorsqu'elle réussit. */
  reaches?: CalibrationRecord['state'];
}

const STEPS: StepDefinition[] = [
  {
    id: 'start',
    title: '1. Détection',
    what: 'Inventorie les contrôleurs, les sorties PWM et les capteurs. Aucune prise de contrôle, aucune écriture.',
    consequences: ['Aucune écriture matérielle : cette étape ne fait que lire /sys.'],
    reaches: 'DETECTED',
  },
  {
    id: 'identify',
    title: '2. Identification physique',
    what: 'Fait varier la consigne de la sortie et observe tous les tachymètres du contrôleur, pour déterminer quel ventilateur y répond.',
    consequences: [
      'La consigne de cette sortie est modifiée pendant quelques dizaines de secondes.',
      'Le ventilateur concerné accélère puis ralentit de façon audible.',
      'L’état initial (mode, consigne) est mémorisé avant toute écriture et restauré en cas d’annulation.',
      'L’étape est interrompue automatiquement si la température dépasse le seuil d’abandon.',
    ],
    reaches: 'IDENTIFIED',
  },
  {
    id: 'test-rpm',
    title: '3. Retour tachymétrique',
    what: 'Vérifie la corrélation entre consigne et vitesse, la plage plausible, la stabilité et le retour après changement.',
    consequences: [
      'La consigne varie à nouveau pour mesurer la réponse du tachymètre.',
      'Seul le résultat « Confirmé » autorisera plus tard une reprise automatique au démarrage.',
    ],
    reaches: 'RPM_CONFIRMED',
  },
  {
    id: 'detect-minimum',
    title: '4. Minimum de fonctionnement',
    what: 'Descend prudemment jusqu’à l’instabilité, remonte, puis ajoute une marge de sécurité.',
    consequences: [
      'Le ventilateur peut ralentir fortement, voire s’arrêter brièvement, pendant la recherche.',
      'Les sorties des cartes passives reçoivent une marge de sécurité doublée.',
      'Le minimum retenu devient le plancher de cette sortie.',
    ],
  },
  {
    id: 'test-software-control',
    title: '5. Contrôle logiciel',
    what: 'Vérifie que l’écriture est acceptée, que la vitesse suit, qu’aucune autre sortie n’est affectée et qu’aucune surchauffe ne survient.',
    consequences: [
      'La sortie passe sous contrôle logiciel le temps du test.',
      'Une surchauffe ou un débordement sur une autre sortie interrompt immédiatement l’étape.',
    ],
    reaches: 'SOFTWARE_CONTROL_VALIDATED',
  },
  {
    id: 'test-bios-return',
    title: '6. Retour BIOS',
    what: 'Repasse la sortie en mode matériel et vérifie que le système ne reste pas figé sur la dernière consigne logicielle.',
    consequences: [
      'La sortie est rendue à la carte mère, puis observée.',
      'Si la restitution ne peut pas être confirmée, la sortie deviendra « restreinte » : utilisable manuellement, jamais reprise automatiquement.',
    ],
    reaches: 'BIOS_RETURN_VALIDATED',
  },
];

const ASSIGN_OPTIONS: { id: HardwareId | 'none' | 'custom'; label: string }[] = [
  { id: 'cpu', label: 'CPU' },
  { id: 'case-front', label: 'Boîtier avant' },
  { id: 'case-rear', label: 'Boîtier arrière' },
  { id: 'v100-1', label: 'Tesla V100 n°1' },
  { id: 'v100-2', label: 'Tesla V100 n°2' },
  { id: 'gtx1080', label: 'GTX 1080' },
  { id: 'nvme', label: 'SSD NVMe' },
  { id: 'none', label: 'Aucun' },
  { id: 'custom', label: 'Matériel personnalisé' },
];

export function CalibrationWizard({ fanId, displayName, onClose }: {
  fanId: FanId;
  displayName: string;
  onClose: () => void;
}) {
  const calibration = dataService.calibration;
  const link = useConnectionState();
  const engineOnline = useLiveStore((s) => s.snap.system?.fanEngine.online);

  const [overview, setOverview] = useState<CalibrationOverview | null>(null);
  const [discovery, setDiscovery] = useState<HwmonDiscovery | null>(null);
  const [outputKey, setOutputKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingStep, setPendingStep] = useState<StepDefinition | null>(null);
  const [confirmIdentification, setConfirmIdentification] = useState(false);
  const [busy, setBusy] = useState(false);

  const record = overview?.records.find((r) => r.fanId === fanId) ?? null;
  const session: CalibrationSession | null =
    overview?.sessions?.find((s) => s.fanId === fanId) ?? null;
  // Caractéristique matérielle de fan_configs, indépendante de tout état de
  // calibration : une sortie connue comme non contrôlable (ex. pwm relié à la
  // carte mère uniquement par le tachymètre) n'est jamais proposée à
  // l'autorisation, quel que soit `record.state`.
  const monitoringOnly = overview?.fanConfigs.find((c) => c.id === fanId)?.monitoringOnly ?? false;

  // L'identification physique doit être confirmée par un humain avant toute
  // étape agissant sur le matériel. `state` peut avoir progressé sans elle
  // (anciennes sessions, ou étapes lancées hors ordre) : c'est `assignedHardware`,
  // pas `state`, qui fait foi. `authorize()` refuse déjà sur ce même champ.
  const needsIdentification = record !== null
    && record.state !== 'NOT_CALIBRATED'
    && record.assignedHardware === null;
  // Cas anormal seulement : au-delà de DETECTED (juste après l'étape brute,
  // avant confirmation — situation normale), sans identité confirmée. N'arrive
  // qu'en rattrapant une session créée avant ce correctif, ou par une étape
  // lancée hors ordre.
  const hasInconsistentIdentification = needsIdentification && record?.state !== 'DETECTED';

  /** Recharge l'état publié par le moteur. C'est lui qui fait autorité. */
  const reload = useCallback(async () => {
    if (!calibration) return;
    try {
      setOverview(await calibration.load());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [calibration]);

  useEffect(() => {
    void reload();
    // Une étape longue répond 202 et progresse côté moteur : on interroge
    // périodiquement plutôt que de supposer qu'elle est terminée.
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [reload]);

  const blockedReason = !calibration
    ? 'aucun back-end ne peut exécuter de calibration ; elle est impossible en simulation navigateur.'
    : !link.commandsEnabled
      ? (link.blockedReason ?? 'la liaison avec le back-end n’est pas fiable.')
      : engineOnline === false || overview?.engineOnline === false
        ? 'le moteur de ventilation ne répond pas.'
        : null;

  const runStep = async (step: StepDefinition) => {
    if (!calibration) return;
    setBusy(true);
    setError(null);
    try {
      switch (step.id) {
        case 'start': await calibration.start(fanId, outputKey); break;
        case 'identify': await calibration.identify(fanId); break;
        case 'test-rpm': await calibration.testRpm(fanId); break;
        case 'detect-minimum': await calibration.detectMinimum(fanId); break;
        case 'test-software-control': await calibration.testSoftwareControl(fanId); break;
        case 'test-bios-return': await calibration.testBiosReturn(fanId); break;
      }
    } finally {
      setBusy(false);
      setPendingStep(null);
      await reload();
    }
  };

  /** Arrêt d'urgence : jamais derrière une confirmation — c'est le geste qu'on
   *  doit pouvoir faire sans réfléchir quand quelque chose tourne mal. */
  const emergencyStop = async () => {
    if (!calibration) return;
    setBusy(true);
    try {
      await calibration.emergencyStop(fanId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const runDiscovery = async () => {
    if (!calibration) return;
    setBusy(true);
    setError(null);
    try {
      const result = await calibration.discover();
      setDiscovery(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Calibration — ${displayName}`}
      description={`Sortie ${fanId}. Chaque étape agit sur le matériel réel.`}
      onClose={onClose}
      width={720}
      dismissOnBackdrop={false}
      footer={
        <>
          {session?.busy && (
            <button type="button" className="btn-danger-solid" onClick={() => void emergencyStop()}>
              Arrêt d’urgence
            </button>
          )}
          <button type="button" onClick={onClose}>Fermer</button>
        </>
      }
    >
      {blockedReason && (
        <div className="banner banner--warning" role="status">
          <span aria-hidden="true">⚠</span>
          <div className="banner__body">
            <p className="banner__title">Calibration indisponible</p>
            <p style={{ margin: 0 }}>{blockedReason}</p>
          </div>
        </div>
      )}

      <div className="banner banner--warning" style={{ marginTop: 'var(--sp-3)' }}>
        <span aria-hidden="true">⚠</span>
        <div className="banner__body">
          <p className="banner__title">Cette procédure pilote les ventilateurs</p>
          <p style={{ margin: 0 }}>
            L’état initial de la sortie (mode, consigne, vitesse, température) est
            mémorisé <b>avant toute écriture</b>. L’annulation et l’arrêt d’urgence
            le restaurent. Toute étape est interrompue si la température dépasse le
            seuil d’abandon configuré côté serveur.
          </p>
        </div>
      </div>

      <CurrentState record={record} session={session} />

      {error && <p className="field-error" role="alert">Erreur : {error}</p>}

      {/* ---- Étape 1 : choix de la sortie PWM ---- */}
      <section style={{ marginTop: 'var(--sp-4)' }}>
        <h3 className="card-title">Sortie PWM à calibrer</h3>
        <div className="row row-wrap">
          <button type="button" onClick={() => void runDiscovery()} disabled={busy || blockedReason !== null}>
            {busy ? 'Détection…' : 'Détecter les sorties'}
          </button>
          {discovery && (
            <label className="field" style={{ flex: 1, minWidth: 240 }}>
              Sortie détectée
              <select value={outputKey} onChange={(e) => setOutputKey(e.target.value)}>
                <option value="">Choisir…</option>
                {discovery.pwmOutputs.map((o: DiscoveredPwmOutput) => (
                  <option key={o.key} value={o.key}>
                    {o.label ?? `pwm${o.index}`} — {o.controller.driverName}
                    {o.writable ? '' : ' (non inscriptible)'}
                    {o.tachPath ? ` · tachymètre fan${o.tachIndex}` : ' · sans tachymètre'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {discovery && discovery.warnings.length > 0 && (
          <ul className="small muted" style={{ margin: 'var(--sp-2) 0 0', paddingLeft: '1.1rem' }}>
            {discovery.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        {discovery && discovery.pwmOutputs.length === 0 && (
          <p className="field-error" style={{ marginTop: 'var(--sp-2)' }}>
            Aucune sortie PWM détectée. Vérifier que le module Super-I/O est chargé
            (<code>lm-sensors</code>, <code>sensors-detect</code>).
          </p>
        )}
      </section>

      {hasInconsistentIdentification && (
        <div className="banner banner--warning" style={{ marginTop: 'var(--sp-3)' }}>
          <span aria-hidden="true">⚠</span>
          <div className="banner__body">
            <p className="banner__title">Identification physique non confirmée</p>
            <p style={{ margin: 0 }}>
              Cette calibration a progressé sans qu’un humain confirme quel
              ventilateur physique répond à cette sortie. Relancez l’étape
              « Identification physique » puis confirmez le matériel avant de
              poursuivre — le moteur refuse toute étape ultérieure tant que ce
              n’est pas fait.
            </p>
          </div>
        </div>
      )}

      {/* ---- Étapes ---- */}
      <ol className="calib-steps">
        {STEPS.map((step) => {
          // L'étape d'identification n'est « Atteinte » que si le matériel a
          // réellement été confirmé — pas seulement si `state` a progressé
          // au-delà par des étapes lancées hors ordre (voir needsIdentification).
          const done = step.reaches !== undefined && record !== null
            && reachedAtLeast(record.state, step.reaches)
            && (step.id !== 'identify' || record.assignedHardware !== null);
          const running = session?.busy && session.step === stepToEngineStep(step.id);
          const disabled = busy || blockedReason !== null
            || (step.id === 'start' && !outputKey)
            || (step.id !== 'start' && record === null)
            || (!['start', 'identify'].includes(step.id) && needsIdentification);

          return (
            <li key={step.id} className={`calib-step${done ? ' calib-step--done' : ''}`}>
              <div className="spread">
                <h4>{step.title}</h4>
                {done && <span className="badge normal">Atteinte</span>}
                {running && <span className="badge accent"><span className="spinner" /> En cours</span>}
              </div>
              <p className="small muted" style={{ margin: 'var(--sp-1) 0' }}>{step.what}</p>

              {running && session && (
                <>
                  <div className="progress" role="progressbar"
                    aria-valuenow={Math.round(session.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <div className="progress__fill" style={{ width: `${Math.round(session.progress * 100)}%` }} />
                  </div>
                  <p className="small" style={{ margin: 'var(--sp-1) 0 0' }} role="status">
                    {session.message}
                  </p>
                </>
              )}

              <button
                type="button"
                className="btn-sm"
                disabled={disabled || running}
                onClick={() => setPendingStep(step)}
              >
                {done ? 'Relancer cette étape' : 'Lancer cette étape'}
              </button>

              {/* L'identification demande une confirmation humaine : le moteur ne
                  peut pas savoir seul quel ventilateur physique a réagi.
                  Le bouton apparaît juste après l'étape brute (état DETECTED),
                  et reste disponible pour rattraper une session incohérente
                  (state avancé sans assignedHardware confirmé). */}
              {step.id === 'identify' && record !== null
                && (record.state === 'DETECTED' || needsIdentification) && (
                <button
                  type="button"
                  className="btn-sm btn-primary"
                  style={{ marginLeft: 'var(--sp-2)' }}
                  disabled={blockedReason !== null}
                  onClick={() => setConfirmIdentification(true)}
                >
                  Confirmer le ventilateur identifié
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {/* ---- Autorisation finale ---- */}
      <section style={{ marginTop: 'var(--sp-4)' }}>
        <h3 className="card-title">Autorisation</h3>
        {monitoringOnly ? (
          <div className="banner banner--warning" role="status">
            <span aria-hidden="true">⚠</span>
            <div className="banner__body">
              <p className="banner__title">Supervision tachymétrique uniquement — contrôle de vitesse indisponible</p>
              <p style={{ margin: 0 }}>
                Cette sortie est déclarée non contrôlable (constatation matérielle,
                voir les notes de calibration). Le RPM reste affiché et surveillé ;
                aucune autorisation ne sera jamais proposée pour elle.
              </p>
            </div>
          </div>
        ) : (
          <p className="small muted">
            Une sortie autorisée sera pilotée automatiquement aux démarrages suivants.
            Sans retour tachymétrique confirmé <b>et</b> retour BIOS confirmé, elle ne
            peut être qu’« restreinte » : utilisable manuellement, jamais reprise
            automatiquement.
          </p>
        )}
        <div className="row row-wrap">
          {!monitoringOnly && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || blockedReason !== null || record === null}
              onClick={() => void calibration?.authorize(fanId, false).then(reload).catch((e) => setError(e.message))}
            >
              Autoriser cette sortie
            </button>
          )}
          <button
            type="button"
            disabled={busy || blockedReason !== null || record === null}
            onClick={() => void calibration?.cancel(fanId).then(reload).catch((e) => setError(e.message))}
          >
            Annuler la calibration en cours
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || blockedReason !== null || record === null}
            onClick={() => void calibration?.reset(fanId).then(reload).catch((e) => setError(e.message))}
          >
            Réinitialiser la calibration
          </button>
        </div>
      </section>

      {pendingStep && (
        <ConfirmDialog
          action={`Lancer : ${pendingStep.title}`}
          target={`${displayName} (${fanId})`}
          consequences={pendingStep.consequences}
          reversible="L’état initial de la sortie est restauré par « Annuler la calibration » et par l’arrêt d’urgence."
          confirmLabel="Lancer l’étape"
          destructive={pendingStep.id !== 'start'}
          blockedReason={blockedReason}
          onConfirm={() => runStep(pendingStep)}
          onCancel={() => setPendingStep(null)}
        />
      )}

      {confirmIdentification && (
        <IdentificationDialog
          fanId={fanId}
          session={session}
          onClose={() => setConfirmIdentification(false)}
          onDone={reload}
        />
      )}
    </Modal>
  );
}

/** Rappel de l'état publié par le moteur — la seule source de vérité. */
function CurrentState({ record, session }: {
  record: CalibrationRecord | null;
  session: CalibrationSession | null;
}) {
  if (!record) {
    return (
      <p className="small muted" style={{ marginTop: 'var(--sp-3)' }}>
        Aucune calibration enregistrée pour cette sortie. Elle reste sous contrôle
        du BIOS tant que la procédure n’a pas abouti.
      </p>
    );
  }
  return (
    <dl className="kv" style={{ marginTop: 'var(--sp-3)' }}>
      <dt>État</dt><dd>{CALIBRATION_STATE_LABELS[record.state]}</dd>
      <dt>Retour RPM</dt>
      <dd>{record.rpmValidation ? RPM_VALIDATION_LABELS[record.rpmValidation] : 'non évalué'}</dd>
      <dt>Retour BIOS</dt>
      <dd>{record.biosReturn ? BIOS_RETURN_LABELS[record.biosReturn] : 'non évalué'}</dd>
      <dt>Minimum</dt>
      <dd className="mono">{record.minimumPwm !== null ? `${record.minimumPwm} %` : '—'}</dd>
      {session && (
        <>
          <dt>Étape en cours</dt>
          <dd>{CALIBRATION_STEP_LABELS[session.step]}{session.busy ? ' — en cours' : ''}</dd>
        </>
      )}
      {session?.lastError && (
        <><dt>Dernière erreur</dt><dd className="sev-critical small">{session.lastError}</dd></>
      )}
    </dl>
  );
}

/** Confirmation humaine de l'identification : quel ventilateur a réagi ? */
function IdentificationDialog({ fanId, session, onClose, onDone }: {
  fanId: FanId;
  session: CalibrationSession | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [hardware, setHardware] = useState<HardwareId | 'none' | 'custom'>('cpu');
  const [customLabel, setCustomLabel] = useState('');
  const [tachKey, setTachKey] = useState<string>('');
  const [inconclusive, setInconclusive] = useState(false);

  const observations = session?.lastObservations ?? [];
  // Le tachymètre dont la vitesse a le plus varié est le candidat le plus
  // probable — c'est une aide, jamais une décision prise à la place de l'humain.
  const best = observations.reduce<typeof observations[number] | undefined>(
    (b, o) => ((o.delta ?? 0) > (b?.delta ?? -1) ? o : b),
    undefined,
  );

  return (
    <ConfirmDialog
      action="Confirmer le ventilateur identifié"
      target={fanId}
      consequences={[
        'Le moteur associe définitivement cette sortie au matériel indiqué.',
        'Le tachymètre choisi servira à détecter un ventilateur bloqué.',
        inconclusive
          ? 'Sans identification concluante, la sortie restera restreinte : jamais reprise automatiquement au démarrage.'
          : 'La calibration pourra se poursuivre vers la validation du retour RPM.',
      ]}
      reversible="Réversible : « Réinitialiser la calibration » rend la sortie au BIOS et efface l’association."
      confirmLabel="Confirmer"
      onCancel={onClose}
      onConfirm={async () => {
        await dataService.calibration?.confirmIdentification(fanId, {
          assignedHardware: hardware,
          customLabel: hardware === 'custom' ? customLabel : undefined,
          tachKey: tachKey || null,
          inconclusive,
        });
        onClose();
        await onDone();
      }}
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Le moteur a fait varier la consigne. Indiquez quel ventilateur physique a
        réagi — cette information ne peut pas être devinée depuis <code>/sys</code>.
      </p>

      {observations.length > 0 && (
        <div className="table-scroll" style={{ marginBottom: 'var(--sp-3)' }}>
          <table className="data-table">
            <caption className="sr-only">Réaction observée sur chaque tachymètre</caption>
            <thead>
              <tr>
                <th scope="col">Tachymètre</th>
                <th scope="col">Vitesse basse</th>
                <th scope="col">Vitesse haute</th>
                <th scope="col">Écart</th>
              </tr>
            </thead>
            <tbody>
              {observations.map((o) => (
                <tr key={o.tachKey}>
                  <th scope="row" className="mono">
                    fan{o.tachIndex}
                    {best?.tachKey === o.tachKey && <span className="badge accent">plus forte réaction</span>}
                  </th>
                  <td className="mono">{o.rpmLow ?? '—'}</td>
                  <td className="mono">{o.rpmHigh ?? '—'}</td>
                  <td className="mono">{Math.round((o.delta ?? 0) * 100)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <label className="field">
        Matériel refroidi par ce ventilateur
        <select value={hardware} onChange={(e) => setHardware(e.target.value as HardwareId | 'none' | 'custom')}>
          {ASSIGN_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>

      {hardware === 'custom' && (
        <label className="field" style={{ marginTop: 'var(--sp-2)' }}>
          Libellé du matériel
          <input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="ex. Radiateur AIO" />
        </label>
      )}

      <label className="field" style={{ marginTop: 'var(--sp-2)' }}>
        Tachymètre associé
        <select value={tachKey} onChange={(e) => setTachKey(e.target.value)}>
          <option value="">Aucun tachymètre</option>
          {observations.map((o) => (
            <option key={o.tachKey} value={o.tachKey}>
              fan{o.tachIndex} — écart {Math.round((o.delta ?? 0) * 100)} %
            </option>
          ))}
        </select>
      </label>

      <label style={{ marginTop: 'var(--sp-3)' }}>
        <input type="checkbox" checked={inconclusive} onChange={(e) => setInconclusive(e.target.checked)} />
        Je n’ai pas pu déterminer quel ventilateur a réagi
      </label>
    </ConfirmDialog>
  );
}

/** Progression : un état atteint implique tous les précédents. */
const STATE_ORDER: CalibrationRecord['state'][] = [
  'NOT_CALIBRATED', 'DETECTED', 'IDENTIFIED', 'RPM_CONFIRMED',
  'SOFTWARE_CONTROL_VALIDATED', 'BIOS_RETURN_VALIDATED', 'AUTHORIZED',
];

function reachedAtLeast(current: CalibrationRecord['state'], target: CalibrationRecord['state']): boolean {
  const c = STATE_ORDER.indexOf(current);
  const t = STATE_ORDER.indexOf(target);
  // Les états hors progression (RESTRICTED, FAILED) ne valident aucune étape.
  return c >= 0 && t >= 0 && c >= t;
}

function stepToEngineStep(id: string): CalibrationSession['step'] {
  switch (id) {
    case 'identify': return 'identify';
    case 'test-rpm': return 'test-rpm';
    case 'detect-minimum': return 'detect-minimum';
    case 'test-software-control': return 'test-software-control';
    case 'test-bios-return': return 'test-bios-return';
    default: return 'idle';
  }
}
