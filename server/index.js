const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
const ARNIS_BINARY = process.env.ARNIS_BINARY || '/Users/ericberget/Downloads/arnis-main/target/release/arnis';
const ARNIS_CWD = process.env.ARNIS_CWD || '/Users/ericberget/Downloads/arnis-main';
const JOBS_DIR = path.resolve(__dirname, 'jobs');
const MAX_CONCURRENT = 2;
const MAX_AREA_KM2 = 4; // ~2km x 2km max

// Track active jobs
const jobs = new Map(); // jobId -> { status, progress, error, fileName, startedAt }
let activeCount = 0;

// Ensure jobs dir exists
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// --- Helpers ---

function bboxAreaKm2(minLat, minLng, maxLat, maxLng) {
  const dLat = (maxLat - minLat) * Math.PI / 180;
  const dLng = (maxLng - minLng) * Math.PI / 180;
  const midLat = ((minLat + maxLat) / 2) * Math.PI / 180;
  return Math.abs(dLat * 6371 * dLng * 6371 * Math.cos(midLat));
}

function validateBbox(bbox) {
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    return { valid: false, error: 'Invalid format. Expected: minLat,minLng,maxLat,maxLng' };
  }
  const [minLat, minLng, maxLat, maxLng] = parts;
  if (minLat >= maxLat || minLng >= maxLng) {
    return { valid: false, error: 'Invalid coordinates: min must be less than max' };
  }
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) {
    return { valid: false, error: 'Coordinates out of range' };
  }
  const area = bboxAreaKm2(minLat, minLng, maxLat, maxLng);
  if (area > MAX_AREA_KM2) {
    return { valid: false, error: `Area too large (${area.toFixed(1)} km²). Max ${MAX_AREA_KM2} km².` };
  }
  return { valid: true, area };
}

// --- Routes ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeJobs: activeCount, maxJobs: MAX_CONCURRENT });
});

// Start a generation job
app.post('/api/generate', (req, res) => {
  const { bbox, terrain = true } = req.body;

  if (!bbox) return res.status(400).json({ error: 'bbox is required' });

  const validation = validateBbox(bbox);
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  if (activeCount >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy — try again in a few minutes.' });
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs.set(jobId, { status: 'generating', progress: 'Fetching map data...', startedAt: Date.now() });
  activeCount++;

  // Build CLI args
  const args = [
    '--bedrock',
    '--bbox', bbox,
    '--output-dir', jobDir,
    '--scale', '1',
    '--timeout', '60',
  ];
  if (terrain) args.push('--terrain');

  console.log(`[${jobId}] Starting: arnis ${args.join(' ')}`);

  const child = spawn(ARNIS_BINARY, args, {
    cwd: ARNIS_CWD,
    timeout: 10 * 60 * 1000,
  });

  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
    // Parse Arnis progress from stdout
    const lines = output.split('\n');
    const lastStep = lines.filter(l => l.match(/^\[[\d]\/[\d]\]/)).pop();
    if (lastStep) {
      jobs.get(jobId).progress = lastStep.trim();
    }
  });

  child.stderr.on('data', (data) => {
    output += data.toString();
  });

  child.on('close', (code) => {
    activeCount--;

    if (code !== 0) {
      console.error(`[${jobId}] Failed (code ${code})`);
      jobs.set(jobId, { status: 'error', error: 'Generation failed. Try a smaller area.' });
      return;
    }

    // Find the .mcworld file
    const files = fs.readdirSync(jobDir);
    const mcworld = files.find(f => f.endsWith('.mcworld'));

    if (!mcworld) {
      jobs.set(jobId, { status: 'error', error: 'No world file generated.' });
      return;
    }

    const fileSize = fs.statSync(path.join(jobDir, mcworld)).size;
    console.log(`[${jobId}] Done: ${mcworld} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

    jobs.set(jobId, {
      status: 'complete',
      fileName: mcworld,
      fileSize,
    });
  });

  res.json({ jobId });
});

// Poll job status
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: req.params.jobId, ...job });
});

// Download the generated file
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'complete') {
    return res.status(404).json({ error: 'Not ready' });
  }

  const filePath = path.join(JOBS_DIR, req.params.jobId, job.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${job.fileName}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

// Cleanup old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - (job.startedAt || 0) > 3600000) {
      const jobDir = path.join(JOBS_DIR, id);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Arnis server running on http://localhost:${PORT}`);
  console.log(`Binary: ${ARNIS_BINARY}`);
});
