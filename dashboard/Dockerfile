FROM node:24-bookworm-slim

WORKDIR /app

# App code is baked into the image; the database and logs live on the host and
# are bind-mounted at /data, so rebuilding never touches them.
COPY package.json package-lock.json ./
# undici is required for the egress proxy (warp/tor modes); plain fetch keeps
# working when the optional install fails, so do not fail the image over it.
RUN npm ci --omit=dev || npm install --omit=dev || true
COPY server.mjs ./
COPY tools ./tools
COPY public ./public

ENV NODE_ENV=production \
    PORT=3100 \
    DASHBOARD_DB=/data/dashboard.sqlite \
    DASHBOARD_LOG_DIR=/data/logs

EXPOSE 3100

# login.html needs no session, so this works while /api/* requires a password.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/login.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
