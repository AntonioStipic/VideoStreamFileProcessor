# System Components

## Node.js Application

### Core Functionality
- Video stream processing
- Chunk management
- Queue integration
- Storage operations
- Metrics collection

### Key Features
1. **Video Processing**
   - Stream reception
   - FFmpeg integration
   - Chunk generation
   - Format handling

2. **Queue Management**
   - Redis integration
   - Message queuing
   - Error handling
   - Retry mechanisms

3. **Storage Operations**
   - MinIO client
   - Chunk upload
   - File management
   - Error recovery

4. **Monitoring**
   - Prometheus metrics
   - Health checks
   - Performance tracking
   - Error reporting

## Redis

### Role
- Message queue
- Task distribution
- State management
- Cache layer

### Configuration
- Port: 6379
- Persistence enabled
- Monitoring via Redis Exporter
- Insights dashboard

### Queue Structure
1. **Upload Queue**
   - Chunk metadata
   - Processing status
   - Retry information
   - Error details

2. **State Management**
   - Active streams
   - Processing status
   - System state
   - Configuration

## MinIO

### Storage Features
- S3-compatible API
- Object storage
- Version control
- Lifecycle management

### Configuration
- API Port: 9000
- Console Port: 9001
- Authentication enabled
- Metrics exposed

### Bucket Structure
1. **Video Chunks**
   - Raw chunks
   - Processed files
   - Metadata
   - Temporary storage

2. **Access Control**
   - User permissions
   - Bucket policies
   - Public/private access
   - Version control

## Monitoring Stack

### Prometheus

1. **Configuration**
   - Scrape intervals
   - Target endpoints
   - Retention policies
   - Alert rules

2. **Metrics Collection**
   - Node.js metrics
   - Redis metrics
   - MinIO metrics
   - System metrics

### Grafana

1. **Dashboards**
   - Video processing
   - System health
   - Performance metrics
   - Custom visualizations

2. **Features**
   - Real-time monitoring
   - Alert configuration
   - Data visualization
   - User management

## Docker Services

### Node.js Container
- Base: node:20-alpine
- FFmpeg integration
- Volume mounts
- Environment configuration

### Redis Container
- Base: redis:7-alpine
- Persistence volume
- Network configuration
- Security settings

### MinIO Container
- Base: minio/minio
- Storage volume
- Console access
- Metrics enabled

### Monitoring Containers
- Prometheus configuration
- Grafana setup
- Redis Exporter
- Network integration

## Network Architecture

### Internal Communication
- Docker network
- Service discovery
- Port mapping
- Security groups

### External Access
- API endpoints
- Console interfaces
- Monitoring dashboards
- Health checks

## Data Flow

### Video Processing
1. Stream reception
2. Chunk generation
3. Queue placement
4. Upload processing
5. Storage management

### Monitoring Flow
1. Metric collection
2. Data aggregation
3. Visualization
4. Alert generation

## Security

### Authentication
- MinIO credentials
- Redis security
- API authentication
- Dashboard access

### Authorization
- Role-based access
- Service permissions
- API restrictions
- Dashboard controls

### Network Security
- Internal network
- Port restrictions
- SSL/TLS
- Firewall rules 