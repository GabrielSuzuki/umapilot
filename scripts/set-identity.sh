#!/usr/bin/env bash
#
# Rewrite every commit to use a GitHub noreply email, and scrub the old address
# out of file contents across all history.
#
# Run this BEFORE the first push. It rewrites history, so afterwards the commit
# hashes change -- harmless while the repo has never been pushed, disruptive
# once it has.
#
# Usage:
#   scripts/set-identity.sh [-y] <id>+<username>@users.noreply.github.com [old-email]
#
#   -y   assume yes to confirmations (for non-interactive use)
#
# Your noreply address is at GitHub -> Settings -> Emails.

set -euo pipefail

ASSUME_YES=0
if [[ "${1:-}" == "-y" || "${1:-}" == "--yes" ]]; then
  ASSUME_YES=1
  shift
fi

NEW_EMAIL="${1:-}"
OLD_EMAIL="${2:-$(git log -1 --format='%ae')}"

# Prompt, but never block: with -y, or with no terminal attached, decide without
# waiting. A script that hangs forever on a confirmation nobody can see is worse
# than one that refuses.
confirm() {
  local prompt="$1" default_when_unattended="$2"
  if [[ "$ASSUME_YES" == 1 ]]; then
    echo "$prompt yes (-y)"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    echo "$prompt no terminal attached; assuming '$default_when_unattended'." >&2
    [[ "$default_when_unattended" == "yes" ]]
    return
  fi
  local reply
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" == [yY]* ]]
}

if [[ -z "$NEW_EMAIL" ]]; then
  echo "usage: $0 <new-email> [old-email]" >&2
  exit 1
fi
if [[ "$NEW_EMAIL" != *@* ]]; then
  echo "error: '$NEW_EMAIL' does not look like an email address" >&2
  exit 1
fi
if [[ "$NEW_EMAIL" != *users.noreply.github.com ]]; then
  echo "warning: '$NEW_EMAIL' is not a github noreply address." >&2
  confirm "continue anyway?" no || exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty. Commit or stash first." >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "warning: this repo already has an 'origin' remote." >&2
  echo "         If you have already pushed, rewriting history will require a" >&2
  echo "         force-push and will break anyone else's clone." >&2
  confirm "continue?" no || exit 1
fi

echo "rewriting: $OLD_EMAIL -> $NEW_EMAIL"
echo

export NEW_EMAIL OLD_EMAIL FILTER_BRANCH_SQUELCH_WARNING=1

git filter-branch -f \
  --env-filter '
    if [ "$GIT_AUTHOR_EMAIL" = "$OLD_EMAIL" ]; then
      export GIT_AUTHOR_EMAIL="$NEW_EMAIL"
    fi
    if [ "$GIT_COMMITTER_EMAIL" = "$OLD_EMAIL" ]; then
      export GIT_COMMITTER_EMAIL="$NEW_EMAIL"
    fi
  ' \
  --tree-filter '
    files=$(grep -rlF "$OLD_EMAIL" . --exclude-dir=.git 2>/dev/null || true)
    if [ -n "$files" ]; then
      printf "%s\n" "$files" | while IFS= read -r f; do
        sed -i "s|$OLD_EMAIL|$NEW_EMAIL|g" "$f"
      done
    fi
  ' \
  -- --all

# filter-branch leaves the originals reachable via refs/original; drop them so
# the old address is not resurrected by a later push or gc.
git for-each-ref --format='%(refname)' refs/original | while read -r ref; do
  git update-ref -d "$ref"
done
git reflog expire --expire=now --all
git gc --prune=now --quiet

git config user.email "$NEW_EMAIL"

echo
echo "done. verify:"
echo
git log --format='  %h  %an <%ae>'
echo
if git log -p --all | grep -qF "$OLD_EMAIL"; then
  echo "WARNING: '$OLD_EMAIL' still appears somewhere in history." >&2
  exit 1
fi
echo "  no trace of $OLD_EMAIL anywhere in history or file contents."
