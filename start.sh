#!/bin/bash

# Quick start script for Yarnl

echo "🧶 Starting Yarnl..."

# Check if Node.js is installed
if ! command -v node &> /dev/null
then
    echo "❌ Node.js is not installed. Please install Node.js 18 or higher."
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Create uploads directory if it doesn't exist
mkdir -p uploads

echo "✅ Starting server on http://localhost:3000"
echo "   Press Ctrl+C to stop"
echo ""

# Start the server
npm start
