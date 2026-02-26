#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (use sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing base packages..."
apt-get update
apt-get install -y ca-certificates curl git

echo "[2/7] Configuring Docker apt repository..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list

echo "[3/7] Installing Docker engine + compose plugin..."
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

echo "[4/7] Installing BinaryLane Invoice Viewer files..."
rm -rf /opt/binarylane-invoice-viewer
git clone https://github.com/01ax/binarylane-enhanced-invoice-viewer.git /opt/binarylane-invoice-viewer
chmod +x /opt/binarylane-invoice-viewer/scripts/invoice-init

echo "[5/7] Installing invoice-init launcher..."
cat >/usr/local/bin/invoice-init <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/binarylane-invoice-viewer
exec ./scripts/invoice-init "$@"
EOF
chmod +x /usr/local/bin/invoice-init

echo "[6/7] Validating install..."
command -v docker >/dev/null
command -v invoice-init >/dev/null

echo "[7/7] Done."
echo "Run: invoice-init"
