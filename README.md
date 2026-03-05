# BinaryLane Invoice Viewer

Secure, self-hosted deployment package for the Enhanced BinaryLane Invoice Viewer.

- App title/branding: **BinaryLane Invoice Viewer**
- Basic auth via Caddy (`admin` user, password set interactively)
- Dockerized deployment (host `29741` -> container `80`)
- GHCR image: `ghcr.io/01ax/binarylane-enhanced-invoice-viewer`
- Maintained by [01ax](https://github.com/01ax)

**Invoice viewer:**

<img width="1011" height="1229" alt="image" src="https://github.com/user-attachments/assets/5644369d-b3fc-4fea-9c6a-dbaa9e12b5d4" />

**Service breakdown:**

<img width="1012" height="1110" alt="image" src="https://github.com/user-attachments/assets/08e8b7b5-ea22-4e57-b4d6-ff89678141ab" />

The BinaryLane Enhanced Invoice Viewer is an invoice analysis/reporting tool for BinaryLane invoice data. It gives a clearer breakdown of costs than a raw invoice view, with a focus on readability and tax correctness.

##What it does

    Presents invoice data in a more usable dashboard-style view
    Adds GST-aware calculations at line/group level
    Uses fail-closed reconciliation rules so totals don’t silently drift if something doesn’t reconcile cleanly
    Marks GST-inclusive values with a small † and tooltip detail (before tax / GST / after tax)
    Improves analytics readability across time ranges (better month/year labeling, better panel behavior)

##Key benefits

    Faster cost understanding: less manual cross-checking
    Higher confidence in totals: safer GST handling + reconciliation guardrails
    Cleaner reporting UX: easier for ops/support/billing users to scan trends
    Practical deployment: packaged as OSS with multiple install paths (cloud-init, one-liner, manual), so it’s easier to roll out where needed

---

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
