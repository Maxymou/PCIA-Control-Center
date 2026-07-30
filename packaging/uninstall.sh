#!/usr/bin/env bash
#
# Désinstallation de PCIA Control Center.
#
# Les sorties de ventilation sont d'abord restituées au BIOS, puis les services
# sont arrêtés. La configuration et les données sont CONSERVÉES par défaut ;
# utiliser --purge pour les supprimer (une archive est créée au préalable).
#
# Usage : sudo ./packaging/uninstall.sh [--purge]

set -euo pipefail

PREFIX="/opt/pcia-control-center"
CONFIG_DIR="/etc/pcia-control-center"
STATE_DIR="/var/lib/pcia-control-center"
PURGE=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m/!\\\033[0m %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || { echo "Ce script doit être lancé avec sudo." >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
done

# 1. Restituer le matériel AVANT d'arrêter quoi que ce soit.
if systemctl is-active --quiet pcia-fan-control.service; then
  log "Restitution des sorties au BIOS"
  node "$PREFIX/dist-server/server/src/cli.js" return-to-bios || \
    warn "Restitution non confirmée — vérifier les vitesses de ventilation après l'arrêt."
fi

log "Arrêt des services"
systemctl disable --now pcia-control-center.service 2>/dev/null || true
# L'arrêt du moteur déclenche lui-même la séquence de restitution au BIOS.
systemctl disable --now pcia-fan-control.service 2>/dev/null || true

log "Suppression des unités systemd"
rm -f /etc/systemd/system/pcia-control-center.service
rm -f /etc/systemd/system/pcia-fan-control.service
systemctl daemon-reload

log "Suppression de la règle udev"
rm -f /etc/udev/rules.d/99-pcia-hwmon.rules
udevadm control --reload-rules || true

log "Suppression de $PREFIX"
rm -rf "$PREFIX"

if [[ "$PURGE" == "1" ]]; then
  ARCHIVE="/root/pcia-control-center-backup-$(date +%Y%m%d%H%M%S).tar.gz"
  log "Archivage de la configuration et des données dans $ARCHIVE"
  tar czf "$ARCHIVE" "$CONFIG_DIR" "$STATE_DIR" 2>/dev/null || warn "Archivage partiel."
  rm -rf "$CONFIG_DIR" "$STATE_DIR"
  userdel pcia 2>/dev/null || true
  groupdel pcia 2>/dev/null || true
  echo "Configuration et données supprimées. Sauvegarde : $ARCHIVE"
else
  echo "Configuration ($CONFIG_DIR) et données ($STATE_DIR) conservées."
  echo "Utiliser --purge pour les supprimer (une archive sera créée)."
fi

cat <<'EOF'

Désinstallation terminée.

Vérifier que les ventilateurs sont bien repassés sous contrôle BIOS :
  sensors
Si une vitesse semble figée, un redémarrage rend systématiquement la main au BIOS.
EOF
