# img64

POST a base64 image, get back a public CloudFront URL pointing at the decoded PNG/JPEG/etc. — useful when a downstream system requires an `http(s)` image URL and won't accept a `data:` URI.

## Live endpoint

```
POST https://umeu6ml921.execute-api.us-west-2.amazonaws.com/
```

Public URLs are returned on the CloudFront distribution backing `s3://big-buys-public/img64/`:

```
https://d2le8l2yvdies6.cloudfront.net/img64/<sha256-prefix>.<ext>
```

## Request formats

The Lambda accepts three input shapes — pick whichever your caller produces.

### 1. JSON body (preferred)

```bash
curl -X POST https://umeu6ml921.execute-api.us-west-2.amazonaws.com/ \
  -H 'Content-Type: application/json' \
  -d '{"data":"iVBORw0KGgoAAAANSUhEUg...","type":"image/png"}'
```

`type` is optional — magic bytes are sniffed from the decoded data either way. Declared type is only used as a fallback when the bytes can't be sniffed (basically just SVG).

### 2. Data URI in `data`

```json
{"data":"data:image/png;base64,iVBORw0KGgo..."}
```

The MIME from the prefix is parsed and used as a hint; bytes still win.

### 3. Raw base64 in the body

```bash
curl -X POST https://umeu6ml921.execute-api.us-west-2.amazonaws.com/ \
  -H 'Content-Type: text/plain' \
  --data-binary @my-image.b64
```

## Response

```json
{
  "success": true,
  "url": "https://d2le8l2yvdies6.cloudfront.net/img64/b1ff9c8ea3a780bad09b346c423d2d0e.png",
  "key": "img64/b1ff9c8ea3a780bad09b346c423d2d0e.png",
  "contentType": "image/png",
  "byteLength": 69
}
```

The object key is the **first 32 hex chars of the SHA-256 of the decoded bytes**, plus an extension. Same image → same URL → free deduplication.

## Limits & safety

- Decoded image cap: 10 MB
- Allowed types: png, jpeg, gif, webp, svg+xml, bmp, ico, avif, tiff
- Magic-byte sniffing: the declared `type` is *never* trusted — the actual bytes are sniffed and the response always reflects the real format
- Stage throttling: 20 rps sustained / 40 burst
- CORS: open (`*`) — anyone can POST from a browser; abuse mitigated by throttling and the size cap

## Develop

```bash
npm install
./build-lambda.sh   # produces img64.zip
./deploy-lambda-s3.sh
```

Deploy script defaults — override with env vars:

- `IMG64_FUNCTION_NAME` (default: `img64`)
- `IMG64_REGION` (default: `us-west-2`)
- `IMG64_DEPLOY_BUCKET` (default: `mobile-lambda-deployments`)

Lambda runtime config (env vars on the function itself, all have sensible defaults):

- `IMG64_BUCKET` — S3 bucket (default `big-buys-public`)
- `IMG64_BUCKET_REGION` — S3 bucket region (default `us-west-1`)
- `IMG64_KEY_PREFIX` — object key prefix (default `img64/`)
- `IMG64_PUBLIC_URL_BASE` — CloudFront origin to prepend (default `https://d2le8l2yvdies6.cloudfront.net`)
- `IMG64_MAX_BYTES` — decoded image size cap

See [CLAUDE.md](./CLAUDE.md) for AWS auth/SSL conventions used by the deploy script.
