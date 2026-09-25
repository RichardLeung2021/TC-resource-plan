#!/usr/bin/env bash
# One-time setup for deployment through AWS CodePipeline.
# Creates the pipeline, the CodeBuild project, the GitHub connection and the
# passcode secret (infra/codepipeline.yaml).
#
# Usage: ./scripts/setup-codepipeline.sh <owner/repo> [region] [app-stack-name] [branch] [require-approval true|false]
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${1:?GitHub repository as owner/name, e.g. my-company/lucky-resource-plan}"
REGION="${2:-${AWS_REGION:-eu-west-2}}"
STACK="${3:-lucky-resource-plan}"
BRANCH="${4:-main}"
APPROVAL="${5:-false}"
PIPE_STACK="${STACK}-pipeline"

if [ -z "${PLAN_PASSCODE:-}" ]; then read -rsp "Team passcode for the page (8+ characters): " PLAN_PASSCODE; echo; fi

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$PIPE_STACK" \
  --template-file infra/codepipeline.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides RepositoryId="$REPO" BranchName="$BRANCH" AppStackName="$STACK" \
      Passcode="$PLAN_PASSCODE" RequireApproval="$APPROVAL" ${EXISTING_CONNECTION_ARN:+ExistingConnectionArn=$EXISTING_CONNECTION_ARN}

out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$PIPE_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CONN=$(out ConnectionArn)
STATUS=$(aws codestar-connections get-connection --region "$REGION" --connection-arn "$CONN" \
  --query "Connection.ConnectionStatus" --output text 2>/dev/null || echo UNKNOWN)

echo
echo "Pipeline: $(out PipelineUrl)"
if [ "$STATUS" != "AVAILABLE" ]; then
  echo
  echo "One more step: approve the GitHub connection (status: $STATUS)."
  echo "  1. Open $(out ConnectionsConsoleUrl)"
  echo "  2. Choose '${STACK}-github' > Update pending connection, and sign in to GitHub."
  echo "  3. Allow access to the repository $REPO."
  echo "  4. In the pipeline, choose Release change (or push to $BRANCH)."
else
  echo "The GitHub connection is ready. Push to $BRANCH, or choose Release change in the pipeline."
fi
