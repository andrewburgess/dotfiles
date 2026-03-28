#!/bin/sh
# Claude Code status line

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // .context_window.current_usage.input_tokens // empty')
output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // .context_window.current_usage.output_tokens // empty')

# Use only the parent folder name
parent_folder=$(basename "$cwd")

# ANSI color codes
BLUE_FG='\033[38;2;88;166;255m'
GREEN_FG='\033[38;2;31;136;61m'
SEP_FG='\033[38;2;88;166;255m'
STATS_FG='\033[38;2;180;190;200m'
BOLD='\033[1m'
RESET='\033[0m'
GIT_RED='\033[38;2;255;80;80m'
GIT_GREEN='\033[38;2;80;220;80m'

PL_RIGHT=""
# Git info (skip optional locks)
git_branch=""
git_status=""
if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)

    if [ -n "$branch" ]; then
        git_indicators=""

        # Parse porcelain output once; XY format: X=index/staged, Y=worktree/unstaged
        porcelain=$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)
        has_unstaged=0
        has_staged=0
        has_untracked=0
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            x="${line%"${line#?}"}"   # first char (index status)
            y="${line#?}"; y="${y%"${y#?}"}"  # second char (worktree status)
            if [ "$x" = "?" ] && [ "$y" = "?" ]; then
                has_untracked=1
            else
                # Staged: index column is not blank/unmodified
                [ "$x" != " " ] && [ "$x" != "?" ] && has_staged=1
                # Unstaged: worktree column is not blank/unmodified
                [ "$y" != " " ] && [ "$y" != "?" ] && has_unstaged=1
            fi
        done <<EOF
$porcelain
EOF

        # Build [!+?] bracket group with only applicable indicators
        bracket=""
        [ "$has_unstaged" -eq 1 ] && bracket="${bracket}!"
        [ "$has_staged" -eq 1 ]   && bracket="${bracket}+"
        [ "$has_untracked" -eq 1 ] && bracket="${bracket}?"
        if [ -n "$bracket" ]; then
            git_indicators="${git_indicators} $(printf "${BOLD}${GIT_RED}[%s]${RESET}" "$bracket")"
        fi

        # Line-level additions/deletions — +N bold green, -N bold red
        diff_stat=$(git -C "$cwd" --no-optional-locks diff --numstat 2>/dev/null)
        staged_stat=$(git -C "$cwd" --no-optional-locks diff --cached --numstat 2>/dev/null)
        added=0
        deleted=0
        while IFS=$(printf '\t') read -r a d _rest; do
            [ -n "$a" ] && [ "$a" != "-" ] && added=$((added + a))
            [ -n "$d" ] && [ "$d" != "-" ] && deleted=$((deleted + d))
        done <<EOF
$diff_stat
$staged_stat
EOF
        [ "$added" -gt 0 ] && git_indicators="${git_indicators} $(printf "${BOLD}${GIT_GREEN}+${added}${RESET}")"
        [ "$deleted" -gt 0 ] && git_indicators="${git_indicators} $(printf "${BOLD}${GIT_RED}-${deleted}${RESET}")"

        # Stashes
        stashes=$(git -C "$cwd" --no-optional-locks stash list 2>/dev/null | wc -l | tr -d ' ')
        [ "$stashes" -gt 0 ] && git_indicators="${git_indicators} *${stashes}"

        # Ahead/behind remote
        upstream=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
        if [ -n "$upstream" ]; then
            ahead=$(git -C "$cwd" --no-optional-locks rev-list "@{upstream}..HEAD" --count 2>/dev/null)
            behind=$(git -C "$cwd" --no-optional-locks rev-list "HEAD..@{upstream}" --count 2>/dev/null)
            [ "$ahead" -gt 0 ] && git_indicators="${git_indicators} ⇡${ahead}"
            [ "$behind" -gt 0 ] && git_indicators="${git_indicators} ⇣${behind}"
        fi

        git_branch="$branch"
        git_status="$git_indicators"
    fi
fi

# Context usage progress bar (20 blocks)
ctx=""
if [ -n "$used_pct" ]; then
    filled=$(printf "%.0f" "$(echo "$used_pct / 5" | bc -l)")
    [ "$filled" -gt 20 ] && filled=20
    empty=$((20 - filled))
    bar=""
    i=0
    while [ "$i" -lt "$filled" ]; do
        bar="${bar}█"
        i=$((i + 1))
    done
    i=0
    while [ "$i" -lt "$empty" ]; do
        bar="${bar}░"
        i=$((i + 1))
    done
    fmt_tokens() {
        n="$1"
        if [ "$n" -ge 1000000 ]; then
            printf "%.1fM" "$(echo "scale=1; $n / 1000000" | bc)"
        elif [ "$n" -ge 1000 ]; then
            printf "%.1fk" "$(echo "scale=1; $n / 1000" | bc)"
        else
            printf "%d" "$n"
        fi
    }
    token_info=""
    if [ -n "$input_tokens" ]; then
        fmt_in=$(fmt_tokens "$input_tokens")
        fmt_out=$(fmt_tokens "${output_tokens:-0}")
        token_info=" (↑${fmt_in} ↓${fmt_out})"
    fi
    ctx=$(printf "%s %.0f%%%s" "$bar" "$used_pct" "$token_info")
fi

# Rate limit circle icon based on usage percentage
rate_circle() {
    pct="$1"
    rounded=$(printf "%.0f" "$pct")
    if [ "$rounded" -le 0 ]; then
        printf "○"
    elif [ "$rounded" -le 25 ]; then
        printf "◔"
    elif [ "$rounded" -le 50 ]; then
        printf "◑"
    elif [ "$rounded" -le 75 ]; then
        printf "◕"
    else
        printf "●"
    fi
}

# Format a countdown from now until a Unix epoch timestamp
# Output: "4h52m" for sub-day intervals, "3d12h10m" for multi-day
format_countdown() {
    resets_at="$1"
    now=$(date +%s)
    diff=$((resets_at - now))
    [ "$diff" -le 0 ] && printf "now" && return
    days=$((diff / 86400))
    hours=$(( (diff % 86400) / 3600 ))
    minutes=$(( (diff % 3600) / 60 ))
    if [ "$days" -gt 0 ]; then
        printf "%dd%dh%dm" "$days" "$hours" "$minutes"
    else
        printf "%dh%dm" "$hours" "$minutes"
    fi
}

# Build a 20-character progress bar for a percentage value
rate_bar() {
    pct="$1"
    filled=$(printf "%.0f" "$(echo "$pct / 5" | bc -l)")
    [ "$filled" -gt 20 ] && filled=20
    empty=$((20 - filled))
    bar=""
    i=0
    while [ "$i" -lt "$filled" ]; do
        bar="${bar}█"
        i=$((i + 1))
    done
    i=0
    while [ "$i" -lt "$empty" ]; do
        bar="${bar}░"
        i=$((i + 1))
    done
    printf "%s" "$bar"
}

# Rate limits (5h session and 7d, if available) — circle icons only, inline
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_resets=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
seven_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
seven_resets=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
rate_icons=""
if [ -n "$five_pct" ]; then
    rate_icons="${rate_icons}5h $(rate_circle "$five_pct")"
fi
if [ -n "$seven_pct" ]; then
    [ -n "$rate_icons" ] && rate_icons="${rate_icons}$(printf "${SEP_FG} | ${RESET}")"
    rate_icons="${rate_icons}7d $(rate_circle "$seven_pct")"
fi

# Build output
printf "${BLUE_FG}${BOLD}%s${RESET}" "$parent_folder"

if [ -n "$git_branch" ]; then
    printf "${SEP_FG} | ${GREEN_FG}%s${RESET}" "$git_branch"
    if [ -n "$git_status" ]; then
        printf "%b" "$git_status"
    fi
fi

printf "${SEP_FG} | ${STATS_FG}%s${RESET}" "$model"

if [ -n "$ctx" ]; then
    printf "${SEP_FG} | ${STATS_FG}%s${RESET}" "$ctx"
fi

if [ -n "$rate_icons" ]; then
    printf "${SEP_FG} | ${STATS_FG}%s${RESET}" "$rate_icons"
fi
