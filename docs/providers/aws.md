# aws provider (v1 — services)

Run slab apps on **ECS Fargate** in your own AWS account: image built
locally, pushed to ECR, one task definition + service per app, logs in
CloudWatch, and your local ingress fronts the task —
`http://<app>.localhost:8080` keeps working.

```bash
slab deploy ./myapp --target aws        # or target = "aws" in slab.toml
slab logs myapp                         # CloudWatch, transparently
slab stop myapp · slab start myapp      # desiredCount 0/1
slab rm myapp                           # deletes the service
```

## auth — your account, your identity, no stored keys

slab holds **no credentials**. The provider shells out to your own `aws`
CLI, so every call runs as whatever identity you already have:

- `aws configure` keys or an SSO profile on a laptop
- the **IAM instance role** when the daemon runs on EC2 — the credential
  chain resolves it automatically; nothing to configure at all

Optional config (never secrets) in `~/.slab/providers.toml`:

```toml
[aws]
region  = "us-east-1"
profile = "slab"        # omit to use the default credential chain
cluster = "slab"        # ECS cluster name
cpu     = "256"         # fargate task size
memory  = "512"
```

## prerequisites

- `aws` CLI v2 installed and credentialed (`aws sts get-caller-identity`
  answers)
- Docker locally (slab builds and pushes the image)
- a default VPC in the region (v1 uses it; custom VPCs later)

## what gets created (all in your account, all `slab`-prefixed)

| resource | name | shared / per-app |
|---|---|---|
| ECS cluster | `slab` | shared |
| IAM role | `slabEcsExecutionRole` (pull ECR, write logs) | shared |
| security group | `slab-<port>` (tcp `<port>` from 0.0.0.0/0) | per port |
| ECR repo | `slab/<app>` | per app |
| log group | `/slab/<app>` | per app |
| task definition | `slab-<app>` (new revision per deploy) | per app |
| ECS service | `slab-<app>` (Fargate, public IP) | per app |

`slab rm` deletes the **service**. Kept on purpose (pennies, useful
history): the ECR repo, log group, task definitions, and the shared
cluster/role/SG — one-line cleanups are listed below.

## permissions the operator identity needs

ECS (clusters/task-definitions/services/tasks), ECR (create/describe/push),
CloudWatch Logs (create/read), EC2 describe (VPC/subnets/ENIs) +
security-group create/authorize, `iam:GetRole/CreateRole/AttachRolePolicy/PassRole`
on `slabEcsExecutionRole`, `sts:GetCallerIdentity`. Admin works; a
least-privilege managed policy is on the roadmap alongside the native-SDK
implementation (same Provider surface, no CLI dependency, IAM node role as
the credential source).

## cost, honestly

A 0.25 vCPU / 512 MB Fargate task ≈ **$9–10/month if left running 24/7**
(plus pennies of ECR storage). `slab stop` drops it to ~$0. There is no
scale-to-zero on this target yet — do not deploy-and-forget. TTL/budget
guardrails (roadmap #4) will be enforced for cloud targets.

## v1 limits

- **services only** — functions run as always-on services (warned),
  jobs/systems/postgres refuse with clear errors
- endpoint = the task's **public IP**, which changes when the task is
  replaced; `slab start`/redeploy/daemon-boot refresh it
- the security group is open to the internet on the app port (it's a
  public service); private-by-default networking arrives with systems
  support
- default VPC only

## full cleanup

```bash
slab rm <app>
aws ecr delete-repository --repository-name slab/<app> --force
aws logs delete-log-group --log-group-name /slab/<app>
# shared, once nothing uses them:
aws ecs delete-cluster --cluster slab
aws iam detach-role-policy --role-name slabEcsExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name slabEcsExecutionRole
```
