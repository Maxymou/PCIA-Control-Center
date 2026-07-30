#!/usr/bin/env bash
#
# Installation de PCIA Control Center sur Ubuntu.
#
# Ce script est volontairement prudent. Il NE FAIT PAS :
#   - de modification du BIOS ;
#   - d'activation du contrôle PWM (chaque sortie reste au BIOS) ;
#   - de calibration sans l'utilisateur ;
#   - d'écrasement d'une configuration existante sans sauvegarde ;
#   - d'ouverture du pare-feu sans le demander explicitement.
#
# Usage :
#   sudo ./packaging/install.sh [--prefix /opt/pcia-control-center] [--open-firewall] [--dry-run]

set -euo pipefail

PREFIX="/opt/pcia-control-center"
CONFIG_DIR="/etc/pcia-control-center"
STATE_DIR="/var/lib/pcia-control-center"
SERVICE_USER="pcia"
SERVICE_GROUP="pcia"
OPEN_FIREWALL=0
DRY_RUN=0
PORT=4321

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m/!\\\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '   [simulation] %s\n' "$*"
  else
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --open-firewall) OPEN_FIREWALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "Option inconnue : $1" ;;
  esac
done

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------
# 1. Vérifications préalables
# ---------------------------------------------------------------------
[[ "$DRY_RUN" == "1" || $EUID -eq 0 ]] || die "Ce script doit être lancé avec sudo."

log "Vérification des prérequis"
command -v node >/dev/null || die "Node.js 20+ requis : sudo apt install nodejs npm"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js 20 minimum requis (détecté : $(node -v))."
command -v npm >/dev/null || die "npm requis : sudo apt install npm"

for tool in lm-sensors nvidia-smi smartctl; do
  command -v "$tool" >/dev/null 2>&1 || warn "Outil absent : $tool — certaines mesures seront indisponibles."
done

# ---------------------------------------------------------------------
# 2. Utilisateur système dédié
# ---------------------------------------------------------------------
log "Utilisateur système $SERVICE_USER"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "   déjà présent"
else
  run useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
getent group "$SERVICE_GROUP" >/dev/null || run groupadd --system "$SERVICE_GROUP"
run usermod -a -G "$SERVICE_GROUP" "$SERVICE_USER"

# ---------------------------------------------------------------------
# 3. Compilation
# ---------------------------------------------------------------------
log "Compilation du front-end et du back-end"
if [[ "$DRY_RUN" != "1" ]]; then
  ( cd "$SOURCE_DIR" && npm ci --omit=dev >/dev/null 2>&1 || npm install )
  ( cd "$SOURCE_DIR" && npm install --include=dev >/dev/null )
  ( cd "$SOURCE_DIR" && npm run build )
fi

# ---------------------------------------------------------------------
# 4. Installation des fichiers
# ---------------------------------------------------------------------
log "Installation dans $PREFIX"
run mkdir -p "$PREFIX"
for item in dist dist-server node_modules package.json; do
  [[ -e "$SOURCE_DIR/$item" ]] || die "$item manquant — la compilation a échoué."
  run rm -rf "${PREFIX:?}/$item"
  run cp -r "$SOURCE_DIR/$item" "$PREFIX/"
done
run chown -R root:root "$PREFIX"

# ---------------------------------------------------------------------
# 5. Configuration (jamais écrasée sans sauvegarde)
# ---------------------------------------------------------------------
log "Configuration dans $CONFIG_DIR"
run mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG_DIR/config.yaml" ]]; then
  BACKUP="$CONFIG_DIR/config.yaml.bak.$(date +%Y%m%d%H%M%S)"
  warn "Configuration existante conservée. Sauvegarde : $BACKUP"
  run cp "$CONFIG_DIR/config.yaml" "$BACKUP"
  run cp "$SOURCE_DIR/packaging/config.example.yaml" "$CONFIG_DIR/config.example.yaml"
  echo "   Le nouveau modèle est disponible dans $CONFIG_DIR/config.example.yaml"
else
  run cp "$SOURCE_DIR/packaging/config.example.yaml" "$CONFIG_DIR/config.yaml"
fi
run chown -R root:"$SERVICE_GROUP" "$CONFIG_DIR"
run chmod 750 "$CONFIG_DIR"
run chmod 640 "$CONFIG_DIR"/*.yaml

log "Répertoire de données $STATE_DIR"
run mkdir -p "$STATE_DIR"
run chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$STATE_DIR"
run chmod 750 "$STATE_DIR"

# ---------------------------------------------------------------------
# 6. Permissions matérielles (sans root)
# ---------------------------------------------------------------------
log "Règle udev pour l'accès aux sorties PWM"
run cp "$SOURCE_DIR/packaging/udev/99-pcia-hwmon.rules" /etc/udev/rules.d/
run udevadm control --reload-rules
run udevadm trigger --subsystem-match=hwmon
echo "   Le service n'est jamais exécuté en root : seul le groupe $SERVICE_GROUP"
echo "   obtient le droit d'écrire les fichiers pwm* des contrôleurs hwmon."

# ---------------------------------------------------------------------
# 7. Services systemd
# ---------------------------------------------------------------------
log "Unités systemd"
run cp "$SOURCE_DIR/packaging/systemd/pcia-control-center.service" /etc/systemd/system/
run cp "$SOURCE_DIR/packaging/systemd/pcia-fan-control.service" /etc/systemd/system/
run systemctl daemon-reload
run systemctl enable --now pcia-fan-control.service
run systemctl enable --now pcia-control-center.service

# ---------------------------------------------------------------------
# 8. Pare-feu — jamais sans consentement
# ---------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [[ "$OPEN_FIREWALL" == "1" ]]; then
    log "Ouverture du port $PORT/tcp dans UFW (demandé explicitement)"
    run ufw allow "$PORT/tcp"
  else
    warn "UFW est actif et le port $PORT n'a pas été ouvert."
    echo "   Pour rendre l'interface accessible depuis le réseau local :"
    echo "     sudo ufw allow $PORT/tcp"
    echo "   (ou relancer ce script avec --open-firewall)"
  fi
fi

# ---------------------------------------------------------------------
# 9. Récapitulatif
# ---------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

Installation terminée.

  Interface : http://${IP:-IP_PCIA}:$PORT/
  Services  : systemctl status pcia-control-center pcia-fan-control
  Journaux  : journalctl -u pcia-fan-control -f
  Outil CLI : node $PREFIX/dist-server/server/src/cli.js status

IMPORTANT — le contrôle des ventilateurs n'est PAS actif.
Toutes les sorties restent pilotées par le BIOS. Pour activer le contrôle
logiciel, dérouler l'assistant de calibration sortie par sortie depuis
l'interface : c'est la seule façon d'associer une sortie PWM à un ventilateur
physique et de vérifier que la restitution au BIOS fonctionne.

Désinstallation : sudo $SOURCE_DIR/packaging/uninstall.sh
EOF
