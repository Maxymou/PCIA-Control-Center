# Migration vers la version responsive / PWA

Plan de bascule réversible pour une machine où PCIA Control Center est **déjà
installé et en service**. Rien n'est irréversible avant l'étape 7 ; l'étape 9
ramène l'installation précédente en quelques minutes.

À lire avant de commencer : la refonte responsive ne modifie **ni le moteur de
ventilation, ni la base SQLite, ni les migrations, ni les unités systemd, ni la
règle udev**. Le risque porte sur le front-end et le serveur web, pas sur la
ventilation. L'ajout de `fans.mapping` est facultatif et rétrocompatible : une
configuration sans cette section se comporte exactement comme avant.

Toutes les commandes ci-dessous sont à exécuter sur la machine PCIA.

---

## 0. Relever l'état de départ

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
echo "$STAMP" | tee /root/pcia-migration-stamp

# Version installée et état des services — à conserver.
systemctl status pcia-control-center pcia-fan-control --no-pager \
  > "/root/pcia-etat-avant-$STAMP.txt" 2>&1
node /opt/pcia-control-center/dist-server/server/src/cli.js status \
  >> "/root/pcia-etat-avant-$STAMP.txt" 2>&1
node /opt/pcia-control-center/dist-server/server/src/cli.js diagnostics \
  "/root/pcia-diagnostics-avant-$STAMP.json"

# Commit réellement déployé, s'il reste des sources.
git -C /opt/pcia-control-center-src rev-parse HEAD 2>/dev/null \
  | tee -a "/root/pcia-etat-avant-$STAMP.txt"
```

Notez les valeurs de PWM et de RPM affichées : elles serviront de référence à
l'étape 8.

## 1. Sauvegardes horodatées

```bash
STAMP=$(cat /root/pcia-migration-stamp)
BACKUP="/root/pcia-backup-$STAMP"
mkdir -p "$BACKUP"

# Build installé (c'est lui qui sera restauré en cas de retour arrière).
cp -a /opt/pcia-control-center "$BACKUP/opt-pcia-control-center"

# Sources, si elles existent sur la machine.
[ -d /opt/pcia-control-center-src ] && cp -a /opt/pcia-control-center-src "$BACKUP/src"

# Configuration.
cp -a /etc/pcia-control-center "$BACKUP/etc-pcia-control-center"

# Données persistantes — base SQLite arrêtée proprement (voir étape 2)
# ou copiée à chaud avec ses journaux WAL.
cp -a /var/lib/pcia-control-center "$BACKUP/var-lib-pcia-control-center"

# Unités systemd et règle udev.
mkdir -p "$BACKUP/systemd" "$BACKUP/udev"
cp -a /etc/systemd/system/pcia-*.service "$BACKUP/systemd/"
cp -a /etc/udev/rules.d/99-pcia-hwmon.rules "$BACKUP/udev/" 2>/dev/null

chmod -R go-rwx "$BACKUP"
du -sh "$BACKUP"
```

Sauvegarde applicative complémentaire, indépendante du format SQLite :

```bash
node /opt/pcia-control-center/dist-server/server/src/cli.js \
  export-config "$BACKUP/config-export.json"
```

## 2. Sauvegarde à froid de la base (recommandé)

Pour une copie parfaitement cohérente, arrêter **seulement le serveur web** —
le moteur de ventilation continue de tourner, les ventilateurs ne sont pas
touchés :

```bash
sudo systemctl stop pcia-control-center     # PAS pcia-fan-control
sqlite3 /var/lib/pcia-control-center/pcia.db ".backup '$BACKUP/pcia.db'"
sudo systemctl start pcia-control-center
```

Si `sqlite3` n'est pas installé, la copie de l'étape 1 suffit dès lors que les
fichiers `pcia.db-wal` et `pcia.db-shm` ont été copiés avec elle.

## 3. Préparer les nouvelles sources, à côté de l'installation active

Rien n'est encore remplacé : on construit dans un répertoire distinct.

```bash
STAMP=$(cat /root/pcia-migration-stamp)
sudo git clone https://github.com/Maxymou/PCIA-Control-Center.git \
  "/opt/pcia-control-center-src-$STAMP"
cd "/opt/pcia-control-center-src-$STAMP"
sudo git checkout claude/cool-hypatia-vjkes8
sudo npm ci
sudo npm run typecheck
sudo npm test
sudo npm run build
```

Ne pas poursuivre si un test échoue.

## 4. Vérifier l'installation en simulation

```bash
sudo bash packaging/install.sh --dry-run --prefix /opt/pcia-control-center
```

La simulation n'écrit rien. Relire la liste des opérations annoncées : elle doit
mentionner la sauvegarde automatique de `config.yaml`, et **aucune** suppression
de `/etc` ou de `/var/lib`.

## 5. Essai local, sans toucher aux services

Le nouveau serveur web est lancé à la main, sur un port libre, en mode lecture :
il ne démarre aucun moteur de ventilation embarqué (`embedded: never` reste
imposé par la configuration livrée) et n'écrit aucun PWM.

```bash
sudo -u pcia PCIA_PORT=4322 PCIA_CONFIG=/etc/pcia-control-center/config.yaml \
  node "/opt/pcia-control-center-src-$STAMP/dist-server/server/src/index.js"
```

Dans un autre terminal :

```bash
curl -s http://127.0.0.1:4322/api/health
curl -s http://127.0.0.1:4322/api/snapshot | head -c 400
```

Puis `Ctrl+C`. Le service en production n'a pas bougé pendant cet essai.

## 6. Attribution des ventilateurs — à ne pas oublier

`install.sh` **n'écrase jamais** un `config.yaml` existant. Le mappage livré
avec cette version arrive donc dans `/etc/pcia-control-center/config.example.yaml`
et **pas** dans la configuration active : il faut le recopier à la main.

```bash
bash "/opt/pcia-control-center-src-$STAMP/packaging/hwmon-report.sh" \
  > "/root/pcia-hwmon-$STAMP.txt"

# Reporter la section `fans:` du modèle dans la configuration active.
sudo diff -u /etc/pcia-control-center/config.yaml \
             /etc/pcia-control-center/config.example.yaml | head -80
sudoedit /etc/pcia-control-center/config.yaml
```

Vérifier ensuite que les six canaux sont bien résolus :

```bash
sudo -u pcia node /opt/pcia-control-center/dist-server/server/src/cli.js discover \
  | sed -n '/Mappage déclaré/,$p'
```

Sans cette section, le comportement reste celui des versions précédentes : les
liaisons ne viennent que de la calibration, et aucune sortie n'est associée tant
qu'elle n'a pas été calibrée.

### Le sens avant/arrière change

Les valeurs par défaut de `SYS_FAN1` et `SYS_FAN2` ont été corrigées d'après le
BIOS : `SYS_FAN1` est le ventilateur **arrière**, `SYS_FAN2` l'**avant**. Ces
libellés ne sont semés en base qu'à la **première** installation : sur une
machine déjà en service, la base conserve les anciennes valeurs inversées.

Après la bascule, corriger dans l'interface — section Ventilation, pour chacune
des deux sorties : nom affiché, matériel attribué (`case-rear` / `case-front`) et
capteur de référence (CPU pour l'arrière, GPU le plus chaud pour l'avant).

## 7. Bascule

C'est la première étape qui modifie l'installation active.

```bash
cd "/opt/pcia-control-center-src-$STAMP"
sudo bash packaging/install.sh --prefix /opt/pcia-control-center
```

Ce que le script fait : reconstruit, remplace `dist`, `dist-server`,
`node_modules` et `package.json` dans `/opt/pcia-control-center`, réinstalle les
unités systemd et la règle udev, **sauvegarde** `config.yaml` sans l'écraser,
puis redémarre les deux services.

Ce qu'il ne fait pas : il ne touche ni à la base, ni aux calibrations, ni aux
consignes PWM. Toutes les sorties reprennent dans l'état de contrôle enregistré.

L'ancien build reste disponible dans `$BACKUP/opt-pcia-control-center`.

## 8. Vérifications après bascule

```bash
systemctl status pcia-control-center pcia-fan-control --no-pager
journalctl -u pcia-fan-control -n 50 --no-pager

node /opt/pcia-control-center/dist-server/server/src/cli.js status
node /opt/pcia-control-center/dist-server/server/src/cli.js discover \
  | sed -n '/Mappage déclaré/,$p'
```

À contrôler, dans cet ordre :

1. **Températures** — les mêmes capteurs qu'avant la bascule sont lus, sans
   valeur manquante nouvelle.
2. **Vitesses** — les RPM correspondent à ceux relevés à l'étape 0. Une sortie
   affichée `indisponible` qui affichait une valeur avant est une régression :
   revenir en arrière (étape 9) et vérifier `fans.mapping`.
3. **États de contrôle** — chaque sortie a retrouvé son état antérieur
   (`BIOS_CONTROLLED` ou `SOFTWARE_CONTROLLED`), et aucune n'est en `FAILSAFE`.
4. **Interface, depuis un PC** — `http://IP_PCIA:4321/` : les six sections
   s'affichent, le bandeau de liaison est vert, les cinq sorties apparaissent
   avec leur nom de connecteur et le matériel attribué.
5. **Interface, depuis un téléphone** — même adresse, sur le réseau local. La
   navigation basse doit être atteignable au pouce, aucune barre horizontale ne
   doit apparaître, et l'installation en écran d'accueil doit être proposée
   (« Ajouter à l'écran d'accueil » sur iOS, bannière d'installation sur
   Android). Vérifier ensuite le mode hors ligne : couper le Wi-Fi, recharger,
   la page hors-ligne doit s'afficher — et **aucune mesure ne doit être
   présentée comme actuelle**.
6. **Services et connexions enregistrés** — la section correspondante liste les
   mêmes entrées qu'avant la bascule, avec leurs corrections manuelles.

Laisser tourner une heure et relire `journalctl -u pcia-fan-control` avant de
considérer la migration terminée.

## 9. Retour arrière complet

Le retour est un remplacement de répertoire ; ni la base ni la configuration
n'ont besoin d'être restaurées, elles n'ont pas changé de format.

```bash
STAMP=$(cat /root/pcia-migration-stamp)
BACKUP="/root/pcia-backup-$STAMP"

sudo systemctl stop pcia-control-center
sudo systemctl stop pcia-fan-control          # restitue les sorties au BIOS

sudo mv /opt/pcia-control-center "/opt/pcia-control-center-echec-$STAMP"
sudo cp -a "$BACKUP/opt-pcia-control-center" /opt/pcia-control-center

# Unités systemd et règle udev, si elles avaient changé.
sudo cp -a "$BACKUP/systemd/"*.service /etc/systemd/system/
sudo cp -a "$BACKUP/udev/99-pcia-hwmon.rules" /etc/udev/rules.d/ 2>/dev/null
sudo systemctl daemon-reload
sudo udevadm control --reload-rules
sudo udevadm trigger --action=add --subsystem-match=hwmon

sudo systemctl start pcia-fan-control
sudo systemctl start pcia-control-center
systemctl status pcia-control-center pcia-fan-control --no-pager
```

Restauration de la configuration ou des données, **uniquement si elles ont été
modifiées entre-temps** :

```bash
sudo cp -a "$BACKUP/etc-pcia-control-center/." /etc/pcia-control-center/
sudo systemctl stop pcia-control-center pcia-fan-control
sudo cp -a "$BACKUP/var-lib-pcia-control-center/." /var/lib/pcia-control-center/
sudo chown -R pcia:pcia /var/lib/pcia-control-center
sudo systemctl start pcia-fan-control pcia-control-center
```

### Côté navigateur

Le service worker de la version PWA survit à un retour arrière. Il est rendu
inoffensif par construction (`sw.js` servi en `no-cache`, navigation réseau
d'abord, aucune donnée d'API mise en cache), mais pour le purger immédiatement,
voir `docs/ROLLBACK.md`.

## 10. Nettoyage — une fois la migration confirmée

À ne faire qu'après plusieurs jours de fonctionnement nominal :

```bash
STAMP=$(cat /root/pcia-migration-stamp)
sudo rm -rf "/opt/pcia-control-center-echec-$STAMP"
# Conserver /root/pcia-backup-$STAMP tant qu'un retour arrière reste envisagé.
```
