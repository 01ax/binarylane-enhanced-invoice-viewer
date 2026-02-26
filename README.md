# BinaryLane Invoice Viewer

Secure, self-hosted deployment package for the BinaryLane Invoice Viewer.

- App title/branding: **BinaryLane Invoice Viewer**
- Basic auth via Caddy (`admin` user, password set interactively)
- Dockerized deployment (host `29741` -> container `80`)
- GHCR image: `ghcr.io/01ax/binarylane-enhanced-invoice-viewer`
- Maintained by [01ax](https://github.com/01ax)

## Quick start (customer copy/paste)

### Option A: Cloud-init bootstrap on Ubuntu host

```bash
curl -fsSL https://raw.githubusercontent.com/01ax/binarylane-enhanced-invoice-viewer/main/cloud-init.yaml -o /tmp/binarylane-invoice-viewer-cloud-init.yaml
sudo cloud-init single --file /tmp/binarylane-invoice-viewer-cloud-init.yaml --name cc_runcmd
invoice-init
```

### Option B: Manual install on existing host

```bash
sudo apt-get update
sudo apt-get install -y git docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo git clone https://github.com/01ax/binarylane-enhanced-invoice-viewer.git /opt/binarylane-invoice-viewer
sudo chmod +x /opt/binarylane-invoice-viewer/scripts/invoice-init
cd /opt/binarylane-invoice-viewer
sudo ./scripts/invoice-init
```

After setup, access:

- `http://<server-ip>:29741`
- Username: `admin`
- Password: (the one you set in `invoice-init`)

## Update

```bash
cd /opt/binarylane-invoice-viewer
sudo git fetch --tags origin
sudo git pull --ff-only
sudo ./scripts/invoice-init
```

## Rollback

```bash
cd /opt/binarylane-invoice-viewer
sudo git fetch --tags origin
sudo git checkout v1.0.0
sudo ./scripts/invoice-init
```

## Development notes

- `scripts/invoice-init` never writes plaintext credentials.
- It hashes password with `caddy hash-password` inside the official Caddy container.
- Generated `Caddyfile` stores only bcrypt hash.
