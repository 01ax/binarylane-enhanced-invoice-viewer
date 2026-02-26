# BinaryLane Invoice Viewer

Secure, self-hosted deployment package for the BinaryLane Invoice Viewer.

- App title/branding: **BinaryLane Invoice Viewer**
- Basic auth via Caddy (`admin` user, password set interactively)
- Dockerized deployment (host `29741` -> container `80`)
- GHCR image: `ghcr.io/01ax/binarylane-enhanced-invoice-viewer`
- Maintained by [01ax](https://github.com/01ax)

## Install methods

### 1) Cloud-init (new server in BL portal)

- Create an Ubuntu 24.04 VPS
- Paste the contents of `cloud-init.yaml` into **User Data**
- After first login run:

```bash
invoice-init
```

### 2) One-liner installer script (existing server)

```bash
curl -fsSL https://raw.githubusercontent.com/01ax/binarylane-enhanced-invoice-viewer/main/install.sh | sudo bash
invoice-init
```

### 3) Manual install (existing server)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

sudo rm -rf /opt/binarylane-invoice-viewer
sudo git clone https://github.com/01ax/binarylane-enhanced-invoice-viewer.git /opt/binarylane-invoice-viewer
sudo chmod +x /opt/binarylane-invoice-viewer/scripts/invoice-init

cat <<'EOF' | sudo tee /usr/local/bin/invoice-init >/dev/null
#!/usr/bin/env bash
set -euo pipefail
cd /opt/binarylane-invoice-viewer
exec ./scripts/invoice-init "$@"
EOF
sudo chmod +x /usr/local/bin/invoice-init

invoice-init
```

## Access

After `invoice-init` completes:

- URL: `http://<server-ip>:29741`
- Username: `admin`
- Password: the one set in `invoice-init`

## Update

```bash
cd /opt/binarylane-invoice-viewer
sudo git fetch --tags origin
sudo git pull --ff-only
sudo invoice-init
```

## Rollback

```bash
cd /opt/binarylane-invoice-viewer
sudo git fetch --tags origin
sudo git checkout v1.0.0
sudo invoice-init
```

## Development notes

- `scripts/invoice-init` never writes plaintext credentials.
- It hashes password with `caddy hash-password` inside the official Caddy container.
- Generated `Caddyfile` stores only bcrypt hash.
