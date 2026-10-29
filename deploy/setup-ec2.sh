#!/usr/bin/env bash
# One-time setup for a fresh EC2 instance (Ubuntu 22.04/24.04 or Amazon Linux 2023)
# that will serve https://ide-api.atomesus.com. Run as the login user (ubuntu or ec2-user):
#   bash setup-ec2.sh                      # Node 20, PM2, nginx (HTTP only)
#   bash setup-ec2.sh you@atomesus.com     # ...plus the HTTPS certificate
# The certificate step needs the DNS record for the domain to point at this instance.
set -euo pipefail
EMAIL="${1:-}"
DOMAIN="${DOMAIN:-ide-api.atomesus.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if command -v apt-get > /dev/null; then
  echo "▶ Ubuntu: Node 20, nginx, certbot"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg nginx tar
  if ! node -v 2>/dev/null | grep -q '^v20\.'; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
  SITE=/etc/nginx/sites-available/ide-api
  sudo cp "$HERE/nginx-ide-api.conf" "$SITE"
  sudo ln -sfn "$SITE" /etc/nginx/sites-enabled/ide-api
  sudo rm -f /etc/nginx/sites-enabled/default
else
  echo "▶ Amazon Linux: Node 20, nginx, certbot"
  sudo dnf install -y nginx tar
  if ! node -v 2>/dev/null | grep -q '^v20\.'; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo dnf install -y nodejs
  fi
  sudo dnf install -y python3-pip && sudo pip3 install certbot certbot-nginx
  SITE=/etc/nginx/conf.d/ide-api.conf
  sudo cp "$HERE/nginx-ide-api.conf" "$SITE"
fi
sudo sed -i "s/ide-api.atomesus.com/$DOMAIN/g" "$SITE"

# The domain is proxied by Cloudflare: take the client address from CF-Connecting-IP,
# but only when the request really comes from a Cloudflare edge range.
{ echo "# Cloudflare edge ranges (https://www.cloudflare.com/ips); rerun setup to refresh."
  for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do echo "set_real_ip_from $ip;"; done
  echo "real_ip_header CF-Connecting-IP;"; } | sudo tee /etc/nginx/conf.d/cloudflare-realip.conf > /dev/null
command -v pm2 > /dev/null || sudo npm install -g pm2
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

if [ -n "$EMAIL" ]; then
  echo "▶ HTTPS certificate for $DOMAIN"
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
fi

echo "▶ PM2 on boot"
mkdir -p "$HOME/releases"
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" > /dev/null

[ -f "$HOME/ide-backend.env" ] || echo "⚠️  Create $HOME/ide-backend.env (chmod 600) before the first deploy (deploy/README.md)."
echo "✅ Server ready"
