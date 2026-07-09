# aws provider

One target, three substrates — routed by your manifest's own intent. You
never pick an AWS service; `type` and `public` already say what you mean:

| slab.toml | AWS substrate | endpoint | scale-to-zero |
|---|---|---|---|
| `type = "service"` (public) | **App Runner** | stable random `https://…awsapprunner.com` | `slab stop` pauses (compute → $0) |
| `type = "function"` | **Lambda** container + Function URL | stable random `https://…lambda-url…` | native — idle costs $0 |
| `public = false` | **Fargate** | task public IP (rotates) | `slab stop` → desiredCount 0 |

```bash
slab deploy ./myapp --target aws     # or target = "aws" in slab.toml
slab logs myapp                      # CloudWatch, transparently
slab stop / start / rm myapp
curl http://myapp.localhost:8080     # your local ingress fronts the aws endpoint
slab url myapp                       # or hit the https endpoint directly — no tunnels needed
```

> **Fargate (`public = false`) is BETA** — the isolation/systems story on
> AWS is unfinished; the "private" task still sits in your default VPC with
> a port-open security group. Treat it as a placeholder.

## images

Everything is built (or pulled) as **linux/amd64** and pushed to
`slab/<app>` in ECR — App Runner and Lambda can only pull from ECR, and
uniform arch means no platform surprises from arm64 laptops. Dockerfile
apps cross-build via Docker's emulation; `image =` apps are pulled amd64
and re-pushed.

## functions need the web adapter

Lambda runs containers that speak its runtime API — a plain web server
image needs the **AWS Lambda Web Adapter**, one line in the Dockerfile:

```dockerfile
COPY --from=public.ecr.aws/awsguru/aws-lambda-web-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
```

slab sets `PORT`/`AWS_LWA_PORT` to your manifest's port automatically.
Without the adapter the function deploys but every invoke fails — the
deploy prints a reminder.

## auth — your account, your identity, no stored keys

slab holds **no credentials**: it shells out to your own `aws` CLI
(configure / SSO / env vars / the **EC2 instance role** when the daemon
runs in EC2 — the credential chain just works). Optional
`~/.slab/providers.toml` (never secrets):

```toml
[aws]
region  = "us-east-1"
profile = "slab"      # omit for the default chain
cluster = "slab"      # fargate beta
cpu     = "256"       # fargate cpu units / lambda ignored
memory  = "512"       # fargate MB + lambda MB
```

Roadmap: native SDK implementation (no `aws` binary), same surface, IAM
node role as the credential source.

## what gets created (all in your account, all slab-prefixed)

- roles (service-principal trust only — **no cross-account / ExternalId**):
  `slabAppRunnerAccessRole` (ECR pull), `slabLambdaExecutionRole` (logs),
  `slabEcsExecutionRole` (fargate beta)
- ECR repo `slab/<app>` · App Runner service / Lambda function / ECS
  service named `slab-<app>` · CloudWatch log groups

`slab rm` deletes the service/function. Kept (pennies, useful history):
ECR repos, log groups, task definitions, the shared roles/cluster.

## cost, honestly

- **App Runner** (0.25 vCPU / 0.5 GB): ~$5–12/mo while active; **paused ≈ $0**
- **Lambda**: $0 idle; pennies per million requests + GB-seconds
- **Fargate beta**: ~$9/mo per always-on task; `slab stop` → ~$0
- ECR storage: pennies. Nothing here bills when removed.

## v1 limits

- jobs / systems / postgres refuse with clear errors
- Lambda: 15-min max request, no websockets on Function URLs, cold starts
- App Runner: first create takes ~3–5 minutes (updates are faster)
- Fargate beta: default VPC only, endpoint rotates with the task

## full cleanup

```bash
slab rm <app>                        # per app: deletes the service/function
aws ecr delete-repository --repository-name slab/<app> --force
aws logs delete-log-group --log-group-name /aws/lambda/slab-<app>   # or /slab/<app>
# shared, once nothing uses them:
aws ecs delete-cluster --cluster slab
aws iam detach-role-policy --role-name slabEcsExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy && aws iam delete-role --role-name slabEcsExecutionRole
aws iam detach-role-policy --role-name slabLambdaExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole && aws iam delete-role --role-name slabLambdaExecutionRole
aws iam detach-role-policy --role-name slabAppRunnerAccessRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess && aws iam delete-role --role-name slabAppRunnerAccessRole
```
