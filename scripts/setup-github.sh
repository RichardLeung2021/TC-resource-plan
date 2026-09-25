#!/usr/bin/env bash
# One-time setup for automatic deployment from GitHub.
# Creates the AWS deploy role and, if the GitHub CLI (gh) is installed and
# signed in, saves the secrets and variables in the repository for you.
#
# Usage: ./scripts/setup-github.sh <github-org-or-user> <repo-name> [region] [stack-name]
set -euo pipefail
cd "$(dirname "$0")/.."

ORG="${1:?GitHub organisation or user, e.g. my-company}"
REPO="${2:?GitHub repository name, e.g. lucky-resource-plan}"
REGION="${3:-${AWS_REGION:-eu-west-2}}"
STACK="${4:-lucky-resource-plan}"
ROLE_STACK="${STACK}-github-role"

# Reuse the GitHub identity provider if the account already has one.
if aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[].Arn" --output text \
     | grep -q "token.actions.githubusercontent.com"; then
  CREATE_PROVIDER=false
  echo "Found an existing GitHub identity provider in this account; reusing it."
else
  CREATE_PROVIDER=true
fi

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$ROLE_STACK" \
  --template-file infra/github-deploy-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides GitHubOrg="$ORG" GitHubRepo="$REPO" AppStackName="$STACK" CreateOIDCProvider="$CREATE_PROVIDER"

ROLE_ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$ROLE_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)
echo "Deploy role: $ROLE_ARN"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if [ -z "${PLAN_PASSCODE:-}" ]; then read -rsp "Team passcode for the page (8+ characters): " PLAN_PASSCODE; echo; fi
  gh secret set AWS_DEPLOY_ROLE_ARN --repo "$ORG/$REPO" --body "$ROLE_ARN"
  gh secret set PLAN_PASSCODE --repo "$ORG/$REPO" --body "$PLAN_PASSCODE"
  gh variable set AWS_REGION --repo "$ORG/$REPO" --body "$REGION"
  gh variable set STACK_NAME --repo "$ORG/$REPO" --body "$STACK"
  echo "Saved the secrets and variables in $ORG/$REPO."
  echo "Push to main, or run the 'Deploy to AWS' workflow from the Actions tab."
else
  echo
  echo "GitHub CLI not found or not signed in. Add these in GitHub:"
  echo "  Settings > Secrets and variables > Actions > Secrets"
  echo "    AWS_DEPLOY_ROLE_ARN = $ROLE_ARN"
  echo "    PLAN_PASSCODE       = <your team passcode, 8+ characters>"
  echo "  Settings > Secrets and variables > Actions > Variables"
  echo "    AWS_REGION = $REGION"
  echo "    STACK_NAME = $STACK"
fi
