FROM node:18-alpine

WORKDIR /app

# Install poppler-utils for PDF processing and timezone data
RUN apk add --no-cache poppler-utils tzdata

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Default environment
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
