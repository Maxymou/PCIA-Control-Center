/** Matériel — inventaire des composants, schéma des associations, températures.
 *
 *  Sur poste de travail, l'inventaire et le schéma se partagent la largeur.
 *  Sous 1024 px ils s'empilent, l'inventaire d'abord : c'est lui qui porte
 *  l'information, le schéma sert à comprendre les attributions.
 */

import { HardwareSchema } from '../features/hardware/HardwareSchema';
import { HardwareInventory } from '../features/hardware/HardwareInventory';
import { TempHistoryChart } from '../features/hardware/HistoryCharts';

export function HardwareSection() {
  return (
    <div className="section">
      <div className="section__inner">
        <div className="hw-layout">
          <HardwareInventory />
          <HardwareSchema />
        </div>
        <TempHistoryChart />
      </div>
    </div>
  );
}
