#!/bin/sh
# statusline-command.sh hash: {{ include (joinPath .chezmoi.sourceDir "dot_claude/statusline-command.sh") | sha256sum }}

settings="$HOME/.claude/settings.json"
[ -f "$settings" ] || exit 0

tmp=$(mktemp)
jq --arg path "$HOME/.claude/statusline-command.sh" '.statusLine = {"type": "command", "command": $path}' "$settings" > "$tmp" && mv "$tmp" "$settings"
