# img64

AWS Lambda that fetches an image and returns an HTML `<img>` tag with a `data:` URI `src` — i.e. a fully inline, self-contained image element.

## Live endpoint

```
https://umeu6ml921.execute-api.us-west-2.amazonaws.com
```

Example:

```
curl 'https://umeu6ml921.execute-api.us-west-2.amazonaws.com/?url=https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png&format=html'
```

API Gateway HTTP API `umeu6ml921` (region `us-west-2`) → Lambda `img64`. Stage `$default` is throttled to 20 req/s sustained / 40 burst.

## API

Accepts `GET` (query params) or `POST` (JSON body).

| Param    | Required | Description                                                |
| -------- | -------- | ---------------------------------------------------------- |
| `url`    | yes      | `http(s)` URL of the image to inline                        |
| `alt`    | no       | `alt` attribute for the returned `<img>` tag                |
| `format` | no       | `json` (default) or `html` for raw `<img …/>` body          |

### Default JSON response

```json
{
  "success": true,
  "tag": "<img src=\"data:image/png;base64,iVBOR...\" />",
  "dataUri": "data:image/png;base64,iVBOR...",
  "contentType": "image/png",
  "byteLength": 12345
}
```

### Limits & safety

- Max image size: 10 MB (responses larger than ~6 MB will hit API Gateway's sync invoke cap regardless)
- Upstream fetch timeout: 8 s
- Allowed content types: png, jpeg, gif, webp, svg+xml, bmp, ico, avif, apng, tiff
- SSRF protection: the target hostname is DNS-resolved before fetch; any address in RFC1918, loopback, link-local (incl. `169.254.169.254`), or other reserved ranges is rejected with `400`

## Develop

```bash
npm install
npm run build      # tsc
./build-lambda.sh  # produces img64.zip
./deploy-lambda-s3.sh
```

Deploy script defaults — override with env vars:

- `IMG64_FUNCTION_NAME` (default: `img64`)
- `IMG64_REGION` (default: `us-west-2`)
- `IMG64_DEPLOY_BUCKET` (default: `mobile-lambda-deployments`)

See [CLAUDE.md](./CLAUDE.md) for AWS auth/SSL conventions used by the deploy script.

## Local invoke

```bash
aws lambda invoke \
    --function-name img64 \
    --region us-west-2 \
    --cli-binary-format raw-in-base64-out \
    --payload file://test-event.json \
    --no-verify-ssl \
    response.json
```
