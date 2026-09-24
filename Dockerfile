# Duo-AI — образ для хостинга (RelaxDev / любой Docker-хостинг)
# Контейнер принимает трафик на порту из переменной PORT (платформа ставит 8080).
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Сначала манифесты — слой зависимостей кэшируется
COPY package.json package-lock.json* ./
# undici нужен только для исходящих через прокси платформы и стоит в optionalDependencies,
# поэтому сбой установки не должен ломать сборку.
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund --omit=optional

COPY . .

# Каталог для файла настроек (можно примонтировать томом)
RUN mkdir -p /app/data

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0

# Healthcheck: контейнер отдаёт /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
