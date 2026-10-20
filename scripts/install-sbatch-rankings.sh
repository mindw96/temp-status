#!/usr/bin/env bash
# Run once with sudo on the Slurm controller. No tokens or Slurm settings change.
set -euo pipefail
if [[ "$(id -u)" != 0 ]]; then
  printf '%s\n' 'Run this installer with sudo on Server1.' >&2
  exit 1
fi
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_collector="$source_root/sbatch_rankings.py"
source_unit="$source_root/ops/nlp-status-sbatch-rankings.service"
for source_file in "$source_collector" "$source_unit"; do
  if [[ ! -f "$source_file" || -L "$source_file" ]]; then
    printf '%s\n' 'The reviewed collector source or service file is missing.' >&2
    exit 1
  fi
done
/usr/bin/python3 -c 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")' "$source_collector"
systemd-analyze verify "$source_unit"
for directory in /usr/local/lib/nlp-status-ranking /var/lib/nlp-status-ranking; do
  if [[ -L "$directory" ]]; then
    printf '%s\n' 'Refusing a symbolic-link installation directory.' >&2
    exit 1
  fi
  install -d -o root -g root -m 0755 "$directory"
done
destination_collector=/usr/local/lib/nlp-status-ranking/sbatch_rankings.py
destination_unit=/etc/systemd/system/nlp-status-sbatch-rankings.service
for destination in "$destination_collector" "$destination_unit"; do
  if [[ -L "$destination" ]]; then
    printf '%s\n' 'Refusing a symbolic-link installation target.' >&2
    exit 1
  fi
done
if [[ -e "$destination_collector" || -e "$destination_unit" ]]; then
  backup_dir="$(mktemp -d /var/lib/nlp-status-ranking/backup-XXXXXXXX)"
  chmod 0700 "$backup_dir"
  for destination in "$destination_collector" "$destination_unit"; do
    if [[ -f "$destination" ]]; then
      cp -p -- "$destination" "$backup_dir/"
    fi
  done
fi
install -o root -g root -m 0644 -- "$source_collector" "$destination_collector"
install -o root -g root -m 0644 -- "$source_unit" "$destination_unit"
systemctl daemon-reload
systemctl enable nlp-status-sbatch-rankings.service
systemctl restart nlp-status-sbatch-rankings.service
systemctl --no-pager --full status nlp-status-sbatch-rankings.service
printf '%s\n' 'Installed. Initial Slurm history indexing runs in the background; the dashboard updates after its first completed aggregate.'
