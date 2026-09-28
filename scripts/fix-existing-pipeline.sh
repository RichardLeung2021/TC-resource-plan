#!/usr/bin/env bash
# Repairs a pipeline created with the CodePipeline console wizard (the Docker /
# "simple-docker-service" template) so that it deploys the Live Team Resource Plan.
#
# It keeps the pipeline and its GitHub source, and:
#   1. stores the team passcode in Secrets Manager and gives the CodeBuild
#      service role permission to deploy this app (infra/adopt-existing-codebuild.yaml)
#   2. switches the CodeBuild project to the repository's buildspec.yml, a
#      standard build image and the STACK_NAME / PLAN_PASSCODE variables
#   3. removes any stages after the build (e.g. "Deploy to ECS"), after asking
#
# Easiest place to run it: AWS CloudShell (upload the zip, unzip, cd into it).
# Usage: ./scripts/fix-existing-pipeline.sh [region] [codebuild-project-name] [app-stack-name]
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${1:-${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-eu-north-1}"
PROJECT="${2:-}"
STACK="${3:-lucky-resource-plan}"
export AWS_DEFAULT_REGION="$REGION"

# ---- find the CodeBuild project ----
if [ -z "$PROJECT" ]; then
  mapfile -t PROJECTS < <(aws codebuild list-projects --query 'projects' --output text | tr '\t' '\n' | sed '/^$/d')
  if [ "${#PROJECTS[@]}" -eq 0 ]; then echo "No CodeBuild projects found in $REGION."; exit 1; fi
  if [ "${#PROJECTS[@]}" -eq 1 ]; then PROJECT="${PROJECTS[0]}"
  else
    echo "CodeBuild projects in $REGION:"; i=1; for p in "${PROJECTS[@]}"; do echo "  $i) $p"; i=$((i+1)); done
    read -rp "Which one does your pipeline use? Enter the number: " n
    PROJECT="${PROJECTS[$((n-1))]}"
  fi
fi
echo "Using CodeBuild project: $PROJECT (region $REGION)"

ROLE_ARN=$(aws codebuild batch-get-projects --names "$PROJECT" --query 'projects[0].serviceRole' --output text)
ROLE_NAME="${ROLE_ARN##*/}"
echo "Service role: $ROLE_NAME"

if [ -z "${PLAN_PASSCODE:-}" ]; then read -rsp "Team passcode for the page (8+ characters): " PLAN_PASSCODE; echo; fi

# ---- 1. passcode secret + deploy permissions ----
aws cloudformation deploy \
  --stack-name "${STACK}-build-access" \
  --template-file infra/adopt-existing-codebuild.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides BuildRoleName="$ROLE_NAME" AppStackName="$STACK" Passcode="$PLAN_PASSCODE"
SECRET_ARN=$(aws cloudformation describe-stacks --stack-name "${STACK}-build-access" \
  --query "Stacks[0].Outputs[?OutputKey=='PasscodeSecretArn'].OutputValue" --output text)

# ---- 2. point the project at buildspec.yml ----
aws codebuild batch-get-projects --names "$PROJECT" --query 'projects[0]' --output json > /tmp/lrp-project.json
python3 - "$PROJECT" "$STACK" "$SECRET_ARN" <<'PY'
import json, sys
project, stack, secret = sys.argv[1:4]
cur = json.load(open('/tmp/lrp-project.json'))['environment']
ct = cur.get('computeType', '')
update = {
  'name': project,
  'source': {'type': 'CODEPIPELINE', 'buildspec': 'buildspec.yml'},
  'environment': {
    'type': 'LINUX_CONTAINER',
    'image': 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
    'computeType': ct if ct.startswith('BUILD_GENERAL1') else 'BUILD_GENERAL1_SMALL',
    'privilegedMode': False,
    'imagePullCredentialsType': 'CODEBUILD',
    'environmentVariables': [
      {'name': 'STACK_NAME', 'value': stack, 'type': 'PLAINTEXT'},
      {'name': 'PLAN_PASSCODE', 'value': secret, 'type': 'SECRETS_MANAGER'},
    ],
  },
  'timeoutInMinutes': 60,
}
json.dump(update, open('/tmp/lrp-update.json', 'w'))
PY
aws codebuild update-project --cli-input-json file:///tmp/lrp-update.json > /dev/null
echo "CodeBuild project now uses buildspec.yml from the repository."

# ---- 3. remove stages after the build ----
PIPE=""
for name in $(aws codepipeline list-pipelines --query 'pipelines[].name' --output text); do
  if aws codepipeline get-pipeline --name "$name" --query 'pipeline.stages[].actions[].configuration.ProjectName' --output text | tr '\t' '\n' | grep -qx "$PROJECT"; then PIPE="$name"; break; fi
done
if [ -z "$PIPE" ]; then
  echo "No pipeline uses $PROJECT; nothing else to change."
else
  aws codepipeline get-pipeline --name "$PIPE" --query 'pipeline' --output json > /tmp/lrp-pipe.json
  EXTRA=$(python3 - "$PROJECT" <<'PY'
import json, sys
proj = sys.argv[1]; p = json.load(open('/tmp/lrp-pipe.json'))
idx = next(i for i, s in enumerate(p['stages']) if any(a.get('configuration', {}).get('ProjectName') == proj for a in s['actions']))
print(' '.join(s['name'] for s in p['stages'][idx+1:]))
PY
)
  if [ -n "$EXTRA" ]; then
    echo "Pipeline $PIPE has stages after the build: $EXTRA"
    echo "These were made for the Docker template (for example deploying to ECS) and will fail for this app."
    read -rp "Remove them? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      python3 - "$PROJECT" <<'PY'
import json, sys
proj = sys.argv[1]; p = json.load(open('/tmp/lrp-pipe.json'))
idx = next(i for i, s in enumerate(p['stages']) if any(a.get('configuration', {}).get('ProjectName') == proj for a in s['actions']))
p['stages'] = p['stages'][:idx+1]
json.dump({'pipeline': p}, open('/tmp/lrp-pipe-new.json', 'w'))
PY
      aws codepipeline update-pipeline --cli-input-json file:///tmp/lrp-pipe-new.json > /dev/null
      echo "Removed: $EXTRA"
    fi
  fi
  aws codepipeline start-pipeline-execution --name "$PIPE" > /dev/null
  echo
  echo "Started a new run of $PIPE. Watch it here:"
  echo "  https://$REGION.console.aws.amazon.com/codesuite/codepipeline/pipelines/$PIPE/view?region=$REGION"
  echo "The site address is printed at the end of the build log (\"Deployed: https://...\")."
fi
