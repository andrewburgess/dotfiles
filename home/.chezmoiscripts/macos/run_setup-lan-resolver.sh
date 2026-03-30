#!/bin/bash

# macOS reads /etc/resolver/<domain> files to route DNS queries for specific domains
# to a designated nameserver instead of the system default.
gateway=$(route -n get default 2>/dev/null | awk '/gateway:/ {print $2}')
if [[ -z "$gateway" ]]; then
  echo "run_once_setup-lan-resolver: could not determine default gateway, skipping" >&2
  exit 1
fi

sudo mkdir -p /etc/resolver
printf 'nameserver %s\n' "$gateway" | sudo tee /etc/resolver/lan > /dev/null
