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

# Context usage progress bar (30 blocks, blue→red gradient on filled portion)
ctx=""
if [ -n "$used_pct" ]; then
    filled=$(printf "%.0f" "$(echo "$used_pct * 30 / 100" | bc -l)")
    [ "$filled" -gt 30 ] && filled=30
    empty=$((30 - filled))

    # Interpolate each filled block from blue (88,166,255) to red (255,80,80)
    # t for each block is its position across the full 0–100% range
    bar=""
    i=0
    while [ "$i" -lt "$filled" ]; do
        t_num=$(echo "scale=10; ($i * 100 / 30 + 100 / 30 / 2) / 100" | bc -l)
        tip_r=$(printf "%.0f" "$(echo "88 + (255 - 88) * $t_num" | bc -l)")
        tip_g=$(printf "%.0f" "$(echo "166 + (80  - 166) * $t_num" | bc -l)")
        tip_b=$(printf "%.0f" "$(echo "255 + (80  - 255) * $t_num" | bc -l)")
        bar="${bar}$(printf '\033[38;2;%d;%d;%dm█\033[0m' "$tip_r" "$tip_g" "$tip_b")"
        i=$((i + 1))
    done

    # Empty blocks use the tip color (at current fill level) but desaturated and dimmed
    # Tip t = used_pct / 100
    tip_r=$(printf "%.0f" "$(echo "88 + (255 - 88) * $used_pct / 100" | bc -l)")
    tip_g=$(printf "%.0f" "$(echo "166 + (80  - 166) * $used_pct / 100" | bc -l)")
    tip_b=$(printf "%.0f" "$(echo "255 + (80  - 255) * $used_pct / 100" | bc -l)")
    # Desaturate toward luminance, then dim: luma = 0.299R + 0.587G + 0.114B
    luma=$(printf "%.0f" "$(echo "0.299 * $tip_r + 0.587 * $tip_g + 0.114 * $tip_b" | bc -l)")
    # Mix 80% toward gray (strong desaturation), then scale to 30% brightness
    dr=$(printf "%.0f" "$(echo "($tip_r * 0.20 + $luma * 0.80) * 0.30" | bc -l)")
    dg=$(printf "%.0f" "$(echo "($tip_g * 0.20 + $luma * 0.80) * 0.30" | bc -l)")
    db=$(printf "%.0f" "$(echo "($tip_b * 0.20 + $luma * 0.80) * 0.30" | bc -l)")
    i=0
    while [ "$i" -lt "$empty" ]; do
        bar="${bar}$(printf '\033[38;2;%d;%d;%dm░\033[0m' "$dr" "$dg" "$db")"
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
    ctx=$(printf "%b %.0f%%%s" "$bar" "$used_pct" "$token_info")
fi

# Interpolate RGB from blue (88,166,255) to red (255,80,80) at a given percentage
rate_color() {
    pct="$1"
    r=$(printf "%.0f" "$(echo "88 + (255 - 88) * $pct / 100" | bc -l)")
    g=$(printf "%.0f" "$(echo "166 + (80  - 166) * $pct / 100" | bc -l)")
    b=$(printf "%.0f" "$(echo "255 + (80  - 255) * $pct / 100" | bc -l)")
    printf '\033[38;2;%d;%d;%dm' "$r" "$g" "$b"
}

# Render a single rate limit indicator: colored circle + colored label
rate_indicator() {
    pct="$1"
    label="$2"
    rounded=$(printf "%.0f" "$pct")
    if [ "$rounded" -ge 50 ]; then
        circle="●"
    else
        circle="○"
    fi
    color=$(rate_color "$pct")
    printf '%b%s %s\033[0m' "$color" "$circle" "$label"
}

# Detect plan type and build appropriate indicator
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
seven_pct=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
session_cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')

rate_icons=""
budget_indicator=""

if [ -n "$five_pct" ] || [ -n "$seven_pct" ]; then
    # Rate-based plan — show rate limit indicators
    if [ -n "$five_pct" ]; then
        rate_icons="${rate_icons}$(rate_indicator "$five_pct" "5h")"
    fi
    if [ -n "$seven_pct" ]; then
        [ -n "$rate_icons" ] && rate_icons="${rate_icons}$(printf "${SEP_FG} | ${RESET}")"
        rate_icons="${rate_icons}$(rate_indicator "$seven_pct" "7d")"
    fi
fi

if [ -n "$session_cost" ]; then
    # Dollar-based (API) plan — track monthly budget
    MONTHLY_BUDGET=100
    BUDGET_FILE="$HOME/.claude/budget-tracker.json"
    current_month=$(date +%Y-%m)
    session_id=$(echo "$input" | jq -r '.session_id // empty')

    # Initialize budget file if missing or malformed
    if [ ! -f "$BUDGET_FILE" ] || ! jq -e '.month' "$BUDGET_FILE" >/dev/null 2>&1; then
        printf '{"month":"%s","sessions":{},"total_spent":0}' "$current_month" > "$BUDGET_FILE"
    fi

    stored_month=$(jq -r '.month' "$BUDGET_FILE")

    # Reset on new month
    if [ "$stored_month" != "$current_month" ]; then
        printf '{"month":"%s","sessions":{},"total_spent":0}' "$current_month" > "$BUDGET_FILE"
    fi

    # Compute delta for this session
    last_cost=$(jq -r --arg sid "$session_id" '.sessions[$sid] // 0' "$BUDGET_FILE")
    delta=$(echo "$session_cost - $last_cost" | bc -l)
    # Guard against negative delta (e.g., new session with same id)
    is_negative=$(echo "$delta < 0" | bc -l)
    [ "$is_negative" -eq 1 ] && delta="$session_cost"

    # Update state
    new_total=$(jq -r '.total_spent' "$BUDGET_FILE")
    new_total=$(echo "$new_total + $delta" | bc -l)
    jq --arg sid "$session_id" \
       --argjson cost "$session_cost" \
       --argjson total "$new_total" \
       '.sessions[$sid] = $cost | .total_spent = $total' \
       "$BUDGET_FILE" > "${BUDGET_FILE}.tmp" && mv "${BUDGET_FILE}.tmp" "$BUDGET_FILE"

    # Compute remaining budget
    remaining=$(echo "$MONTHLY_BUDGET - $new_total" | bc -l)
    is_neg=$(echo "$remaining < 0" | bc -l)
    [ "$is_neg" -eq 1 ] && remaining="0"
    spent_pct=$(echo "scale=2; $new_total * 100 / $MONTHLY_BUDGET" | bc -l)
    is_over=$(echo "$spent_pct > 100" | bc -l)
    [ "$is_over" -eq 1 ] && spent_pct="100"

    # Budget bar (30 blocks) — filled = remaining, color by spent_pct (blue=healthy, red=depleted)
    remaining_pct=$(echo "100 - $spent_pct" | bc -l)
    filled=$(printf "%.0f" "$(echo "$remaining_pct * 30 / 100" | bc -l)")
    [ "$filled" -gt 30 ] && filled=30
    [ "$filled" -lt 0 ] && filled=0
    empty_blocks=$((30 - filled))

    budget_bar=""
    i=0
    while [ "$i" -lt "$filled" ]; do
        # Color each filled block based on spent_pct (uniform color across the bar)
        tip_r=$(printf "%.0f" "$(echo "88 + (255 - 88) * $spent_pct / 100" | bc -l)")
        tip_g=$(printf "%.0f" "$(echo "166 + (80  - 166) * $spent_pct / 100" | bc -l)")
        tip_b=$(printf "%.0f" "$(echo "255 + (80  - 255) * $spent_pct / 100" | bc -l)")
        budget_bar="${budget_bar}$(printf '\033[38;2;%d;%d;%dm█\033[0m' "$tip_r" "$tip_g" "$tip_b")"
        i=$((i + 1))
    done

    # Empty blocks — dimmed
    tip_r=$(printf "%.0f" "$(echo "88 + (255 - 88) * $spent_pct / 100" | bc -l)")
    tip_g=$(printf "%.0f" "$(echo "166 + (80  - 166) * $spent_pct / 100" | bc -l)")
    tip_b=$(printf "%.0f" "$(echo "255 + (80  - 255) * $spent_pct / 100" | bc -l)")
    luma_b=$(printf "%.0f" "$(echo "0.299 * $tip_r + 0.587 * $tip_g + 0.114 * $tip_b" | bc -l)")
    dr_b=$(printf "%.0f" "$(echo "($tip_r * 0.20 + $luma_b * 0.80) * 0.30" | bc -l)")
    dg_b=$(printf "%.0f" "$(echo "($tip_g * 0.20 + $luma_b * 0.80) * 0.30" | bc -l)")
    db_b=$(printf "%.0f" "$(echo "($tip_b * 0.20 + $luma_b * 0.80) * 0.30" | bc -l)")
    i=0
    while [ "$i" -lt "$empty_blocks" ]; do
        budget_bar="${budget_bar}$(printf '\033[38;2;%d;%d;%dm░\033[0m' "$dr_b" "$dg_b" "$db_b")"
        i=$((i + 1))
    done

    # Format dollar amounts
    fmt_remaining=$(printf "\$%.2f" "$remaining")
    fmt_total=$(printf "\$%.2f" "$new_total")
    fmt_session=$(printf "\$%.2f" "$session_cost")

    budget_indicator=$(printf "%b %s left (%s spent, session: %s)" "$budget_bar" "$fmt_remaining" "$fmt_total" "$fmt_session")
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

second_line=""
if [ -n "$ctx" ]; then
    second_line="${second_line}$(printf "${STATS_FG}%b${RESET}" "$ctx")"
fi

if [ -n "$rate_icons" ]; then
    if [ -n "$second_line" ]; then
        second_line="${second_line}$(printf "${SEP_FG} | ${RESET}")"
    fi
    second_line="${second_line}$(printf "${STATS_FG}%b${RESET}" "$rate_icons")"
fi

if [ -n "$second_line" ]; then
    printf "\n%b" "$second_line"
fi

if [ -n "$budget_indicator" ]; then
    printf "\n%b" "$(printf "${STATS_FG}%b${RESET}" "$budget_indicator")"
fi
