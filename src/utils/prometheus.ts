import {Counter, Gauge, Histogram, Registry} from 'prom-client';
import express from 'express';

const register = new Registry();

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

export function setup_metrics(app: express.Application) {
  app.get('/metrics', async (request, response) => {
    try {
      response.set('Content-Type', register.contentType);
      response.end(await register.metrics());
    } catch (error) {
      response.status(500).end(error);
    }
  });
}
