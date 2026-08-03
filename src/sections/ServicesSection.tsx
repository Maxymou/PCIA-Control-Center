/** Services et connexions — le graphe interactif et ses présentations. */

import { ProgramsTab } from '../features/programs/ProgramsTab';

export function ServicesSection() {
  // Section sans défilement propre : le graphe occupe toute la hauteur restante
  // et gère lui-même son zoom et son déplacement.
  return (
    <div className="section section--flush">
      <ProgramsTab />
    </div>
  );
}
