# Attribution des sorties de ventilation au matériel réel

Ce document explique comment associer les cinq sorties logiques de PCIA Control
Center aux connecteurs physiques d'une carte mère, et comment le vérifier sans
risque.

| Sortie logique | Connecteur | Rôle |
|---|---|---|
| `CPU_FAN1` | CPU_FAN1 | ventilateur du processeur |
| `SYS_FAN1` | SYS_FAN1 | ventilateur de boîtier, avant |
| `SYS_FAN2` | SYS_FAN2 | ventilateur de boîtier, arrière |
| `SYS_FAN3` | SYS_FAN3 | refroidissement Tesla V100 n°1 |
| `SYS_FAN4` | SYS_FAN4 | refroidissement Tesla V100 n°2 |

## Pourquoi une attribution explicite est nécessaire

Trois hypothèses fausses, et coûteuses :

1. **« `hwmon4` désigne toujours le même contrôleur. »** Non. Le numéro est
   attribué dans l'ordre où les pilotes sont sondés au démarrage. L'ajout d'un
   NVMe, d'un GPU ou d'une mise à jour de noyau le décale.
2. **« `pwm1` correspond au connecteur CPU_FAN1. »** Pas nécessairement. L'ordre
   des sorties du pilote suit le registre du Super-I/O, pas la sérigraphie de la
   carte.
3. **« `pwm3` est mesuré par `fan3_input`. »** Fréquemment faux. Les cartes
   dotées de plus de tachymètres que de sorties PWM, ou d'un connecteur AIO
   dédié, décalent la numérotation.

Se tromper sur le point 3 est le plus grave : la détection de ventilateur bloqué
surveillerait la vitesse d'un **autre** ventilateur. Une sortie réellement
arrêtée passerait inaperçue, sur une carte passive qui n'a aucune ventilation
propre.

## 0. Prérequis : le noyau doit exposer un contrôleur de ventilation

Si `packaging/hwmon-report.sh` annonce **0 sortie PWM**, il n'y a rien à mapper :
le Super-I/O de la carte mère n'a pas de pilote chargé. `coretemp` et `nvme`
donnent des températures, jamais de PWM ni de RPM — ce sont des capteurs, pas
des contrôleurs de ventilation.

Sur les cartes MSI X299 (Super-I/O Nuvoton NCT679x), et plus généralement sur
beaucoup de cartes récentes, la cause est presque toujours la même : le BIOS
déclare les ports d'E/S du Super-I/O comme ressource ACPI, et le noyau refuse
alors de les céder au pilote.

### Diagnostic, sans rien charger

```bash
sudo modprobe -n -v nct6775            # simule : n'exécute rien
sudo sensors-detect --auto             # sonde les Super-I/O connus
sudo dmesg | grep -iE 'nct6775|it87|acpi.*resource'
```

Un message du type `ACPI: OSL: Resource conflict; ACPI support missing from
driver?` confirme le conflit ACPI.

### Chargement d'essai (réversible, sans redémarrage)

```bash
sudo modprobe nct6775                  # ou it87, selon sensors-detect
ls /sys/class/hwmon/hwmon*/name | xargs -I{} sh -c 'echo -n "{} : "; cat {}'
sensors
```

Si le module refuse de se charger pour cause de conflit ACPI :

```bash
sudo modprobe nct6775 acpi_enforce_resources=lax
```

Pour annuler l'essai : `sudo modprobe -r nct6775`.

Charger ce module **n'active aucun contrôle logiciel** : il ne fait qu'exposer
les registres du Super-I/O en lecture, et les sorties restent pilotées par le
BIOS. PCIA Control Center n'écrit un `pwm` qu'après une calibration explicite.

### Rendre le chargement permanent

À ne faire qu'une fois l'essai concluant :

```bash
echo nct6775 | sudo tee /etc/modules-load.d/pcia-hwmon.conf
```

Si l'option ACPI était nécessaire, elle doit être passée au noyau au démarrage —
c'est un paramètre global, à peser :

```bash
# /etc/default/grub : GRUB_CMDLINE_LINUX_DEFAULT="... acpi_enforce_resources=lax"
sudo update-grub && sudo reboot
```

`acpi_enforce_resources=lax` laisse un pilote accéder à des ports que l'ACPI
revendique. C'est la manœuvre habituelle pour lire les Super-I/O, mais elle
lève une protection du noyau : ne l'appliquez que si le chargement simple
échoue, et vérifiez ensuite la stabilité de la machine avant d'activer le
moindre contrôle PWM.

Après le chargement, reprendre au point 1 : le relevé montrera les `pwmN` et
les `fanN_input`, et le mappage devient possible.

## 1. Relever le matériel présent

En lecture seule, sur la machine concernée :

```bash
bash packaging/hwmon-report.sh > /tmp/releve-pcia.txt
# ou, si l'application est déjà installée :
node /opt/pcia-control-center/dist-server/server/src/cli.js discover
```

Aucune de ces deux commandes n'écrit dans `pwm*` ni dans `pwm*_enable`.

Le relevé donne, pour chaque contrôleur : son `name`, son device stable
(`/sys/devices/platform/nct6775.2592`), la liste des `pwmN` et celle des
`fanN_input` avec leur vitesse instantanée.

## 2. Déclarer l'attribution

Dans `/etc/pcia-control-center/config.yaml` :

```yaml
fans:
  mapping:
    CPU_FAN1:
      label: CPU_FAN1
      controller: { name: nct6798 }   # jamais « hwmon4 »
      pwm: 1                          # pwm1
      tach: 1                         # fan1_input
    SYS_FAN3:
      label: SYS_FAN3
      controller: { name: nct6798, address: nct6775.2592 }
      pwm: 4
      tach: 4
```

Un contrôleur peut être désigné par `name`, `driver`, `bus`, `address` ou `key`
(l'empreinte exacte affichée par `discover`). Tous les critères fournis doivent
correspondre. Les chemins explicites sont acceptés — `pwm_path`, `tach_path` —
et le segment `hwmonN` qu'ils contiennent est neutralisé à la résolution : seul
le device sous-jacent compte, ce qui les rend insensibles à une renumérotation.

`tach: null` déclare explicitement qu'une sortie n'a pas de retour
tachymétrique. Une sortie absente du mappage conserve le comportement des
versions précédentes : sa liaison vient uniquement de la calibration.

### Ce que le mappage ne fait pas

Il ne donne **aucune** autorisation de pilotage. Une sortie mappée reste sous
contrôle du BIOS tant que l'assistant de calibration n'a pas vérifié, sortie par
sortie, que l'écriture PWM agit et que la restitution au BIOS fonctionne. Le
mappage détermine ce que l'on **lit** ; la calibration détermine ce que l'on a le
droit d'**écrire**.

## 3. Vérifier l'attribution — procédure manuelle

Une correspondance déduite d'un numéro n'est pas une correspondance prouvée.
Tant qu'un ventilateur n'a pas été vu ou entendu varier, l'attribution reste une
hypothèse. Deux façons de la prouver.

### 3a. Par l'assistant de calibration (recommandé)

L'assistant fait exactement cela, et il le fait avec des garde-fous :
températures surveillées, interruption automatique au-delà du seuil, restitution
de l'état initial en cas d'arrêt. Interface → **Ventilation** → sortie →
*Calibrer*. L'étape « identification physique » fait alterner la sortie entre
deux paliers pendant quelques secondes ; il suffit d'observer quel ventilateur
change de régime.

C'est la seule procédure qui, en plus d'identifier la sortie, valide le retour au
BIOS et autorise le contrôle logiciel.

### 3b. Par observation, sans rien écrire

Utile pour un premier repérage, ou si l'on préfère ne rien piloter. Aucune
écriture n'est effectuée :

```bash
# Terminal 1 — suivre toutes les vitesses, une ligne par seconde.
watch -n1 'grep -H . /sys/class/hwmon/hwmon*/fan*_input'
```

Puis, ventilateur par ventilateur, **avec la machine sous surveillance** :

1. Repérer le connecteur à identifier sur la carte mère (sérigraphie).
2. Freiner brièvement le ventilateur correspondant — obstruer le flux d'air avec
   une feuille de papier rigide suffit ; ne jamais introduire de doigt ni d'objet
   dans les pales, et ne pas bloquer plus de deux ou trois secondes.
3. Noter quel `fanN_input` chute puis remonte : c'est le canal RPM de ce
   connecteur.

Ne faites **jamais** cela sur les ventilateurs des Tesla V100 (`SYS_FAN3`,
`SYS_FAN4`) pendant une charge GPU : ces cartes sont passives et n'ont aucune
ventilation propre. Attendez que les GPU soient au repos, et limitez
l'observation à quelques secondes.

Cette procédure identifie le **canal RPM** mais pas la sortie PWM : rien ne
prouve, sans écrire, quel `pwmN` commande ce ventilateur. Seule la calibration
(3a) établit ce lien.

### 3c. Vérifier ce que le programme a retenu

Après avoir édité la configuration :

```bash
node /opt/pcia-control-center/dist-server/server/src/cli.js discover | \
  sed -n '/Mappage déclaré/,$p'
```

Chaque sortie doit apparaître résolue, sans avertissement. Une entrée non
résolue est signalée mais n'est jamais fatale : la ventilation ne s'arrête pas à
cause d'un fichier de configuration.

## 4. Ce qui est affiché quand une mesure manque

| Situation | Affichage | Détection de blocage |
|---|---|---|
| Mesure réelle | `1240 RPM` | active |
| Mode démonstration | `~1240 RPM` / `1240 RPM (simulé)` | active sur données simulées |
| Aucun canal RPM, ou lecture illisible | `indisponible` | **désactivée** |
| Ventilateur réellement à l'arrêt | `0 RPM` | active — c'est un blocage |

Une mesure absente n'est jamais affichée `0 RPM`, et ne fait jamais monter la
consigne : l'absence de mesure n'est pas un blocage, c'est une absence
d'information. Inversement, un `0 RPM` affiché est toujours une mesure réelle.
