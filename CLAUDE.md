# img64

POST a base64 image, get back a public CloudFront URL pointing at the decoded bytes. Used when a consumer system requires an `http(s)` image URL and won't accept a `data:` URI.

## Project layout

```
img64/
  index.ts             # Lambda handler (POST → S3 → CloudFront URL)
  package.json         # Node deps (@aws-sdk/client-s3 at runtime)
  tsconfig.json        # TS config (ES2020 / commonjs)
  build-lambda.sh      # Compile + zip with prod-only node_modules
  deploy-lambda-s3.sh  # Upload zip to S3 and update Lambda
```

Handler accepts POST only — JSON `{data, type?}`, a `data:` URI in `data`, or raw base64 in the body. SHA-256 of the decoded bytes (32 hex prefix) becomes the S3 key, giving free dedup.

## Deployed resources (account 763903610969)

| Resource | Region | Notes |
| --- | --- | --- |
| Lambda `img64` | us-west-2 | Node 20.x, arm64, 512 MB, 20s timeout, handler `index.handler` |
| IAM role `img64-lambda-role` | global | AWSLambdaBasicExecutionRole + inline `img64-s3-write` (PutObject on `arn:aws:s3:::big-buys-public/img64/*`) |
| HTTP API `umeu6ml921` (`img64`) | us-west-2 | `$default` route → Lambda proxy; stage `$default` throttled 20/40 rps; auto-deploy on |
| S3 bucket `big-buys-public` | us-west-1 | Lambda writes under `img64/`; public access blocked at bucket level |
| CloudFront `E26QSBDXVY9MGJ` (`d2le8l2yvdies6.cloudfront.net`) | global | Serves the bucket publicly with no origin path |

- Public endpoint: `POST https://umeu6ml921.execute-api.us-west-2.amazonaws.com/`
- Public URL pattern: `https://d2le8l2yvdies6.cloudfront.net/img64/<sha256-prefix>.<ext>`

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
