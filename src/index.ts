import express from 'express';
import {setup_metrics} from './utils/prometheus';
import {VideoStreamFileProcessor} from './classes/video_stream_file_processor.class';

const app = express();
const PORT = process.env.PORT || 3000;

setup_metrics(app);

app.get('/health', (request, response) => {
  response.status(200).json({
    status: 'healthy'
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port: ${PORT}`);
  console.log(`Metrics available at http://localhost:${PORT}/metrics`);
});

const processor = new VideoStreamFileProcessor({
  watch_directory: 'test_videos',
  stream_timeout: 30_000
  /**
   * Suggested chunk size is 16kb when using `npm run generate_video`
   * so you can see the processing in real-time
   */
  // chunk_size: 16 * 1024
});
processor.start_watching();
