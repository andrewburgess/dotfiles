#!/bin/bash
brew list --cask font-fira-code-nerd-font &>/dev/null || brew install --cask --force font-fira-code-nerd-font
brew list --cask font-victor-mono-nerd-font &>/dev/null || brew install --cask --force font-victor-mono-nerd-font

# Remove VictorMono italic variants
find ~/Library/Fonts /Library/Fonts -name "*VictorMono*Italic*" 2>/dev/null | while read -r f; do
    echo "Removing italic font: $f"
    rm -f "$f"
done
