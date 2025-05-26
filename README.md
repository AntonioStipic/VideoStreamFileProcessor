# Video Stream File Processor

A robust file processing system that watches for video files, processes them into chunks, and uploads them to MinIO storage, with comprehensive monitoring and metrics collection.

## Table of Contents

1. [Architecture Overview](docs/architecture.md)
2. [System Components](docs/components.md)
3. [Setup and Installation](docs/setup.md)
4. [Monitoring and Metrics](docs/monitoring.md)

## Quick Start

1. Clone the repository
2. Install dependencies: `npm install`
3. Start the services: `docker-compose up`
4. Access the services:
   - Node.js API: http://localhost:3000
   - MinIO Console: http://localhost:9001
   - Grafana Dashboard: http://localhost:3001
   - Prometheus: http://localhost:9090
   - Redis Insights: http://localhost:5540

## Features

- Directory-based file watching and processing
- Configurable chunk-based file processing
- Efficient storage using MinIO
- Real-time monitoring with Prometheus and Grafana
- Redis-based metadata and status tracking
- Comprehensive metrics collection
- Health check endpoints
- Docker-based deployment

## Technology Stack

- **Backend**: Node.js with TypeScript
- **Storage**: MinIO (S3-compatible)
- **Queue**: Redis
- **Monitoring**: Prometheus + Grafana
- **Containerization**: Docker + Docker Compose
- **Video Metadata**: FFmpeg (for duration extraction only)

For detailed information about each component and how they work together, please refer to the specific documentation sections linked above. 