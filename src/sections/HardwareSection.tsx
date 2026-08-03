/** Matériel — schéma des associations, détail d'un composant, températures. */

import { HardwareSchema } from '../features/hardware/HardwareSchema';
import { HardwareDetails } from '../features/hardware/FanList';
import { TempHistoryChart } from '../features/hardware/HistoryCharts';

export function HardwareSection() {
  return (
    <div className="section">
      <div className="section__inner">
        <div className="grid-2">
          <HardwareSchema />
          <HardwareDetails />
        </div>
        <TempHistoryChart />
      </div>
    </div>
  );
}
