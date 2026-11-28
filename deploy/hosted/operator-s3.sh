#!/bin/sh
# One-shot setup for the bundled VersityGW backend. Only this job receives both identities.
set -eu
endpoint=${S3_ENDPOINT:-http://versitygw:7070}
secrets=${SECRETS_DIR:-/run/secrets}
policy=${POLICY_FILE:-/setup/operator-s3-policy.json}
access=$(cat "$secrets/s3-access-key-id")
secret=$(cat "$secrets/s3-secret-access-key")
user=$(cat "$secrets/operator-s3-access-key-id")
password=$(cat "$secrets/operator-s3-secret-access-key")
[ "$user" = foxwarm-operator-delete ] || { echo 'Unexpected operator S3 account.' >&2; exit 1; }
case $password in ''|*[!a-f0-9]*) echo 'Expected a generated operator S3 password.' >&2; exit 1;; esac
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
signed() {
  printf 'user = "%s:%s"\n' "$access" "$secret" | curl --config - --silent --show-error --retry 8 --retry-connrefused --retry-delay 1 \
    --aws-sigv4 'aws:amz:us-east-1:s3' --output "$work/response" --write-out '%{http_code}' "$@"
}
printf '<Account><Access>%s</Access><Secret>%s</Secret><Role>user</Role></Account>' "$user" "$password" > "$work/account"
status=$(signed -X PATCH -H 'Content-Type: application/xml' --data-binary "@$work/account" "$endpoint/create-user")
case $status in 2??) ;; *) grep -q '<Code>XAdminUserExists</Code>' "$work/response" || { echo "Cannot create the operator S3 account (HTTP $status)." >&2; exit 1; };; esac
status=$(signed "$endpoint/foxwarm?policy")
case $status in
  404) grep -q 'NoSuchBucketPolicy' "$work/response" || { echo 'The S3 bucket is missing.' >&2; exit 1; }
       status=$(signed -X PUT -H 'Content-Type: application/json' --data-binary "@$policy" "$endpoint/foxwarm?policy")
       case $status in 2??) ;; *) echo "Cannot install the operator bucket policy (HTTP $status)." >&2; exit 1;; esac;;
  200) : ;; # Preserve existing bucket policies. Verify access with the dedicated identity below.
  *) echo "Cannot read the bucket policy (HTTP $status)." >&2; exit 1;;
esac
access=$user; secret=$password
for query in 'versioning' 'list-type=2&prefix=t%2F&max-keys=1'; do
  status=$(signed "$endpoint/foxwarm?$query")
  [ "$status" = 200 ] || { echo "Operator S3 access was refused (HTTP $status). Merge the operator statements into the bucket policy." >&2; exit 1; }
done
