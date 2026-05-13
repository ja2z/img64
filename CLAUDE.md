# img64

A tiny AWS Lambda that fetches an image and returns an HTML `<img>` tag whose `src` is a `data:` URI containing the base64-encoded image. Useful when an embed environment needs a fully self-contained image (no external fetches).

## Project layout

```
img64/
  index.ts             # Lambda handler
  package.json         # Node deps
  tsconfig.json        # TS config (ES2020 / commonjs)
  build-lambda.sh      # Compile + zip
  deploy-lambda-s3.sh  # Upload zip to S3 and update Lambda
  test-event.json      # Sample API Gateway event for local invoke
```

The handler is API-Gateway-shaped: it reads `event.body` (POST) or `event.queryStringParameters` (GET) and returns a `{ statusCode, headers, body }` response with CORS headers. Node 18+ `fetch` is used directly — no extra HTTP dependency.

## Deployed resources (us-west-2, account 763903610969)

- Lambda function: `img64` (Node 20.x, arm64, 256 MB, 15s timeout, handler `index.handler`)
- IAM role: `img64-lambda-role` (AWSLambdaBasicExecutionRole attached)
- API Gateway HTTP API: `umeu6ml921` (`img64`) → `$default` route → Lambda proxy integration; `$default` stage throttled 20 rps / 40 burst, auto-deploy on
- Lambda resource policy `apigateway-invoke` allows `arn:aws:execute-api:us-west-2:763903610969:umeu6ml921/*/*` to invoke
- Public URL: `https://umeu6ml921.execute-api.us-west-2.amazonaws.com`

## AWS conventions (this org)

These mirror the rules in [/Users/jonathanavrach/code/mobile/.cursor/rules/aws-cli-usage.mdc](/Users/jonathanavrach/code/mobile/.cursor/rules/aws-cli-usage.mdc) — keep them in sync if anything diverges.

### Auth (SAML via Okta, expires every 1 hour)

```bash
export AWS_PROFILE=saml
export AWS_CA_BUNDLE=""
export PYTHONHTTPSVERIFY=0
```

Always pass `--no-verify-ssl` (corporate proxy intercepts TLS). Verify auth before any AWS call:

```bash
aws sts get-caller-identity --no-verify-ssl
```

If that errors with `ExpiredTokenException` / `Unable to locate credentials`, the user re-auths via Okta — you cannot do it for them.

### `aws_cmd` wrapper

Use this wrapper inside scripts so SSL flags + warnings are handled in one place:

```bash
aws_cmd() {
    aws "$@" --no-verify-ssl 2> >(grep -v "InsecureRequestWarning\|warnings.warn(" >&2)
}
```

### Account / region

- Account: `763903610969`
- Region: `us-west-2`
- Lambda deploy bucket: `mobile-lambda-deployments` (S3-based deploy is preferred — faster than direct zip upload for anything over a few MB)

### Build & deploy pattern (matches mobile lambdas)

1. `./build-lambda.sh` — clean, `npm install`, `tsc`, zip the result
2. `./deploy-lambda-s3.sh` — verify auth, upload zip to S3, call `lambda update-function-code --s3-bucket … --s3-key …`, then poll `LastUpdateStatus`

The zip must have `index.js` at the root (Lambda entrypoint convention).

### Granting Secrets Manager access

This project does not currently use Secrets Manager. If that changes, follow the pattern in `lambdas/generate-url/grant-secret-permissions.sh` in the mobile repo — find the Lambda role dynamically, fetch its inline `SecretsManagerAccess` policy, add the new secret ARN (use a `-*` wildcard suffix) to the `Resource` array, `put-role-policy`.

### Common failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ExpiredTokenException` | 1-hour SAML token expired | User re-auths via Okta |
| `SSL validation failed` | Missing env vars | Set `AWS_CA_BUNDLE=""`, `PYTHONHTTPSVERIFY=0`, use `--no-verify-ssl` |
| `AccessDenied` | Wrong role or missing policy | Check `aws lambda get-function-configuration --query Role`, inspect inline policies |
| Heredoc + pipe loses stdin in Python | Heredoc takes precedence over the pipe | Pass data via env vars (`POLICY=$(...) python3 <<'PY'` then `os.environ['POLICY']`) |
