# Kubernetes deployment

This base expects managed PostgreSQL, Redis, Temporal and S3-compatible storage. Replace the image names and hostnames in `base/`, create `socio-secrets` from an external secret manager (the example file is never included by Kustomize), then run the migration Job before the Deployments.

Remote browser traffic can land on any worker pod. `REMOTE_SESSION_REDIS_RELAY=true` enables the internal Redis relay so the pod that owns the Chromium session receives the commands without forwarding the access token.

Install metrics-server for the HPAs. In production, install Prometheus, Grafana and Loki through their maintained Helm charts, keep them private, and configure the API scrape with `Authorization: Service <CONTROL_API_KEY>`.
