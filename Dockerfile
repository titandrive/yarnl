FROM node:18-alpine

WORKDIR /app

# Install poppler-utils for PDF processing
RUN apk add --no-cache poppler-utils

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
