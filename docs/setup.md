# Setup and Installation

## Prerequisites

- Docker and Docker Compose
- Node.js 20.x (for local development)
- npm (for local development)
- Git

## Installation Steps

1. **Clone the Repository**
   ```bash
   git clone git@github.com:AntonioStipic/VideoStreamFileProcessor.git
   cd VideoStreamFileProcessor
   ```

2. **Environment Setup**
   - Copy `.env.example` to `.env` (if applicable)
   - Configure environment variables:
     ```
     NODE_ENV=development
     REDIS_URL=redis://redis:6379
     MINIO_ENDPOINT=minio
     MINIO_PORT=9000
     MINIO_ACCESS_KEY=minioadmin
     MINIO_SECRET_KEY=minioadmin
     ```

3. **Build and Start Services**
   ```bash
   docker-compose up --build
   ```

## Service Configuration

### Node.js Service
- Port: `3000`
- Environment variables for Redis and MinIO connection
- Volume mount for test videos
- FFmpeg integration

### Redis Service
- Port: `6379`
- Persistent volume for data
- Redis Insights for monitoring (port 5540)

### MinIO Service
- API Port: `9000`
- Console Port: `9001`
- Persistent volume for storage
- Prometheus metrics enabled

### Prometheus Service
- Port: `9090`
- Configuration file: `prometheus.yml`
- Persistent volume for metrics storage

### Grafana Service
- Port: `3001`
- Persistent volume for dashboards
- Pre-configured dashboards
- Prometheus data source

## Development Setup

1. **Local Development**
   ```bash
   npm install
   npm run build
   npm run start:dev
   ```

2. **Testing**
   ```bash
   npm test
   ```

3. **Linting**
   ```bash
   npm run lint
   ```

## Directory Structure

```
.
├── src/                    # Source code
├── test_videos/           # Test video files
├── docs/                  # Documentation
├── grafana/              # Grafana configuration
│   ├── dashboards/       # Dashboard definitions
│   └── provisioning/     # Provisioning configs
├── docker-compose.yml    # Docker services
├── node.Dockerfile       # Node.js container
└── prometheus.yml        # Prometheus config
```

## Accessing Services

- Node.js API: http://localhost:3000
- MinIO Console: http://localhost:9001
- Grafana: http://localhost:3001
- Prometheus: http://localhost:9090
- Redis Insights: http://localhost:5540

## Health Checks

1. **API Health**
   ```bash
   curl http://localhost:3000/health
   ```

2. **Metrics Endpoint**
   ```bash
   curl http://localhost:3000/metrics
   ```

## Troubleshooting

1. **Container Issues**
   ```bash
   docker-compose logs <service-name>
   ```

2. **FFmpeg Problems**
   - Check FFmpeg installation in container
   - Verify video file formats
   - Check permissions

3. **Connection Issues**
   - Verify service dependencies
   - Check network connectivity
   - Validate environment variables

## Security Configuration

### MinIO Authentication
1. **Server Configuration**
   ```yaml
   environment:
     - MINIO_ROOT_USER=minioadmin
     - MINIO_ROOT_PASSWORD=minioadmin
   ```

2. **Application Configuration**
   ```yaml
   environment:
     - MINIO_ACCESS_KEY=minioadmin
     - MINIO_SECRET_KEY=minioadmin
   ```

3. **Metrics Access**
   ```yaml
   environment:
     - MINIO_PROMETHEUS_AUTH_TYPE=public
   ```

### Production Security Considerations
1. **MinIO**
   - Change default credentials
   - Enable SSL/TLS
   - Configure bucket policies
   - Set up proper access controls

2. **Redis**
   - Enable authentication
   - Configure password
   - Restrict network access

3. **Metrics**
   - Secure metrics endpoints
   - Configure authentication
   - Restrict access to monitoring tools

## Production Deployment

1. **Environment**
   - Set `NODE_ENV=production`
   - Configure secure credentials
   - Enable SSL/TLS

2. **Scaling**
   - Configure multiple Node.js instances
   - Set up Redis cluster
   - Configure MinIO distributed mode

3. **Monitoring**
   - Set up alerting
   - Configure log aggregation
   - Enable backup solutions 
