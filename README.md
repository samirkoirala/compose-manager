# Compose Manager

Compose Manager is an open-source web UI for managing Docker Compose stacks on a remote server over SSH. It discovers compose projects, shows their status and ports, and lets you bring services up, down, or inspect logs from a clean browser interface.

## Features

- Discover `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml` files on remote servers.
- Manage multiple VMs or a single host from one dashboard.
- View running status, service counts, published ports, and port conflicts.
- Start and stop stacks with streaming terminal output.
- Inspect the last 50 log lines for any project.
- Run as a Docker container with a simple `docker compose up` workflow.

## Docker Hub Image

The published image name is:

`samirkoirala/compose-manager`

Versioning is automated by GitHub Actions:

- Each merge to `main` builds and pushes a new image.
- The workflow auto-increments the latest `vN` tag and publishes the next release as `vN+1`.
- The same release is also pushed as `latest` and as a commit-specific `sha-...` tag.

If the repository has no prior release tags, the workflow starts from the next integer version. With the existing `v1` Docker Hub tag, the next release will be `v2`.

## Quick Start

1. Create a `.env` file in the project root.
2. Configure your SSH credentials and target server.
3. Start the app.

```bash
docker compose up -d --build
```

Open `http://localhost:3000` in your browser.

## Configuration

All runtime configuration is loaded from `.env`.

### Server Connection

| Variable | Example | Description |
|---|---|---|
| `VM_SERVERS` | `10.x.x.x,10.x.x.x` | Optional comma-separated list of VMs shown in the dropdown. |
| `SERVER_IP` | `10.xx.xx.xx` | Fallback target server if `VM_SERVERS` is not set. |
| `SERVER_USERNAME` | `ubuntu` | SSH username on the target server. |
| `PORT` | `3000` | Local web port for the app container. |

### Jump Host

| Variable | Example | Description |
|---|---|---|
| `JUMP_HOST_IP` | `2x.xx.xxx.x` | Optional jump host IP or hostname. Leave empty for direct SSH. |
| `JUMP_HOST_USER` | `ubuntu` | SSH username for the jump host. |
| `JUMP_HOST_PORT` | `2345` | SSH port for the jump host. |

### Project Discovery

| Variable | Example | Description |
|---|---|---|
| `PROJECTS_BASE_DIRS` | `/home/ubuntu/projects,/srv/projects` | Comma-separated directories searched on the remote host. |

### SSH Key Options

You can provide the SSH private key in either of these ways:

#### Option A: Mount a file

```yaml
volumes:
  - ~/.ssh/id_rsa:/root/.ssh/id_rsa:ro
```

#### Option B: Use an environment variable

Set `SSH_PRIVATE_KEY` in `.env` with either raw key contents or a base64-encoded key.

## Local Development

```bash
docker compose up --build
```

The backend serves the frontend from `frontend/public`, so there is no separate build step for the UI.

## Repository Structure

```text
.
├── backend/
│   ├── package.json
│   └── server.js
├── frontend/
│   └── public/
│       └── index.html
├── Dockerfile
├── docker-compose.yml
├── LICENSE
└── README.md
```

## Release Workflow

The GitHub Actions workflow in `.github/workflows/docker-publish.yml` is responsible for:

- Building the Docker image.
- Pushing the image to Docker Hub.
- Publishing versioned tags such as `v2`, `v3`, and so on.
- Updating `latest` to always point at the newest release.

To enable publishing, add these repository secrets in GitHub:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

## Contributing

Pull requests and issues are welcome. Please keep changes focused and include enough detail for maintainers to review behavior changes quickly.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.