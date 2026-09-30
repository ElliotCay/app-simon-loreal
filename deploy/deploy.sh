#!/bin/sh
# Déploie le dernier commit (HEAD) sur le VPS : sh deploy/deploy.sh [hôte-ssh]
# Seuls les fichiers suivis par git sont envoyés. Les réglages propres au serveur
# (PUBLIC_ORIGIN) vivent dans /etc/systemd/system/spy-rush.service.d/local.conf
# et ne sont jamais écrasés.
set -eu
HOST=${1:-spy-rush}
cd "$(dirname "$0")/.."
stamp=$(date +%Y%m%d-%H%M%S)

ssh "$HOST" "set -eu
test -f /etc/systemd/system/spy-rush.service.d/local.conf || { echo 'local.conf absent : PUBLIC_ORIGIN ne serait pas défini' >&2; exit 1; }
mkdir -p /root/backups && chmod 700 /root/backups
tar -czf /root/backups/spy-rush-$stamp.tgz -C /opt --exclude=.venv --exclude=__pycache__ spy-rush
python3 -c \"import sqlite3; s=sqlite3.connect('/var/lib/spy-rush/spy-rush.sqlite3'); d=sqlite3.connect('/root/backups/spy-rush-$stamp.sqlite3'); s.backup(d); d.close(); s.close()\""

git archive HEAD | ssh "$HOST" 'tar -x -C /opt/spy-rush'

ssh "$HOST" 'set -eu
cd /opt/spy-rush
.venv/bin/pip install -q -r requirements.txt
cp deploy/spy-rush.service /etc/systemd/system/spy-rush.service
systemctl daemon-reload
systemctl restart spy-rush
sleep 2
systemctl is-active spy-rush
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8000/'
echo "Déployé : $(git rev-parse --short HEAD) (sauvegarde /root/backups/spy-rush-$stamp.*)"
