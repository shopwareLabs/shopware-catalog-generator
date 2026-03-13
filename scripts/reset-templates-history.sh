#!/usr/bin/env bash
# Squashes all git history of the shopware-catalog-templates repo to a single
# commit and compacts the pack to the minimum possible size.
#
# Usage:
#   bash scripts/reset-templates-history.sh [path/to/shopware-catalog-templates]
#
# If no path is given the current working directory is used.
set -euo pipefail

BRANCH="main"
COMMIT_MSG="chore: fresh catalog templates (history reset)

Replaces all generated templates with latest output.
Repository history was reset to keep the repo size small."

REPO_DIR="${1:-$(pwd)}"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "ERROR: Directory not found: $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

echo "=== Shopware Catalog Templates — History Reset ==="
echo ""

# Guard: must be run from a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "ERROR: Not a git repository. Run this script from the root of shopware-catalog-templates." >&2
  exit 1
fi

# Guard: must be the templates repo, not the generator or anything else.
# Check the remote URL contains the expected repo name.
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ "$REMOTE_URL" != *"shopware-catalog-templates"* ]]; then
  echo "ERROR: Remote origin does not look like the shopware-catalog-templates repo." >&2
  echo "       Got: ${REMOTE_URL:-<no remote>}" >&2
  echo "       Run this script from the root of shopware-catalog-templates." >&2
  exit 1
fi

# Guard: also verify the expected directory structure is present.
if [[ ! -d "generated/sales-channels" ]]; then
  echo "ERROR: This does not look like the shopware-catalog-templates repo." >&2
  echo "       Expected to find generated/sales-channels/ in: $(pwd)" >&2
  echo "       Run this script from the root of shopware-catalog-templates." >&2
  exit 1
fi

echo "This will squash ALL git history on '$BRANCH' to a single commit."
echo "Working directory: $(pwd)"
echo ""
read -r -p "Continue? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

# 1. Create orphan branch (no history)
echo "=== Creating orphan branch ==="
git checkout --orphan tmp-reset

# 2. Stage everything
git add -A

# 3. Commit the clean snapshot
echo "=== Committing fresh snapshot ==="
git commit -m "$COMMIT_MSG"

# 4. Rename orphan branch to main (replaces old main)
echo "=== Replacing $BRANCH with new single-commit history ==="
git branch -M "$BRANCH"

# 5. Delete any backup refs left by this or previous resets (e.g. refs/tmp/pre-rewrite-main)
echo "=== Cleaning up stale backup refs ==="
git for-each-ref --format='%(refname)' refs/tmp/ 2>/dev/null | while IFS= read -r ref; do
  echo "  Deleting $ref"
  git update-ref -d "$ref"
done

# 6. Update remote tracking ref so it doesn't hold old objects
if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  echo "=== Updating origin/$BRANCH tracking ref ==="
  git update-ref "refs/remotes/origin/$BRANCH" "refs/heads/$BRANCH"
fi

# 7. Expire reflog so old commits can be pruned
echo "=== Expiring reflog ==="
git reflog expire --expire=now --all

# 8. Replace the pack with a minimal clone (avoids --aggressive slowness on binary files)
echo "=== Repacking (lean clone strategy) ==="
TMPDIR_LEAN="$(mktemp -d)"
git clone --no-local --bare "file://$(pwd)" "$TMPDIR_LEAN/lean.git" 2>/dev/null
rm -f .git/objects/pack/pack-*.pack .git/objects/pack/pack-*.idx .git/objects/pack/pack-*.rev
cp "$TMPDIR_LEAN/lean.git/objects/pack/"* .git/objects/pack/
rm -rf "$TMPDIR_LEAN"

echo ""
echo "=== Done ==="
echo "  .git size:       $(du -sh .git | cut -f1)"
echo "  generated/ size: $(du -sh generated/ | cut -f1)"
echo "  Commits:         $(git rev-list --count HEAD)"
echo ""
echo "To push (force required since history was rewritten):"
echo "  git push --force origin $BRANCH"
