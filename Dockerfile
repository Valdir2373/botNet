FROM node:18-alpine

WORKDIR /app

# Copiar arquivos de dependência
COPY package.json package-lock.json ./

# Instalar dependências
RUN npm install

# Copiar todo o projeto
COPY . .

# Copiar arquivo static public
COPY public /app/public

# Expor porta do servidor
EXPOSE 3000

# Rodar o servidor TypeScript diretamente com tsx
CMD ["npx", "tsx", "src/server/server.ts"]
