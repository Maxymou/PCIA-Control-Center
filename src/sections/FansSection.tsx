/** Ventilation — profils, sorties, réglages, courbe et historique.
 *
 *  Sur poste de travail, la liste des sorties et le panneau de réglage sont
 *  affichés côte à côte. Sous 768 px la liste passe au-dessus du panneau : la
 *  sélection reste visible, et le réglage de la sortie choisie suit
 *  immédiatement, sans navigation supplémentaire.
 */

import { FanList } from '../features/hardware/FanList';
import { FanSettings } from '../features/hardware/FanSettings';
import { ProfilesBar } from '../features/hardware/ProfilesBar';
import { FanHistoryChart } from '../features/hardware/HistoryCharts';

export function FansSection() {
  return (
    <div className="section">
      <div className="section__inner">
        <ProfilesBar />
        <div className="fans-layout">
          <FanList />
          <FanSettings />
        </div>
        <FanHistoryChart />
      </div>
    </div>
  );
}
