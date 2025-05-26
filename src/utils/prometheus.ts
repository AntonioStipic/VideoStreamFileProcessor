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

export const active_streams = new Gauge({
  name: 'video_streams_active',
  help: 'Number of currently active video streams',
  registers: [register]
});

export const stream_processing_duration = new Histogram({
  name: 'video_stream_processing_duration_seconds',
  help: 'Time taken to process a complete video stream',
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register]
});

export const total_storage_used = new Gauge({
  name: 'video_storage_used_bytes',
  help: 'Total storage used for processed videos',
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
