# vayada Creator Marketplace Backend API

A FastAPI-based backend service for the vayada Creator Marketplace platform. This API provides authentication, user management, and marketplace functionality.

## 🚀 Quick Start

### Prerequisites

Before you begin, make sure you have the following installed:

- **Docker** and **Docker Compose** - Required for local databases and backend services
- **Python 3.11+** - Only needed if you want to develop locally without Docker

### Getting Started

1. **Start the application:**

   ```bash
   docker compose up -d
   ```

   Run this from the repository root. It starts local databases, MinIO, auth-DB
   migrations, and the legacy FastAPI backends. Frontends run from npm/portless,
   not Docker Compose.

2. **Verify everything is running:**

   ```bash
   docker compose ps
   ```

   You should see the support services with a "running" status.

3. **Access the API:**
   - API Base URL: `http://localhost:8000`
   - API Documentation: `http://localhost:8000/docs` (see below for details)

## 📚 API Documentation

### Interactive API Documentation (`/docs`)

FastAPI automatically generates interactive API documentation that you can access in your browser. This is the easiest way to explore and test all available API endpoints.

**How to access:**

1. Start the backend service (see Quick Start above)
2. Open your web browser
3. Navigate to: **`http://localhost:8000/docs`**

**What you'll see:**

- A complete list of all available API endpoints
- Detailed information about each endpoint (methods, parameters, request/response formats)
- An interactive interface to test API calls directly from your browser
- Request/response examples

**How to use the documentation:**

1. Click on any endpoint to expand its details
2. Click the **"Try it out"** button to test the endpoint
3. Fill in any required parameters or request body
4. Click **"Execute"** to send the request
5. View the response directly in the browser

**Alternative documentation:**

- **ReDoc**: `http://localhost:8000/redoc` - A cleaner, more readable documentation format
- **OpenAPI Schema**: `http://localhost:8000/openapi.json` - Raw JSON schema for API tools

> 💡 **Tip**: The `/docs` page is your best friend when developing! Use it to understand the API structure and test endpoints without writing code.

## 🔧 Configuration

### Environment Variables

The backend uses environment variables for configuration. You need to create a `.env` file in the project root.

**Setup:**

```bash
cp .env.example .env
```

Then edit `.env` and customize the following key variables:

- `DATABASE_URL` - PostgreSQL database connection string
- `CORS_ORIGINS` - Comma-separated list of allowed frontend origins (e.g., `http://localhost:3000`)
- `API_HOST` - API server host (default: `0.0.0.0`)
- `API_PORT` - API server port (default: `8000`)
- `ENVIRONMENT` - Environment name (`development` or `production`)
- `DEBUG` - Enable debug mode (`true` or `false`)

See `.env.example` for all available configuration options.

## 🗄️ Database

The PostgreSQL database runs automatically in a Docker container. Database migrations are applied automatically on first startup.

### Database Connection Details

- **Host**: `localhost` (from your computer) or `postgres` (from within Docker network)
- **Port**: `5432`
- **Database Name**: `vayada_db`
- **Username**: `vayada_user`
- **Password**: `vayada_password`

### Accessing the Database

To connect to the database directly using the command line:

```bash
docker compose exec marketplace-postgres psql -U vayada_user -d vayada_db
```

## 🔌 API Endpoints

### Health Check Endpoints

These endpoints help you verify that the API is working correctly:

- **`GET /`** - Root endpoint - Returns a welcome message
- **`GET /health`** - Service health check - Verifies the API is running
- **`GET /health/db`** - Database health check - Verifies database connectivity

### Authentication Endpoints

Authentication-related endpoints are available. See the `/docs` page for the complete list and details.

## 💻 Development

### Making Changes

When you modify the code, you need to rebuild the backend container:

```bash
docker compose build marketplace-backend
docker compose up -d marketplace-backend
```

### Viewing Logs

To see what's happening in real-time:

```bash
docker compose logs -f marketplace-backend
```

Press `Ctrl+C` to stop viewing logs.

### Stopping Services

To stop support services:

```bash
docker compose down
```

To stop and remove all data (including database):

```bash
docker compose down -v
```

## 🔗 Frontend Integration

The frontend should be configured to connect to the backend API.

**Development URL:**

- `http://localhost:8000`

**Frontend Configuration:**
Create a `.env.local` file in your frontend directory with:

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## 📖 Additional Resources

- **API Documentation**: Visit `http://localhost:8000/docs` after starting the server
- **FastAPI Documentation**: https://fastapi.tiangolo.com/
- **Docker Documentation**: https://docs.docker.com/

## 🆘 Troubleshooting

**Problem**: Can't access `http://localhost:8000/docs`

- **Solution**: Make sure the backend service is running (`docker-compose ps`)

**Problem**: Database connection errors

- **Solution**: Ensure the postgres service is healthy (`docker-compose ps`) and wait a few seconds for it to fully start

**Problem**: Port 8000 is already in use

- **Solution**: Change the `API_PORT` in your `.env` file or stop the service using port 8000
