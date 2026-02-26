FROM caddy:2.8-alpine

WORKDIR /srv

COPY index.html /srv/index.html
COPY app.js /srv/app.js
COPY styles.css /srv/styles.css
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80
