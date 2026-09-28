#!/bin/bash
# Daily MySQL dump, run by launchd (installed by deploy.sh). Keeps 7 days in ~/mirattic-sync-backups.
# Lives outside ~/Documents when installed: launchd jobs can't read TCC-protected folders.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH
umask 077
dir=$HOME/mirattic-sync-backups
mkdir -p "$dir"
file=$dir/mirattic-$(date +%Y%m%d-%H%M).sql.gz
docker exec mirattic-sync-mysql-1 sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --no-tablespaces mirattic' \
  | gzip > "$file.tmp"
mv "$file.tmp" "$file"
find "$dir" -name 'mirattic-*.sql.gz' -mtime +6 -delete # 7 days old: gone within 8 days of a deletion (privacy policy)
echo "backup $file"
