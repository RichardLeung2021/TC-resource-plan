#!/usr/bin/env bash
# Build and deploy the stack, upload the page, and (first time) load the data.
# Usage: ./scripts/deploy.sh [stack-name] [region]
set -euo pipefail
cd "$(dirname "$0")/.."
STACK="${1:-lucky-resource-plan}"
REGION="${2:-${AWS_REGION:-eu-west-2}}"

if [ -z "${PLAN_PASSCODE:-}" ]; then
  read -rsp "Team passcode (8+ characters): " PLAN_PASSCODE; echo
fi

sam build
sam deploy --stack-name "$STACK" --region "$REGION" --resolve-s3 \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "Passcode=$PLAN_PASSCODE"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out SiteBucketName); DIST=$(out DistributionId); URL=$(out SiteUrl)

aws s3 sync frontend/ "s3://$BUCKET/" --delete --region "$REGION" \
  --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null

echo "Loading the plan data (skipped automatically if the plan already has data)..."
sleep 5
node scripts/seed.mjs "$URL" "$PLAN_PASSCODE" || true

echo
echo "Done. Open: $URL"
