# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

A [chezmoi](https://www.chezmoi.io/) dotfiles repository managing shell configs, tool settings, and bootstrap scripts across macOS, Linux (Debian/Fedora, including WSL), and Windows.

The actual dotfile templates live in `home/` — chezmoi uses `.chezmoiroot` to point there as the source root.

## Chezmoi Concepts

- **Templates** (`.tmpl` suffix): Go templates processed by chezmoi; use `{{ .chezmoi.os }}` and data variables like `{{ .iswsl }}`, `{{ .osid }}`, `{{ .oslike }}` for platform branching
- **`.chezmoiignore`**: Platform-conditional exclusions (e.g., macOS-only files ignored on Linux)
- **`.chezmoiexternal.toml.tmpl`**: Declares external archives/files fetched by chezmoi (zsh plugins)
- **`.chezmoidata/packages.yml`**: Central package lists consumed by install scripts
- **Script naming conventions**:
  - `run_once_*` — runs only once per machine
  - `run_onchange_*` — reruns when file content changes
  - `run_after_*` — runs after applying dotfiles
  - Numeric prefixes (`00-`, `10-`, `99-`) control execution order

## Key Files

| File | Purpose |
|------|---------|
| `home/.chezmoi.toml.tmpl` | Chezmoi config: auto-commit/push, merge tool, OS detection |
| `home/.chezmoidata/packages.yml` | Package lists for macOS (brew), Linux (apt/dnf/brew), Windows (winget) |
| `home/.chezmoiscripts/macos/` | macOS bootstrap: Homebrew + packages + oh-my-zsh + aws-vault |
| `home/.chezmoiscripts/linux/` | Linux bootstrap: 1Password install, packages, oh-my-zsh |
| `home/.chezmoiscripts/windows/` | Windows bootstrap: 1Password + winget packages via PowerShell |
| `home/.zshrc.tmpl` | Zsh config: plugins, aliases, starship, mise, zoxide |
| `home/.zshenv.tmpl` | Zsh env vars: EDITOR=hx, GitHub token via 1Password |
| `home/.gitconfig.tmpl` | Git config with SSH signing via 1Password (platform-specific paths) |

## Secrets

All secrets are injected via the [1Password CLI](https://developer.1password.com/docs/cli/) using `op://` URIs in templates. No secrets are stored in the repo. The 1Password desktop app with CLI integration must be unlocked for chezmoi to apply templates containing secrets.

## Common Commands

```sh
# Preview what chezmoi would change (dry run)
chezmoi diff

# Apply dotfiles to the home directory
chezmoi apply

# Edit a managed file (opens in $EDITOR, auto-adds to source)
chezmoi edit ~/.zshrc

# Add a new file to chezmoi management
chezmoi add ~/.config/some/file

# Re-run on-change scripts after modifying packages.yml or scripts
chezmoi apply --force

# Update external dependencies (zsh plugins)
chezmoi update
```

## Adding Packages

To add a new package, edit `home/.chezmoidata/packages.yml` under the appropriate OS section. The install scripts read from this file and will pick up changes on the next `chezmoi apply` (scripts re-run because their content hash changes).

## Platform Templating Pattern

```
{{- if eq .chezmoi.os "darwin" }}
# macOS-only content
{{- else if eq .chezmoi.os "linux" }}
  {{- if .iswsl }}
  # WSL-only content
  {{- else }}
  # Native Linux content
  {{- end }}
{{- end }}
```
