# Etapa 1: Python genera el sitio desde los Excel (HPM, troubleshooting, KPI). Etapa 2: solo Node con el sitio ya hecho.
FROM python:3.12-slim AS sitio
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY build.py estaciones_admin.json ./
COPY templates templates
COPY HPM HPM
COPY troubleshooting troubleshooting
COPY ["Maintenance 2026", "Maintenance 2026"]
# Render pasa las variables de entorno del servicio como build args: la URL pública va dentro de los QR
ARG BASE_URL
ARG RENDER_EXTERNAL_URL
RUN python build.py

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY templates/andon.js templates/asistente.js templates/
COPY --from=sitio /app/_site _site
# corre como root a propósito: el disco persistente de Render se monta en /app/data con dueño root
EXPOSE 10000
CMD ["node", "server.js"]
