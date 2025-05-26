import puppeteer, {Browser, Page} from 'puppeteer';
import {PuppeteerScreenRecorder} from 'puppeteer-screen-recorder';
import path from 'path';
import fs from 'fs';
import {PassThrough} from 'stream';

/**
 * Video Generation Service
 * 
 * This is a dummy service that simulates a video stream by creating a growing MP4 file.
 * It uses Puppeteer to record a browser session and continuously writes the recording
 * to a file, making it grow over time. This simulates a real-world scenario where
 * a video stream is being recorded and needs to be processed while it's still growing.
 * 
 * Key characteristics:
 * - Creates an MP4 file that continuously grows in size
 * - Uses Puppeteer to record browser activity
 * - Simulates a real-time video stream
 * - Useful for testing the video processing system's ability to handle growing files
 * 
 * Usage:
 * Run the service using:
 *   npm run start:generate_video
 * 
 * This service is meant to be run alongside the main application to generate test data.
 * The generated video file will be picked up by the file watcher and processed in chunks.
 * 
 * Note: This is a development/testing tool and should not be used in production.
 */

interface VideoGeneratorConfig {
  resolution?: {
    width: number;
    height: number;
  };
  font_size?: string;
  font_color?: string;
  background_color?: string;
  font_family?: string;
  output_folder?: string;
}

export class VideoGenerator {
  private config: Required<VideoGeneratorConfig>;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private recorder: PuppeteerScreenRecorder | null = null;

  constructor(config: VideoGeneratorConfig = {}) {
    this.config = {
      resolution: config.resolution || {width: 1920, height: 1080},
      font_size: config.font_size || '48px',
      font_color: config.font_color || '#ffffff',
      background_color: config.background_color || '#000000',
      font_family: config.font_family || 'Arial',
      output_folder: config.output_folder || 'test_videos'
    };

    if (!fs.existsSync(this.config.output_folder)) {
      fs.mkdirSync(this.config.output_folder, {recursive: true});
    }
  }

  async generate_video(duration: number, filename: string): Promise<string> {
    try {
      await this.setup_page();

      const output_path = path.join(this.config.output_folder, filename);
      const write_stream = fs.createWriteStream(output_path);
      const pipe_stream = new PassThrough();

      pipe_stream.pipe(write_stream);

      const recorder_config = {
        followNewTab: false,
        fps: 30,
        videoFrame: this.config.resolution,
        videoCrf: 18,
        videoCodec: 'libx264',
        videoPreset: 'ultrafast',
        videoBitrate: 1000,
        autopad: {
          color: this.config.background_color
        }
      };

      this.recorder = new PuppeteerScreenRecorder(this.page!, recorder_config);
      await this.recorder.startStream(pipe_stream);

      await new Promise(resolve => {
        setTimeout(resolve, duration * 1000)
      });

      await this.recorder.stop();

      /**
       * Wait for the write stream to finish
       */
      await new Promise<void>((resolve, reject) => {
        write_stream.on('close', () => {
          console.log('Finished writing video');
          resolve();
        });
        write_stream.on('finish', resolve);
        write_stream.on('error', reject);
        pipe_stream.end();
      });

      return output_path;
    } catch (error) {
      console.error('Error generating video:', error);
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
      }
    }
  }

  private async setup_page(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport(this.config.resolution);

    await this.page.setContent(`
      <html>
        <head>
          <style>
            body {
              margin: 0;
              padding: 0;
              background-color: ${this.config.background_color};
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              font-family: ${this.config.font_family};
            }
            #timestamp {
              color: ${this.config.font_color};
              font-size: ${this.config.font_size};
            }
          </style>
        </head>
        <body>
          <div id="timestamp">00:00:00</div>
          <script>
            const timestamp = document.getElementById('timestamp');
            let start_time = Date.now();
            
            function update_timestamp() {
              const elapsed = Date.now() - start_time;
              const hours = Math.floor(elapsed / 3600000);
              const minutes = Math.floor((elapsed % 3600000) / 60000);
              const seconds = Math.floor((elapsed % 60000) / 1000);
              
              timestamp.textContent = 
                \`\${hours.toString().padStart(2, '0')}:\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
            }
            
            setInterval(update_timestamp, 1000);
          </script>
        </body>
      </html>
    `);
  }
}

async function main() {
  const generator = new VideoGenerator({
    resolution: {
      width: 1280,
      height: 720
    },
    font_size: '72px',
    font_color: '#ff0000',
    background_color: '#000000',
    font_family: 'Arial',
    output_folder: 'test_videos'
  });

  await generator.generate_video(80, `test_${Date.now()}.mp4`);
}

main();
