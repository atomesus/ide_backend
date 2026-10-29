#!/usr/bin/env bash
# One-time setup for a fresh Amazon Linux 2023 EC2 instance that will serve
# https://ide-api.atomesus.com. Run as ec2-user:  bash setup-ec2.sh you@atomesus.com
# Needs the DNS record for ide-api.atomesus.com to point at this instance first
# (for the HTTPS certificate).
set -euo pipefail
EMAIL="${1:?usage: setup-ec2.sh <email for the HTTPS certificate>}"
DOMAIN="${DOMAIN:-ide-api.atomesus.com}"

echo "▶ Node 20, nginx, certbot"
sudo dnf install -y nginx git tar
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
sudo npm install -g pm2
sudo dnf install -y python3-pip
sudo pip3 install certbot certbot-nginx

echo "▶ nginx site for $DOMAIN"
sudo cp "$(dirname "$0")/nginx-ide-api.conf" /etc/nginx/conf.d/ide-api.conf
sudo sed -i "s/ide-api.atomesus.com/$DOMAIN/g" /etc/nginx/conf.d/ide-api.conf
sudo nginx -t
sudo systemctl enable --now nginx

echo "▶ HTTPS certificate"
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
echo "0 3 * * * root certbot renew --quiet && systemctl reload nginx" | sudo tee /etc/cron.d/certbot-renew > /dev/null

echo "▶ PM2 on boot"
mkdir -p /home/ec2-user/releases
pm2 startup systemd -u ec2-user --hp /home/ec2-user | tail -1 | sudo bash || true

if [ ! -f /home/ec2-user/ide-backend.env ]; then
  echo "⚠️  Now create /home/ec2-user/ide-backend.env (see deploy/README.md), chmod 600 it,"
  echo "   then run the 'Deploy IDE backend to EC2' workflow from GitHub Actions."
fi
echo "✅ Server ready"
