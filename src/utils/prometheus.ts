import {Counter, Gauge, Histogram, Registry} from 'prom-client';
import express from 'express';

// Create a Registry to register the metrics
const register = new Registry();

// File Processing Metrics
export const total_files_processed = new Counter({
  name: 'video_files_processed_total',
  help: 'Total number of video files processed',
  registers: [register]
});

export const total_chunks_uploaded = new Counter({
  name: 'video_chunks_uploaded_total',
  help: 'Total number of chunks uploaded to S3',
  registers: [register]
});

export const total_upload_errors = new Counter({
  name: 'video_upload_errors_total',
  help: 'Total number of upload errors encountered',
  registers: [register]
});

// Active Processing Metrics
export const active_streams = new Gauge({
  name: 'video_streams_active',
  help: 'Number of currently active video streams',
  registers: [register]
});

export const upload_queue_size = new Gauge({
  name: 'video_upload_queue_size',
  help: 'Number of chunks waiting to be uploaded',
  registers: [register]
});

// Performance Metrics
export const chunk_upload_duration = new Histogram({
  name: 'video_chunk_upload_duration_seconds',
  help: 'Time taken to upload a chunk',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register]
});

export const stream_processing_duration = new Histogram({
  name: 'video_stream_processing_duration_seconds',
  help: 'Time taken to process a complete video stream',
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register]
});

// Storage Metrics
export const total_storage_used = new Gauge({
  name: 'video_storage_used_bytes',
  help: 'Total storage used for processed videos',
  registers: [register]
});

// Setup function to initialize metrics endpoint
export function setup_metrics(app: express.Application) {
  // Expose metrics endpoint
  app.get('/metrics', async (request, response) => {
    try {
      response.set('Content-Type', register.contentType);
      response.end(await register.metrics());
    } catch (error) {
      response.status(500).end(error);
    }
  });
}

// Helper function to measure duration of async operations
export async function measure_duration<T>(
  operation: () => Promise<T>,
  histogram: Histogram
): Promise<T> {
  const start = Date.now();
  try {
    return await operation();
  } finally {
    const duration = (Date.now() - start) / 1000; // Convert to seconds
    histogram.observe(duration);
  }
}

// Example usage:
/*
import {
  total_files_processed,
  active_streams,
  measure_duration,
  chunk_upload_duration
} from './prometheus';

// In your video processing code:
async function processVideo() {
  total_files_processed.inc();
  active_streams.inc();

  try {
    await measure_duration(
      async () => {
        // Your upload logic here
      },
      chunk_upload_duration
    );
  } finally {
    active_streams.dec();
  }
}
*/
