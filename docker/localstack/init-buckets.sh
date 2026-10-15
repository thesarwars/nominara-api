#!/bin/bash
# Group C item 3 - runs inside the LocalStack container when it reports READY (mounted at
# /etc/localstack/init/ready.d/). Shared by docker-compose.yml and the testcontainers fixture
# (test/support/localstack-fixture.ts), so the buckets the tests use are the ones a developer gets.
#
# Names follow system-architecture.md section 8 (`nominara-raw`, `nominara-reports`); production's are
# `nominara-raw-{region}` / `nominara-reports-{region}`, which is why the names are configuration
# (STORAGE_BUCKET_RAW / STORAGE_BUCKET_REPORTS), never constants in code. Versioned, as the spec says all
# three buckets are. `nominara-static` (the CDN origin) is not an API concern and is not created.
set -euo pipefail

for bucket in nominara-raw nominara-reports; do
  awslocal s3api head-bucket --bucket "$bucket" 2>/dev/null || awslocal s3api create-bucket --bucket "$bucket"
  awslocal s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
done
echo "nominara buckets ready"
