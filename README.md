# Live Team Resource Plan on AWS

This package runs the Lucky resource plan web page on your own AWS account. It includes the page, a small API, and the current plan data: 30 projects, 65 people, 321 resource rows, and a calendar of 74 weeks.

## What gets deployed

```
Browser ──► CloudFront ──┬── /*      ──► S3 bucket (the page: index.html, store.js)
                         └── /api/*  ──► API Gateway (HTTP API) ──► Lambda ──► DynamoDB
```

| Resource | Purpose |
|---|---|
| S3 bucket (private) | Holds the page. Only CloudFront can read it (Origin Access Control). |
| CloudFront distribution | Serves the page over HTTPS. Routes `/api/*` to the API on the same domain, so no CORS setup is needed. |
| API Gateway HTTP API + Lambda (Node.js 24, arm64) | Reads and writes plan documents and checks the team passcode. |
| DynamoDB table (on-demand) | Stores every project, person, resource row and list. Point-in-time recovery is on. The table is kept even if the stack is deleted. |

Everyone who opens the site sees the same plan. Other people's changes show up within about 5 seconds.

## Folder contents

```
template.yaml            AWS SAM template for all the resources above
backend/index.mjs        Lambda API handler
frontend/index.html      The resource plan page
frontend/store.js        Connects the page to /api (saving, loading, change polling, Excel download)
seed/data.json           The current plan data
scripts/deploy.sh        One-command build, deploy, upload and data load
scripts/seed.mjs         Loads seed/data.json into a deployed plan through the API
scripts/local-server.mjs Runs the page on your machine with no AWS account
scripts/setup-github.sh  One-time setup for automatic deployment from GitHub
infra/github-deploy-role.yaml   IAM role that GitHub Actions uses to deploy (no access keys)
.github/workflows/deploy.yml    GitHub Actions workflow: deploys on every push to main
```

## Try it locally first (optional)

You need Node.js 18 or later.

```bash
node scripts/local-server.mjs
# open http://localhost:8080
```

Local edits are saved to `local-data.json`. Delete that file to start again from `seed/data.json`.

## Deploy

### Prerequisites

- An AWS account and credentials with permission to create CloudFormation, S3, CloudFront, Lambda, API Gateway, DynamoDB and IAM roles
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 18 or later

### One command

```bash
./scripts/deploy.sh lucky-resource-plan eu-west-2
```

The first argument is the stack name and the second is the region. The script:

1. Asks for a team passcode (8 or more characters). To skip the prompt, set `PLAN_PASSCODE` first.
2. Builds and deploys the stack with SAM.
3. Uploads `frontend/` to the bucket and clears the CloudFront cache.
4. Loads `seed/data.json` into the plan. This only happens when the plan is empty, so re-running the script never overwrites your edits.
5. Prints the site address, for example `https://d1234abcd.cloudfront.net`.

The first deployment takes about 5 to 10 minutes, mostly while CloudFront sets up.

### Updating later

- **Page only:** after editing `frontend/`, run `./scripts/deploy.sh` again. The data is not touched.
- **Change the passcode:** run `./scripts/deploy.sh` again and enter the new passcode. Everyone then enters the new one the next time they save or load.

## Automatic deployment from GitHub

Once this is set up, every push to the `main` branch deploys the site automatically. You can also start a deployment by hand from the **Actions** tab. Your plan data in DynamoDB is never overwritten by a deployment.

GitHub signs in to AWS through OpenID Connect (OIDC), so no AWS access keys are stored in GitHub. The role it uses can only manage this app's resources.

### 1. Put the package in a GitHub repository

Create an empty repository, for example `my-company/lucky-resource-plan`. Then push the contents of this folder so that `template.yaml` is at the top level:

```bash
git init -b main
git add .
git commit -m "Lucky resource plan"
git remote add origin https://github.com/my-company/lucky-resource-plan.git
git push -u origin main
```

The first push starts the workflow. It stops at "Check setup" until you finish step 2, which is expected.

### 2. Connect GitHub to AWS (once)

Run this with AWS credentials that can create IAM roles, for example an administrator:

```bash
./scripts/setup-github.sh my-company lucky-resource-plan eu-west-2
```

The script:

- creates the deploy role (`infra/github-deploy-role.yaml`), and reuses GitHub's identity provider if your account already has one;
- saves the secrets and variables in the repository, if the [GitHub CLI](https://cli.github.com/) is installed and signed in (`gh auth login`). It asks for the team passcode.

**Without the GitHub CLI:** the script prints the values to add by hand. Add them under **Settings > Secrets and variables > Actions**:

| Type | Name | Value |
|---|---|---|
| Secret | `AWS_DEPLOY_ROLE_ARN` | The role ARN printed by the script |
| Secret | `PLAN_PASSCODE` | The team passcode (8 or more characters) |
| Variable | `AWS_REGION` | For example `eu-west-2` (optional, this is the default) |
| Variable | `STACK_NAME` | `lucky-resource-plan` (optional, this is the default) |

### 3. Deploy

Push any change to `main`, or open **Actions > Deploy to AWS > Run workflow**. When it finishes, the run summary shows the site address.

- **First run:** loads `seed/data.json` into the plan. Later runs skip this step because the plan already has data.
- **Already deployed with `deploy.sh`:** keep the same stack name. The workflow takes over that stack, and your data stays.

### Optional: require approval before each deployment

The workflow deploys from a GitHub environment called `production`. To have someone approve each deployment before it runs, go to **Settings > Environments > production** and add required reviewers.

If you rename the environment, change it in both places so they match:

- `environment:` in `.github/workflows/deploy.yml`
- the `GitHubEnvironment` setting of the deploy role (`infra/github-deploy-role.yaml`), then run `setup-github.sh` again

### Changing things later

- **Change the passcode:** update the `PLAN_PASSCODE` secret, then run the workflow.
- **Change the page:** edit `frontend/index.html` and push.
- **Remove automatic deployment:** delete the `lucky-resource-plan-github-role` stack in CloudFormation, and remove the two secrets.

### What the deploy role can do

The role can only manage resources whose names start with the stack name:

- the CloudFormation stack
- its Lambda function
- its DynamoDB table and site bucket
- its function role
- the SAM artifacts bucket

CloudFront and API Gateway permissions are account-wide, because their resource IDs aren't known until they are created.

The role can attach only the standard Lambda logging policy to the function role. It can, however, write the function role's inline policy. For the strongest separation, deploy into a dedicated AWS account.

## Using it

When the page first opens, it asks for the team passcode. The passcode is remembered in that browser. If someone cancels the prompt, the page opens in view-only mode.

The page works the same way as the Claude version. It has four tabs:

- **Resource plan:** weekly FTE per project row. You can type values, paste from Excel, or use Fill weeks.
- **Projects:** edit, add and delete projects, and manage categories.
- **Team:** manage people, locations and roles.
- **Allocation:** each person's total load per week. Weeks over 1.0 FTE show in red.

**Export to Excel** downloads the full plan as an `.xlsx` workbook.

## Security notes

- **Shared passcode, not personal logins.** The passcode protects the data from casual access. It is not a per-user login. For per-user sign-in, put the site behind your company SSO, for example:
  - CloudFront with Lambda@Edge and Amazon Cognito, or
  - an Application Load Balancer with OIDC.

  You can then set the passcode to a long random value that only the edge layer knows.
- **Where the passcode is kept.** It is stored as a Lambda environment variable, which is encrypted at rest. If you prefer, you can move it to AWS Secrets Manager.
- **Direct API access.** The API can also be reached directly at its `execute-api` address. It still requires the passcode.
- **Restricting by IP.** To limit access to your office network, attach an AWS WAF web ACL with an IP set to the CloudFront distribution.

## Backups and restore

- DynamoDB point-in-time recovery lets you restore the table to any second in the last 35 days. Use the DynamoDB console, under **Backups**.
- For a snapshot you can keep, use **Export to Excel** on the page.

## Cost

At team scale, this costs very little: typically well under US$5 a month. Most of that is CloudFront and DynamoDB requests, which are billed per use. There are no servers running.

## Removing it

```bash
sam delete --stack-name lucky-resource-plan --region eu-west-2
```

- **Site bucket:** empty it first (`aws s3 rm s3://<bucket> --recursive`), otherwise the delete fails.
- **DynamoDB table:** it is kept on purpose. Delete it in the console if you no longer need the data.
