#!/usr/bin/env bash
# Server-side Pullfrog config for wwwyo/tools — this file is the SSOT.
#
# .github/workflows/pullfrog.yml is a Pullfrog-managed file kept pristine
# (byte-identical across repos, updated by upstream PRs). Repo-level settings
# (model, effort, review/issue/label modes, hooks, ...) live in Pullfrog's
# backend and are invisible to git — this script records and reapplies them.
#
# Apply:  .github/pullfrog.config.sh        (uses gh auth)
# Audit:  mise exec -- pullfrog config list --repo wwwyo/tools
#
# BYOK keys are org-scoped (OPENCODE_API_KEY inherited) — see `pf secret list`.
set -euo pipefail

REPO="wwwyo/tools"
PF=(mise exec -- pullfrog)

pf_set()   { "${PF[@]}" config set   "$1" "$2" --repo "$REPO" --yes; }
pf_unset() { "${PF[@]}" config unset "$1"     --repo "$REPO" --yes; }


pf_set enabled 'true'
pf_set model 'opencode-go/muse-spark-1.3-contributor'
pf_set effort '1'
pf_set progress-comments 'true'
pf_set oss 'true'
pf_set push 'enabled'
pf_set shell 'restricted'
pf_set signed-commits 'false'
pf_set auto-merge 'false'
pf_set mention.enabled 'true'
pf_set mention.non-collaborators 'false'
pf_set review.mode 'agent'
pf_set review.non-collaborators 'false'
pf_set review.re-review 'true'
pf_set review.approve 'false'
pf_set review.drafts 'true'
pf_set review.own-prs 'false'
pf_set review.status-check 'true'
pf_set review.approval-check 'true'
pf_set issue.mode 'none'
pf_set issue.non-collaborators 'true'
pf_set label.enabled 'false'
pf_set address-reviews.enabled 'true'
pf_set fix-ci.own-prs 'true'
pf_set fix-ci.reviewed-prs 'false'

"${PF[@]}" config set hooks.setup --repo "$REPO" --yes --file - <<'PULLFROG_HOOK_SETUP'
# mise toolchain: install mise if absent, install repo tools, expose shims on PATH
# NB: set -e is intentionally AFTER the file guard — `ls` exits non-zero when
# only some of the files exist, and pipefail would turn that into a false negative.
ls mise.toml .mise.toml .config/mise.toml 2>/dev/null | grep -q . || exit 0
set -euo pipefail
if ! command -v mise >/dev/null 2>&1; then
  # v2026.10.0 was released on 2026-10-02; verify the pinned installer before running it.
  mise_installer=$(mktemp)
  trap 'rm -f "$mise_installer"' EXIT
  curl -fsSL https://github.com/jdx/mise/releases/download/v2026.10.0/install.sh -o "$mise_installer"
  printf '41743b1036070d01e37a6eab45fab283766029c6ae7da1c394a0b1c593b28be3  %s\n' "$mise_installer" | sha256sum --check -
  MISE_VERSION=v2026.10.0 sh "$mise_installer"
fi
export PATH="$HOME/.local/bin:$PATH"
mise trust -a 2>/dev/null || true
mise install -y
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME"/.local/share/mise/shims/* "$HOME"/.local/bin/ 2>/dev/null || true
PULLFROG_HOOK_SETUP

# explicit unsets — keep the backend converged on this file
pf_unset instructions
pf_unset env-allowlist
pf_unset hooks.post-checkout
pf_unset hooks.pre-push
pf_unset hooks.stop
pf_unset prompts.review
pf_unset prompts.build
pf_unset prompts.plan
pf_unset prompts.address-reviews
pf_unset prompts.fix-ci
pf_unset mention.instructions
pf_unset issue.instructions
pf_unset label.instructions
