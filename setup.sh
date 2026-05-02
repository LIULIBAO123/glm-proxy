#!/bin/bash
# GLM Proxy - One-click deployment script
# Usage: curl -fsSL https://raw.githubusercontent.com/LIULIBAO123/glm-proxy/main/setup.sh | bash

set -e

INSTALL_DIR="/opt/glm-proxy"
REPO_URL="https://github.com/LIULIBAO123/glm-proxy.git"
DOMAIN="www.revan2001.shop"

echo "==========================================="
echo "  GLM Proxy - One-click Deployment"
echo "==========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup.sh"
  exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "[*] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

NODE_VER=$(node --version)
echo "[OK] Node.js: $NODE_VER"

# Clone or update repo
if [ -d "$INSTALL_DIR" ]; then
  echo "[*] Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only 2>/dev/null || true
else
  echo "[*] Cloning repository..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Interactive configuration
echo ""
echo "==========================================="
echo "  Configuration"
echo "==========================================="
echo ""

if [ -f "$INSTALL_DIR/.env" ]; then
  echo "[!] .env already exists. Overwrite? (y/N)"
  read -r OVERWRITE
  if [ "$OVERWRITE" != "y" ] && [ "$OVERWRITE" != "Y" ]; then
    echo "[*] Keeping existing .env"
    SKIP_ENV=true
  fi
fi

if [ "$SKIP_ENV" != "true" ]; then
  # API Key
  echo "Set API_KEY (for authenticating external requests):"
  echo "  Leave empty = no authentication required"
  read -rp "  API_KEY: " INPUT_API_KEY

  # Dashboard password
  echo ""
  echo "Set DASHBOARD_PASSWORD (for web management panel):"
  echo "  Leave empty = no password required"
  read -rp "  DASHBOARD_PASSWORD: " INPUT_DASH_PASS

  # Port
  echo ""
  read -rp "  PORT [3003]: " INPUT_PORT
  INPUT_PORT=${INPUT_PORT:-3003}

  # Default model
  echo ""
  read -rp "  DEFAULT_MODEL [glm-4-flash]: " INPUT_MODEL
  INPUT_MODEL=${INPUT_MODEL:-glm-4-flash}

  # Write .env
  cat > "$INSTALL_DIR/.env" <<EOF
PORT=${INPUT_PORT}
HOST=0.0.0.0
API_KEY=${INPUT_API_KEY}
DASHBOARD_PASSWORD=${INPUT_DASH_PASS}
DEFAULT_MODEL=${INPUT_MODEL}
MAX_TOKENS=4096
LOG_LEVEL=info
DATA_DIR=./data
EOF

  echo ""
  echo "[OK] .env written"
fi

# Create data directory
mkdir -p "$INSTALL_DIR/data"

# Install systemd service
echo ""
echo "[*] Installing systemd service..."
cat > /etc/systemd/system/glm-proxy.service <<EOF
[Unit]
Description=GLM Proxy - Multi-account API load balancer
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable glm-proxy
systemctl restart glm-proxy

echo "[OK] Service installed and started"

# Setup nginx + SSL (optional)
echo ""
echo "==========================================="
echo "  HTTPS Setup (optional)"
echo "==========================================="
echo ""
echo "Setup nginx + Let's Encrypt for $DOMAIN? (y/N)"
read -r SETUP_HTTPS

if [ "$SETUP_HTTPS" = "y" ] || [ "$SETUP_HTTPS" = "Y" ]; then
  # Install nginx and certbot
  apt-get update -qq
  apt-get install -y nginx certbot python3-certbot-nginx

  # Write nginx config
  cat > /etc/nginx/sites-available/glm-proxy <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:${INPUT_PORT:-3003};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
NGINX

  ln -sf /etc/nginx/sites-available/glm-proxy /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  echo "[*] Getting SSL certificate..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@${DOMAIN#www.} || {
    echo "[!] Certbot failed. You can run it manually later:"
    echo "    certbot --nginx -d $DOMAIN"
  }

  echo "[OK] HTTPS configured"
fi

# Done
echo ""
echo "==========================================="
echo "  Deployment Complete!"
echo "==========================================="
echo ""
echo "  Service status: systemctl status glm-proxy"
echo "  View logs:      journalctl -u glm-proxy -f"
echo ""
echo "  Local access:   http://localhost:${INPUT_PORT:-3003}/"
if [ "$SETUP_HTTPS" = "y" ] || [ "$SETUP_HTTPS" = "Y" ]; then
  echo "  Public access:  https://$DOMAIN/"
  echo "  API endpoint:   https://$DOMAIN/v1/chat/completions"
else
  echo "  Public access:  http://YOUR_SERVER_IP:${INPUT_PORT:-3003}/"
  echo "  API endpoint:   http://YOUR_SERVER_IP:${INPUT_PORT:-3003}/v1/chat/completions"
fi
echo ""
echo "  Next: Open the dashboard to add GLM API keys"
echo "==========================================="
