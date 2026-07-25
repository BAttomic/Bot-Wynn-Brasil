FROM node:22-alpine

WORKDIR /app

# Instala apenas as dependências de produção
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "src/index.js"]
