#!/bin/bash

# LinkBy6 Stripe Server Deployment Helper
# This script helps you deploy the Stripe server to Render.com

set -e

echo "🚀 LinkBy6 Stripe Server Deployment Helper"
echo "=========================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the stripe-server directory."
    exit 1
fi

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found."
    echo "📝 Please create a .env file based on .env.example before deploying."
    echo ""
    echo "Required environment variables:"
    echo "- STRIPE_SECRET_KEY"
    echo "- STRIPE_WEBHOOK_SECRET"
    echo "- STRIPE_PRICE_* (all 6 price IDs)"
    echo "- SUPABASE_URL (optional)"
    echo "- SUPABASE_SERVICE_KEY (optional)"
    echo ""
    read -p "Do you want to continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "🔍 Pre-deployment Checklist:"
echo "=============================="

# Check Node.js version
NODE_VERSION=$(node --version)
echo "✅ Node.js version: $NODE_VERSION"

# Check if dependencies are installed
if [ -d "node_modules" ]; then
    echo "✅ Dependencies installed"
else
    echo "📦 Installing dependencies..."
    npm install
    echo "✅ Dependencies installed"
fi

# Test the server locally
echo ""
echo "🧪 Testing server locally..."
echo "=============================="

# Start server in background for testing
npm start &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Test health endpoint
if curl -s http://localhost:3000/health > /dev/null; then
    echo "✅ Health check passed"
else
    echo "❌ Health check failed"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Stop test server
kill $SERVER_PID 2>/dev/null || true
sleep 1

echo ""
echo "🎯 Deployment Instructions:"
echo "============================"
echo ""
echo "1. 📁 Create a GitHub repository for your server code"
echo "2. 📤 Push this code to your GitHub repository:"
echo "   git init"
echo "   git add ."
echo "   git commit -m 'Initial Stripe server setup'"
echo "   git remote add origin https://github.com/yourusername/linkby6-stripe-server.git"
echo "   git push -u origin main"
echo ""
echo "3. 🌐 Deploy to Render.com:"
echo "   - Go to https://dashboard.render.com"
echo "   - Click 'New +' → 'Web Service'"
echo "   - Connect your GitHub repository"
echo "   - Use these settings:"
echo "     * Name: linkby6-stripe-server"
echo "     * Environment: Node"
echo "     * Build Command: npm install"
echo "     * Start Command: npm start"
echo "     * Health Check Path: /health"
echo ""
echo "4. 🔧 Add Environment Variables in Render:"
echo "   Copy the variables from your .env file to Render's environment variables section"
echo ""
echo "5. 🔗 Update your mobile app:"
echo "   Update STRIPE_SERVER_URL in billingscreen.js to your Render app URL"
echo ""
echo "6. 🪝 Configure Stripe Webhook:"
echo "   - Go to Stripe Dashboard → Webhooks"
echo "   - Add endpoint: https://your-render-app.onrender.com/webhook"
echo "   - Select events: customer.subscription.*, invoice.payment_*"
echo ""
echo "✅ Pre-deployment checks completed successfully!"
echo ""
echo "📚 For detailed instructions, see README.md"
echo "🆘 For troubleshooting, check the Troubleshooting section in README.md"
