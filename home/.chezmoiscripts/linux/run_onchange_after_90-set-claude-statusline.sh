#!/bin/sh
# statusline-command.js hash: {{ include (joinPath .chezmoi.sourceDir "dot_claude/statusline-command.js") | sha256sum }}

settings="$HOME/.claude/settings.json"
[ -f "$settings" ] || exit 0

tmp=$(mktemp)
jq --arg path "bun $HOME/.claude/statusline-command.js" '.statusLine = {"type": "command", "command": $path}' "$settings" > "$tmp" && mv "$tmp" "$settings"
