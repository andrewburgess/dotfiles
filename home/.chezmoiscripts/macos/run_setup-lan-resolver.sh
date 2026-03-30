#!/bin/bash

# macOS reads /etc/resolver/<domain> files to route DNS queries for specific domains
# to a designated nameserver instead of the system default.
gateway=$(route -n get default 2>/dev/null | awk '/gateway:/ {print $2}')
if [[ -z "$gateway" ]]; then
  echo "run_once_setup-lan-resolver: could not determine default gateway, skipping" >&2
  exit 1
fi

current=$(cat /etc/resolver/lan 2>/dev/null)
expected="nameserver $gateway"
if [[ "$current" == "$expected" ]]; then
  exit 0
fi

echo "Updating /etc/resolver/lan to point .lan domains at $gateway (requires sudo)"
sudo mkdir -p /etc/resolver
printf '%s\n' "$expected" | sudo tee /etc/resolver/lan > /dev/null
