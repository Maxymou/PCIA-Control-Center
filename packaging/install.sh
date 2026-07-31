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
#
# --dry-run n'écrit rien, ne compile rien, ne démarre rien. Il fonctionne sur un
# clone Git neuf (sans dist/, dist-server/ ni node_modules/) et sort avec 0.

set -euo pipefail

PREFIX="/opt/pcia-control-center"
CONFIG_DIR="/etc/pcia-control-center"
STATE_DIR="/var/lib/pcia-control-center"
SERVICE_USER="pcia"
SERVICE_GROUP="pcia"
OPEN_FIREWALL=0
DRY_RUN=0
PORT=4321
NODE_MIN_MAJOR=22

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

# Signale une exigence non satisfaite : bloquante en installation réelle,
# simplement annoncée en simulation (le dry-run doit rester exécutable sur un
# clone neuf, avant toute compilation).
require() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '   [simulation] prérequis à satisfaire : %s\n' "$*"
  else
    die "$*"
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

if [[ "$DRY_RUN" == "1" ]]; then
  log "MODE SIMULATION — aucune commande n'est exécutée, rien n'est modifié."
fi

# ---------------------------------------------------------------------
# 1. Vérifications préalables
# ---------------------------------------------------------------------
[[ "$DRY_RUN" == "1" || $EUID -eq 0 ]] || die "Ce script doit être lancé avec sudo."

log "Vérification des prérequis"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ]]; then
    echo "   Node.js $(node -v) (minimum requis : ${NODE_MIN_MAJOR}.x)"
  else
    require "Node.js ${NODE_MIN_MAJOR} minimum requis (détecté : $(node -v)). Voir https://github.com/nodesource/distributions"
  fi
else
  require "Node.js ${NODE_MIN_MAJOR}+ requis : voir https://github.com/nodesource/distributions"
fi

if command -v npm >/dev/null 2>&1; then
  echo "   npm $(npm -v)"
else
  require "npm requis : sudo apt install npm"
fi

# Le paquet Ubuntu s'appelle lm-sensors, mais le binaire installé est
# /usr/bin/sensors : c'est cette commande qu'il faut tester.
for tool in sensors nvidia-smi smartctl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      sensors)  warn "Commande absente : sensors (paquet lm-sensors) — températures carte mère indisponibles." ;;
      nvidia-smi) warn "Commande absente : nvidia-smi — mesures GPU NVIDIA indisponibles." ;;
      smartctl) warn "Commande absente : smartctl (paquet smartmontools) — santé des disques indisponible." ;;
    esac
  fi
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
if getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  echo "   groupe $SERVICE_GROUP déjà présent"
else
  run groupadd --system "$SERVICE_GROUP"
fi
run usermod -a -G "$SERVICE_GROUP" "$SERVICE_USER"
echo "   N'ajoutez AUCUN compte humain au groupe $SERVICE_GROUP : ce groupe donne"
echo "   un accès direct en écriture aux sorties PWM, hors des sécurités applicatives."

# ---------------------------------------------------------------------
# 3. Compilation puis dépendances de production uniquement
# ---------------------------------------------------------------------
# Ordre imposé : outils de build présents pour compiler, puis node_modules
# reconstruit sans les dépendances de développement. Vite, Vitest, TypeScript,
# tsx et les plugins de build ne sont donc jamais copiés dans $PREFIX.
HAS_LOCKFILE=0
[[ -f "$SOURCE_DIR/package-lock.json" ]] && HAS_LOCKFILE=1

log "Compilation du front-end et du back-end"
if [[ "$DRY_RUN" == "1" ]]; then
  if [[ "$HAS_LOCKFILE" == "1" ]]; then
    echo "   [simulation] npm ci                 (dépendances de build incluses)"
  else
    echo "   [simulation] npm install            (package-lock.json absent)"
  fi
  echo "   [simulation] npm run build          (front-end → dist/, back-end → dist-server/)"
  if [[ "$HAS_LOCKFILE" == "1" ]]; then
    echo "   [simulation] npm ci --omit=dev      (node_modules de production uniquement)"
  else
    echo "   [simulation] npm install --omit=dev (node_modules de production uniquement)"
  fi
else
  if [[ "$HAS_LOCKFILE" == "1" ]]; then
    ( cd "$SOURCE_DIR" && npm ci )
  else
    warn "package-lock.json absent : installation non reproductible (npm install)."
    ( cd "$SOURCE_DIR" && npm install )
  fi
  ( cd "$SOURCE_DIR" && npm run build )

  log "Réinstallation des dépendances de production uniquement"
  if [[ "$HAS_LOCKFILE" == "1" ]]; then
    ( cd "$SOURCE_DIR" && npm ci --omit=dev )
  else
    ( cd "$SOURCE_DIR" && npm install --omit=dev )
  fi
fi

# ---------------------------------------------------------------------
# 4. Installation des fichiers
# ---------------------------------------------------------------------
log "Installation dans $PREFIX"
run mkdir -p "$PREFIX"
for item in dist dist-server node_modules package.json; do
  if [[ ! -e "$SOURCE_DIR/$item" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "   [simulation] $item sera produit par l'étape de compilation, puis copié dans $PREFIX/"
      continue
    fi
    die "$item manquant — la compilation a échoué."
  fi
  run rm -rf "${PREFIX:?}/$item"
  run cp -r "$SOURCE_DIR/$item" "$PREFIX/"
done

# Permissions explicites, indépendantes de l'umask utilisé pendant le build :
#   - propriétaire root:root, rien n'appartient au compte de service ;
#   - répertoires traversables et fichiers lisibles par tous (donc par pcia) ;
#   - aucune écriture pour le groupe ni pour les autres ;
#   - le X majuscule ne pose le bit d'exécution que sur les répertoires et sur
#     les fichiers qui le portaient déjà (binaires natifs, scripts).
log "Permissions de $PREFIX (root:root, lecture seule pour $SERVICE_USER)"
run chown -R root:root "$PREFIX"
run chmod -R u=rwX,go=rX "$PREFIX"
run chmod 0755 "$PREFIX"

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
  echo "   Mise à jour depuis une ancienne version : si votre config.yaml contient"
  echo "     fan_control: { embedded: auto }"
  echo "   remplacez cette valeur par 'never' pour un déploiement systemd standard"
  echo "   (pcia-fan-control.service devient l'unique moteur de ventilation)."
else
  run cp "$SOURCE_DIR/packaging/config.example.yaml" "$CONFIG_DIR/config.yaml"
fi
run chown -R root:"$SERVICE_GROUP" "$CONFIG_DIR"
run chmod 0750 "$CONFIG_DIR"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "   [simulation] chmod 0640 $CONFIG_DIR/*.yaml"
else
  find "$CONFIG_DIR" -maxdepth 1 -type f -name '*.yaml*' -exec chmod 0640 {} +
fi

log "Répertoire de données $STATE_DIR"
run mkdir -p "$STATE_DIR"
run chown -R "$SERVICE_USER":"$SERVICE_GROUP" "$STATE_DIR"
run chmod 0750 "$STATE_DIR"

# ---------------------------------------------------------------------
# 6. Permissions matérielles (sans root)
# ---------------------------------------------------------------------
log "Règle udev pour l'accès aux sorties PWM"
run cp "$SOURCE_DIR/packaging/udev/99-pcia-hwmon.rules" /etc/udev/rules.d/
run udevadm control --reload-rules
# --action=add : la règle ne se déclenche que sur ACTION=="add". Sans cette
# option, udevadm envoie « change » et la règle n'est jamais appliquée.
run udevadm trigger --action=add --subsystem-match=hwmon
echo "   Le service n'est jamais exécuté en root : seul le groupe $SERVICE_GROUP"
echo "   obtient le droit d'écrire les fichiers pwm* des contrôleurs hwmon."
echo "   La règle n'active AUCUN contrôle PWM : elle ne fait qu'ajuster les droits."

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
if [[ "$DRY_RUN" == "1" ]]; then
  cat <<EOF

Simulation terminée — aucune modification n'a été appliquée.

Rien n'a été compilé, copié, supprimé ni démarré : ni utilisateur système,
ni unité systemd, ni règle udev, ni service. Aucun contrôle PWM n'a été activé.

Pour installer réellement :
  sudo $0${PREFIX:+ --prefix $PREFIX}
EOF
  exit 0
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

Installation terminée.

  Interface : http://${IP:-IP_PCIA}:$PORT/
  Services  : systemctl status pcia-control-center pcia-fan-control
  Journaux  : journalctl -u pcia-fan-control -f
  Outil CLI : node $PREFIX/dist-server/server/src/cli.js status

Moteur de ventilation : pcia-fan-control.service est l'unique moteur. La
configuration livrée fixe fan_control.embedded = never ; le serveur web le
pilote par IPC via /run/pcia-control-center/fand.sock.

IMPORTANT — le contrôle des ventilateurs n'est PAS actif.
Toutes les sorties restent pilotées par le BIOS. Pour activer le contrôle
logiciel, dérouler l'assistant de calibration sortie par sortie depuis
l'interface : c'est la seule façon d'associer une sortie PWM à un ventilateur
physique et de vérifier que la restitution au BIOS fonctionne.

Désinstallation : sudo $SOURCE_DIR/packaging/uninstall.sh
EOF
