#!/usr/bin/env bash
#
# Relevé des interfaces de ventilation réellement présentes sur la machine.
#
# LECTURE SEULE, SANS EXCEPTION.
#   - aucun fichier pwm* ni pwm*_enable n'est écrit ;
#   - aucun service n'est démarré, arrêté ni rechargé ;
#   - aucune calibration n'est lancée ;
#   - aucun module noyau n'est chargé ni déchargé ;
#   - rien n'est installé, copié ou supprimé.
#
# Ce script sert à remplir la section `fans.mapping` de
# /etc/pcia-control-center/config.yaml : il montre quels `pwmN` et quels
# `fanN_input` existent, sur quel contrôleur, et à quelle vitesse ils tournent
# à l'instant du relevé.
#
# Usage :
#   bash packaging/hwmon-report.sh                 # affichage
#   bash packaging/hwmon-report.sh > releve.txt    # pour transmission
#
# Il n'a pas besoin de sudo. Certaines valeurs (DMI, sensors) sont simplement
# absentes si les droits manquent — le reste du relevé reste exploitable.

set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }
val() { [[ -r "$1" ]] && tr -d '\n' < "$1" || printf '(illisible)'; }

printf 'Relevé PCIA — %s\n' "$(date -Is)"
printf 'Machine : %s · noyau %s\n' "$(hostname 2>/dev/null)" "$(uname -r)"

section "Carte mère (DMI)"
for f in board_vendor board_name bios_version bios_date; do
  printf '  %-14s %s\n' "$f" "$(val /sys/class/dmi/id/$f)"
done

section "Contrôleurs hwmon"
if [[ ! -d /sys/class/hwmon ]]; then
  echo "  /sys/class/hwmon absent : aucun contrôleur exposé par le noyau."
else
  for h in /sys/class/hwmon/hwmon*; do
    [[ -e "$h" ]] || continue
    real="$(readlink -f "$h")"
    # Le device parent est l'identifiant STABLE. Le numéro hwmonN, lui, change
    # d'un démarrage à l'autre : il ne doit jamais servir d'identifiant.
    dev="$(readlink -f "$h/device" 2>/dev/null || echo '(aucun)')"
    printf '\n  %s\n' "$(basename "$h")"
    printf '    name        : %s\n' "$(val "$h/name")"
    printf '    chemin réel : %s\n' "$real"
    printf '    device      : %s\n' "$dev"
    if [[ -e "$h/device/driver" ]]; then
      printf '    pilote      : %s\n' "$(basename "$(readlink -f "$h/device/driver")")"
    fi
    if [[ -r "$h/device/uevent" ]]; then
      printf '    modalias    : %s\n' "$(grep -m1 '^MODALIAS=' "$h/device/uevent" 2>/dev/null | cut -d= -f2-)"
    fi
    # --- valeurs à reporter dans fans.mapping ---
    for p in "$h"/pwm[0-9]*; do
      [[ -e "$p" ]] || continue
      case "$(basename "$p")" in
        pwm[0-9]) ;;
        *) continue ;;
      esac
      n="$(basename "$p" | tr -dc '0-9')"
      perms="$(stat -c '%A %U:%G' "$p" 2>/dev/null)"
      printf '    pwm%-2s      : brut=%s enable=%s  [%s]\n' \
        "$n" "$(val "$p")" "$(val "$h/pwm${n}_enable")" "$perms"
    done
    for f in "$h"/fan[0-9]*_input; do
      [[ -e "$f" ]] || continue
      n="$(basename "$f" | tr -dc '0-9')"
      label="$(val "$h/fan${n}_label" 2>/dev/null)"
      printf '    fan%-2s      : %s RPM%s\n' "$n" "$(val "$f")" \
        "$([[ -r "$h/fan${n}_label" ]] && printf ' (label %s)' "$label")"
    done
  done
fi

section "Bilan : contrôleur de ventilation présent ?"
# Le seul point qui compte pour PCIA : existe-t-il au moins un `pwmN` ?
# Sans lui, il n'y a ni contrôle de ventilation, ni lecture de vitesse — et
# aucun mappage n'est possible, faute de matériel exposé par le noyau.
pwm_count=0
fan_count=0
for h in /sys/class/hwmon/hwmon*; do
  [[ -e "$h" ]] || continue
  for p in "$h"/pwm[0-9]; do [[ -e "$p" ]] && pwm_count=$((pwm_count + 1)); done
  for f in "$h"/fan[0-9]_input; do [[ -e "$f" ]] && fan_count=$((fan_count + 1)); done
done
printf '  sorties PWM (pwmN)        : %d\n' "$pwm_count"
printf '  canaux tachymétriques     : %d\n' "$fan_count"

if [[ "$pwm_count" -eq 0 ]]; then
  cat <<'EOF'

  AUCUNE SORTIE PWM N'EST EXPOSÉE PAR LE NOYAU.

  Les ventilateurs sont donc pilotés exclusivement par le BIOS, et aucune
  vitesse n'est mesurable. Ce n'est pas un défaut de PCIA Control Center :
  le contrôleur Super-I/O de la carte mère n'a pas de pilote chargé.

  Cause habituelle : le module hwmon du Super-I/O n'est pas chargé, souvent
  parce que le BIOS réserve ses ports d'E/S via ACPI et que le noyau refuse
  alors de les prendre.

  Diagnostic complémentaire (lecture seule) :
    sudo modprobe -n -v nct6775          # simule le chargement, n'exécute rien
    sudo dmesg | grep -iE 'nct6775|acpi.*resource|it87'
    sudo sensors-detect --auto           # sonde les Super-I/O connus
EOF
fi

section "Modules noyau de supervision chargés"
if [[ -r /proc/modules ]]; then
  grep -E '^(nct[0-9]+|it87|f71882fg|w83[0-9a-z]+|k10temp|coretemp|asus[a-z_]*|dell_smm|applesmc|hwmon)' \
    /proc/modules | awk '{printf "  %-20s\n", $1}' || echo "  (aucun module hwmon reconnu)"
else
  echo "  /proc/modules illisible"
fi

section "sensors (lm-sensors)"
if command -v sensors >/dev/null 2>&1; then
  sensors 2>&1
else
  echo "  commande 'sensors' absente (paquet lm-sensors non installé)"
fi

section "sensors -u (valeurs brutes)"
if command -v sensors >/dev/null 2>&1; then
  sensors -u 2>&1
else
  echo "  (indisponible)"
fi

section "Correspondance connecteurs physiques"
cat <<'EOF'
  Les cinq connecteurs à renseigner :
    CPU_FAN1  ventilateur CPU
    SYS_FAN1  boîtier avant
    SYS_FAN2  boîtier arrière
    SYS_FAN3  refroidissement Tesla V100 n°1
    SYS_FAN4  refroidissement Tesla V100 n°2

  ATTENTION — l'ordre des `pwmN` du pilote ne correspond PAS forcément à
  l'ordre sérigraphié sur la carte mère, et `pwmN` n'est pas forcément associé
  à `fanN_input`. Une correspondance ne peut être considérée comme prouvée que
  si elle a été vérifiée par observation (voir docs/FAN-MAPPING.md).
EOF

printf '\nRelevé terminé. Aucun fichier n’a été modifié.\n'
