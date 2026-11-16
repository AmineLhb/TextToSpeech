FROM node:20-slim

# Install ffmpeg for Discord voice audio
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy bot code
COPY . .

# Hugging Face default port
EXPOSE 7860

CMD ["node", "index.js"]
