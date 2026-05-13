#!/bin/bash

# Deploy script: uploads img64.zip to S3 and points the Lambda at the new object.
# Mirrors the mobile-app S3-based deploy pattern.

set -e

export AWS_PROFILE=saml
export AWS_CA_BUNDLE=""
export PYTHONHTTPSVERIFY=0

aws_cmd() {
    aws "$@" --no-verify-ssl 2> >(grep -v "InsecureRequestWarning\|warnings.warn(" >&2)
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FUNCTION_NAME="${IMG64_FUNCTION_NAME:-img64}"
REGION="${IMG64_REGION:-us-west-2}"
S3_BUCKET="${IMG64_DEPLOY_BUCKET:-mobile-lambda-deployments}"
S3_KEY="img64/${FUNCTION_NAME}-$(date +%Y%m%d-%H%M%S).zip"
ZIP_FILE="img64.zip"

echo "🔐 Checking AWS authentication..."
if ! aws_cmd sts get-caller-identity --query 'Account' --output text > /dev/null 2>&1; then
    echo "✗ ERROR: AWS CLI not authenticated"
    echo "   Run: export AWS_PROFILE=saml"
    echo "   Then re-authenticate via Okta/SAML"
    exit 1
fi
echo "✓ AWS CLI authenticated"
echo ""

if [ ! -f "$ZIP_FILE" ]; then
    echo "❌ Error: $ZIP_FILE not found — run ./build-lambda.sh first"
    exit 1
fi

echo "📦 Checking S3 bucket: $S3_BUCKET"
if ! aws_cmd s3 ls "s3://${S3_BUCKET}" > /dev/null 2>&1; then
    echo "   Bucket doesn't exist, creating..."
    aws_cmd s3 mb "s3://${S3_BUCKET}" --region "$REGION"
    echo "   ✓ Bucket created"
else
    echo "   ✓ Bucket exists"
fi
echo ""

echo "📤 Uploading $ZIP_FILE to s3://${S3_BUCKET}/${S3_KEY}"
aws_cmd s3 cp "$ZIP_FILE" "s3://${S3_BUCKET}/${S3_KEY}"
echo "   ✓ Upload complete"
echo ""

echo "🚀 Updating Lambda function: $FUNCTION_NAME"
aws_cmd lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --s3-bucket "$S3_BUCKET" \
    --s3-key "$S3_KEY" \
    --query '[FunctionName,CodeSha256,LastUpdateStatus]' \
    --output table

echo ""
echo "⏳ Waiting for deployment to complete..."
sleep 3

STATUS=$(aws_cmd lambda get-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query 'LastUpdateStatus' \
    --output text)

if [ "$STATUS" = "Successful" ]; then
    echo "✅ Deployment successful!"
elif [ "$STATUS" = "InProgress" ]; then
    echo "⏳ Deployment in progress — check with:"
    echo "   aws lambda get-function-configuration --function-name $FUNCTION_NAME --query LastUpdateStatus"
else
    echo "⚠️  Deployment status: $STATUS"
fi
