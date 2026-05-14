# Compose Manager

A GUI tool to manage Docker Compose projects on a remote server via SSH with optional jump host support.
Runs as a Docker container on your local machine.

## Setup

### 1. Create and edit `.env`

All runtime configuration is loaded from `.env` via `docker-compose.yml` (`env_file: .env`).
Set these variables:

#### Target Server (Direct SSH or via Jump Host)
| Variable | Example | Description |
|---|---|---|
| `SERVER_IP` | `1x.1x.x.x` | Target server's IP or hostname |
| `SERVER_USERNAME` | `ubuntu` | SSH username on target server |

#### Jump Host (Optional - for proxy SSH tunneling)
| Variable | Example | Description |
|---|---|---|
| `JUMP_HOST_IP` | `203.xxx.xx.xx` | Jump host IP (leave empty if direct SSH) |
| `JUMP_HOST_USER` | `ubuntu` | Jump host SSH username |
| `JUMP_HOST_PORT` | `2345` | Jump host SSH port |

#### Project Directories
| Variable | Example | Description |
|---|---|---|
| `PROJECTS_BASE_DIRS` | `/home/ubuntu/projects,/srv/Projects/` | Comma-separated list of directories containing your compose projects |

### 2. SSH Private Key Setup

You have **two options** to provide your SSH private key:

#### Option A: Mount the file (recommended)
```yaml
volumes:
  - ~/.ssh/id_rsa:/root/.ssh/id_rsa:ro
```

Test it first:
```bash
ssh -i ~/.ssh/id_rsa ubuntu@10.10.0.5
```

#### Option B: Pass via environment variable
Add your private key as `SSH_PRIVATE_KEY` in `.env`:

**For raw key content:**
```yaml
SSH_PRIVATE_KEY="-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
```

**For base64-encoded key:**
```bash
# Encode your key
base64 ~/.ssh/id_rsa | tr -d '\n'

# Copy the output and set in .env:
SSH_PRIVATE_KEY=LS0tLS1CRUdJTi...
```

#### Jump host connection test:
```bash
ssh -i ~/.ssh/id_rsa -J ubuntu@203.78.165.94:2345 ubuntu@10.10.0.5
```

### 3. Run it

```bash
docker compose up -d --build
```

Open http://localhost:3000 in your browser.

## How it works

- On load, it connects via SSH (with jump host if configured) and runs `find` to discover all `docker-compose.yml` / `compose.yml` files under all `PROJECTS_BASE_DIRS` (up to 3 levels deep)
- For each project, it checks running status via `docker compose ps`
- **Up** button → `docker compose up -d` (disabled if already running)
- **Down** button → `docker compose down` (disabled if already stopped)
- **≡** button → shows last 50 lines of logs
- All output streams live into the terminal drawer at the bottom

## Project structure requirements

Your VM folder structure should look something like:
```
/home/ubuntu/projects/
├── nginx/
│   └── docker-compose.yml
├── postgres/
│   └── docker-compose.yml
└── myapp/
    ├── docker-compose.yml
    └── .env
```

Any depth up to 3 levels is auto-discovered.
