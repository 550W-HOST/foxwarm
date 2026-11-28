{{- define "foxwarm.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "foxwarm.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "foxwarm.labels" -}}
app.kubernetes.io/name: {{ include "foxwarm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "foxwarm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "foxwarm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: replica
{{- end -}}

{{- define "foxwarm.image" -}}
{{- $repository := required "image.repository is required: the hosted image you built and pushed" .Values.image.repository -}}
{{- printf "%s:%s" $repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "foxwarm.runtimeSecret" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-runtime" (include "foxwarm.fullname" .)) -}}
{{- end -}}

{{- define "foxwarm.migrateSecret" -}}
{{- .Values.migrate.existingSecret | default (printf "%s-migrate" (include "foxwarm.fullname" .)) -}}
{{- end -}}

{{- define "foxwarm.s3" -}}
{{- eq (toString (dig "blobs" "backend" "" .Values.deployment)) "s3" -}}
{{- end -}}

{{/* The deployment configuration: the operator's keys plus the listener, health port and the
     mounted S3 credential files, which only the chart sets. */}}
{{- define "foxwarm.deploymentConfig" -}}
{{- $config := deepCopy .Values.deployment -}}
{{- if not (contains "{slug}" (default "" $config.url)) -}}
{{- fail "deployment.url must contain {slug} for tenant provisioning" -}}
{{- end -}}
{{- $bot := dig "bot" dict $config -}}
{{- $_ := set $bot "httpHost" "0.0.0.0" -}}
{{- $_ := set $bot "httpPort" (int .Values.ports.http) -}}
{{- $_ := set $config "bot" $bot -}}
{{- $_ := set $config "mesh" (dict "port" (int .Values.mesh.port)) -}}
{{- $_ := set $config "health" (dict "port" (int .Values.ports.health)) -}}
{{- if eq (include "foxwarm.s3" .) "true" -}}
{{- $s3 := dig "blobs" "s3" dict $config -}}
{{- $_ := required "deployment.blobs.s3.endpoint is required with the S3 backend" $s3.endpoint -}}
{{- $_ := required "deployment.blobs.s3.bucket is required with the S3 backend" $s3.bucket -}}
{{- $_ := set $s3 "accessKeyIdFile" "/run/secrets/foxwarm/s3-access-key-id" -}}
{{- $_ := set $s3 "secretAccessKeyFile" "/run/secrets/foxwarm/s3-secret-access-key" -}}
{{- $_ := set $config.blobs "s3" $s3 -}}
{{- else if hasKey $config "blobs" -}}
{{- /* The values' default S3 block doesn't apply to another backend. */ -}}
{{- $_ := unset $config.blobs "s3" -}}
{{- end -}}
{{- $_ := set $config "operator" (dict "url" (required "operator.url is required" .Values.operator.url) "port" (int .Values.operator.port)) -}}
{{- toYaml $config -}}
{{- end -}}

{{- define "foxwarm.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "foxwarm.containerSecurityContext" -}}
readOnlyRootFilesystem: true
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
{{- end -}}
