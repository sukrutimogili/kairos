#!/usr/bin/env bash
set -euo pipefail

# === EDIT THESE ===
BRANCH="feature/vscode-extension"   # the branch to rebase (e.g. Indu's)
BASE_BRANCH="main"
GIT_NAME="Sukruti"
GIT_EMAIL="sukrutimogili@gmail.com"

# Run this from inside your existing local clone of the repo
# (e.g. ~/kairos/kairos). It does NOT need the branch to already
# exist locally — only on origin.

git config user.name "$GIT_NAME"
git config user.email "$GIT_EMAIL"

# 1. Make sure we have every ref origin knows about --------------------------
echo "Fetching origin..."
git fetch origin

if ! git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "ERROR: origin/$BRANCH does not exist on the remote." >&2
  echo "Check the branch name (git branch -a --list 'origin/*')." >&2
  exit 1
fi

# 2. Check out the branch, creating a local tracking branch if needed --------
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"   # make sure local matches origin exactly first
else
  git checkout -b "$BRANCH" "origin/$BRANCH"
fi

echo "Now on $BRANCH, matching origin/$BRANCH."

# 3. Rebase onto the latest main ----------------------------------------------
echo "Rebasing $BRANCH onto origin/$BASE_BRANCH..."
if ! git rebase "origin/$BASE_BRANCH"; then
  echo ""
  echo "Rebase hit a conflict." >&2
  echo "Fix the conflicting file(s), then run:" >&2
  echo "  git add <file>" >&2
  echo "  git rebase --continue" >&2
  echo "(repeat if more conflicts follow)" >&2
  echo "" >&2
  echo "Or back out entirely with: git rebase --abort" >&2
  echo "" >&2
  echo "Once the rebase is finished cleanly, re-run this script — step 1-2" >&2
  echo "will just fast-forward past what's already done, or push manually:" >&2
  echo "  git push --force-with-lease origin $BRANCH" >&2
  exit 1
fi

echo "Rebase complete, no conflicts."

# 4. Push the rewritten branch -------------------------------------------------
# --force-with-lease (not plain --force): refuses to overwrite origin/$BRANCH
# if it has commits we haven't seen (e.g. Indu pushed something after our fetch).
echo "Pushing rebased $BRANCH to origin..."
git push --force-with-lease origin "$BRANCH"

echo ""
echo "Done. $BRANCH is rebased onto the latest $BASE_BRANCH and pushed."
echo "Note for whoever owns this branch normally (Indu): their old local copy"
echo "is now diverged. Next time they touch this branch they should run:"
echo "  git fetch origin && git reset --hard origin/$BRANCH"
echo "instead of git pull, or they'll get a conflict against the rewritten history."
