#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID before running this script}"

GITHUB_REPOSITORY_NAME="${GITHUB_REPOSITORY_NAME:-Gitarzysta92/news-feed-concierge}"
GCP_REGION="${GCP_REGION:-europe-central2}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-news-feed-concierge}"
CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-news-feed-concierge}"
DEPLOYER_SERVICE_ACCOUNT_ID="${DEPLOYER_SERVICE_ACCOUNT_ID:-news-feed-concierge-deployer}"
RUNTIME_SERVICE_ACCOUNT_ID="${RUNTIME_SERVICE_ACCOUNT_ID:-news-feed-concierge-runtime}"
WORKLOAD_IDENTITY_POOL_ID="${WORKLOAD_IDENTITY_POOL_ID:-news-feed-concierge}"
WORKLOAD_IDENTITY_PROVIDER_ID="${WORKLOAD_IDENTITY_PROVIDER_ID:-github}"
CODEX_GATEWAY_SECRET="${CODEX_GATEWAY_SECRET:-codex-gateway-api-token}"
CODEX_GATEWAY_SECRET_SOURCE_PROJECT="${CODEX_GATEWAY_SECRET_SOURCE_PROJECT:-}"

DEPLOYER_SERVICE_ACCOUNT="${DEPLOYER_SERVICE_ACCOUNT_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

retry() {
  local attempt

  for attempt in {1..12}; do
    if "$@"; then
      return 0
    fi

    if [[ "${attempt}" -lt 12 ]]; then
      echo "Command failed while Google Cloud propagates IAM; retrying (${attempt}/12)..." >&2
      sleep 5
    fi
  done

  return 1
}

gcloud config set project "${GCP_PROJECT_ID}"
gcloud services enable \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  sts.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"

if ! gcloud artifacts repositories describe "${ARTIFACT_REPOSITORY}" \
  --location="${GCP_REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${ARTIFACT_REPOSITORY}" \
    --location="${GCP_REGION}" \
    --repository-format=docker \
    --description="News Feed Concierge container images"
fi

if ! gcloud iam service-accounts describe "${DEPLOYER_SERVICE_ACCOUNT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${DEPLOYER_SERVICE_ACCOUNT_ID}" \
    --display-name="News Feed Concierge GitHub deployer"
fi

if ! gcloud iam service-accounts describe "${RUNTIME_SERVICE_ACCOUNT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${RUNTIME_SERVICE_ACCOUNT_ID}" \
    --display-name="News Feed Concierge Cloud Run runtime"
fi

retry gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role=roles/run.admin \
  --condition=None >/dev/null

retry gcloud artifacts repositories add-iam-policy-binding "${ARTIFACT_REPOSITORY}" \
  --location="${GCP_REGION}" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role=roles/artifactregistry.writer \
  --condition=None >/dev/null

retry gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SERVICE_ACCOUNT}" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role=roles/iam.serviceAccountUser \
  --condition=None >/dev/null

if ! gcloud secrets describe "${CODEX_GATEWAY_SECRET}" >/dev/null 2>&1; then
  gcloud secrets create "${CODEX_GATEWAY_SECRET}" --replication-policy=automatic
fi

retry gcloud secrets add-iam-policy-binding "${CODEX_GATEWAY_SECRET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role=roles/secretmanager.secretAccessor \
  --condition=None >/dev/null

retry gcloud secrets add-iam-policy-binding "${CODEX_GATEWAY_SECRET}" \
  --member="serviceAccount:${DEPLOYER_SERVICE_ACCOUNT}" \
  --role=roles/secretmanager.secretAccessor \
  --condition=None >/dev/null

if [[ -z "$(gcloud secrets versions list "${CODEX_GATEWAY_SECRET}" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]]; then
  if [[ -n "${CODEX_GATEWAY_API_TOKEN:-}" ]]; then
    printf '%s' "${CODEX_GATEWAY_API_TOKEN}" | \
      gcloud secrets versions add "${CODEX_GATEWAY_SECRET}" --data-file=- >/dev/null
  elif [[ -n "${CODEX_GATEWAY_SECRET_SOURCE_PROJECT}" ]]; then
    gcloud secrets versions access latest \
      --project="${CODEX_GATEWAY_SECRET_SOURCE_PROJECT}" \
      --secret="${CODEX_GATEWAY_SECRET}" | \
      gcloud secrets versions add "${CODEX_GATEWAY_SECRET}" --data-file=- >/dev/null
  fi
fi

if ! gcloud iam workload-identity-pools describe "${WORKLOAD_IDENTITY_POOL_ID}" \
  --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${WORKLOAD_IDENTITY_POOL_ID}" \
    --location=global \
    --display-name="NFC GitHub Actions"
fi

if ! gcloud iam workload-identity-pools providers describe "${WORKLOAD_IDENTITY_PROVIDER_ID}" \
  --location=global \
  --workload-identity-pool="${WORKLOAD_IDENTITY_POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "${WORKLOAD_IDENTITY_PROVIDER_ID}" \
    --location=global \
    --workload-identity-pool="${WORKLOAD_IDENTITY_POOL_ID}" \
    --display-name="GitHub news-feed-concierge" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${GITHUB_REPOSITORY_NAME}' && assertion.ref == 'refs/heads/main'"
fi

POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_IDENTITY_POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${WORKLOAD_IDENTITY_PROVIDER_ID}"

retry gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SERVICE_ACCOUNT}" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${GITHUB_REPOSITORY_NAME}" \
  --condition=None >/dev/null

if [[ -z "$(gcloud secrets versions list "${CODEX_GATEWAY_SECRET}" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]]; then
  echo "Warning: ${CODEX_GATEWAY_SECRET} has no enabled version." >&2
  echo "Set CODEX_GATEWAY_API_TOKEN and run this script again before deploying." >&2
fi

cat <<EOF

Google Cloud bootstrap complete.

Configure these GitHub production environment variables:
GCP_PROJECT_ID=${GCP_PROJECT_ID}
GCP_REGION=${GCP_REGION}
GCP_ARTIFACT_REPOSITORY=${ARTIFACT_REPOSITORY}
GCP_CLOUD_RUN_SERVICE=${CLOUD_RUN_SERVICE}
GCP_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SERVICE_ACCOUNT}
GCP_WORKLOAD_IDENTITY_PROVIDER=${PROVIDER_NAME}
GCP_DEPLOYER_SERVICE_ACCOUNT=${DEPLOYER_SERVICE_ACCOUNT}
GCP_CODEX_GATEWAY_SECRET=${CODEX_GATEWAY_SECRET}
EOF
