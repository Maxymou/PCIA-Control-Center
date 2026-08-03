/** Ventilation — profils, sorties, sécurité, réglages, courbe et historique.
 *
 *  Sur poste de travail, la liste des sorties et le panneau de réglage sont
 *  affichés côte à côte. Sous 1024 px la liste passe au-dessus : la sélection
 *  reste visible et le réglage de la sortie choisie suit immédiatement, sans
 *  navigation supplémentaire.
 */

import { useConfigStore } from '../store/useConfigStore';
import { useUiStore } from '../store/useUiStore';
import { FanList } from '../features/hardware/FanList';
import { FanSettings } from '../features/hardware/FanSettings';
import { FanSafetyPanel } from '../features/hardware/FanSafetyPanel';
import { ProfilesBar } from '../features/hardware/ProfilesBar';
import { FanHistoryChart } from '../features/hardware/HistoryCharts';

export function FansSection() {
  const fanId = useUiStore((s) => s.selectedFanId);
  const fan = useConfigStore((s) => s.fanConfigs.find((f) => f.id === fanId));

  return (
    <div className="section">
      <div className="section__inner">
        <ProfilesBar />
        <div className="fans-layout">
          <div className="col" style={{ gap: 'var(--sp-4)' }}>
            <FanList />
            {/* L'état de sécurité de la sortie sélectionnée est affiché à côté de
                la liste, donc toujours visible pendant qu'on règle la courbe. */}
            {fan && <FanSafetyPanel fanId={fan.id} displayName={fan.displayName} />}
          </div>
          <FanSettings />
        </div>
        <FanHistoryChart />
      </div>
    </div>
  );
}
