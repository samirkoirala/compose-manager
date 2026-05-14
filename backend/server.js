const express = require('express');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Get SSH private key path (from env var or mounted file)
function getPrivateKeyPath() {
  if (process.env.SSH_PRIVATE_KEY) {
    const keyPath = path.join(os.tmpdir(), '.ssh_key_' + Date.now());
    const keyDir = path.dirname(keyPath);
    
    // Ensure directory exists
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true });
    }
    
    // Write the key from env var
    fs.writeFileSync(keyPath, process.env.SSH_PRIVATE_KEY, { mode: 0o600 });
    return keyPath;
  }
  
  // Default to mounted file
  return '/root/.ssh/id_rsa';
}

const keyPath = getPrivateKeyPath();

const SSH_CONFIG = {
  host: process.env.SERVER_IP,
  port: 22,
  username: process.env.SERVER_USERNAME,
  privateKeyPath: keyPath,
  proxyJump: process.env.JUMP_HOST_IP ? {
    host: process.env.JUMP_HOST_IP,
    port: parseInt(process.env.JUMP_HOST_PORT || '22'),
    username: process.env.JUMP_HOST_USER,
    privateKeyPath: keyPath,
  } : null,
};

const BASE_DIRS = (process.env.PROJECTS_BASE_DIRS || '/home/docker-projects')
  .split(',')
  .map(dir => dir.trim())
  .filter(Boolean);

function getSSH() {
  const ssh = new NodeSSH();
  return ssh;
}

// Discover all compose projects in all base folders
app.get('/api/projects', async (req, res) => {
  const ssh = getSSH();
  try {
    await ssh.connect(SSH_CONFIG);

    const projects = [];
    const composePaths = [];

    // Search in all configured base directories
    for (const baseDir of BASE_DIRS) {
      const result = await ssh.execCommand(
        `find ${baseDir} -maxdepth 3 \\( -name "docker-compose.yml" -o -name "docker-compose.yaml" -o -name "compose.yml" -o -name "compose.yaml" \\) 2>/dev/null`
      );

      if (result.stdout) {
        composePaths.push(...result.stdout.trim().split('\n').filter(Boolean));
      }
    }

    for (const composePath of composePaths) {
      const dir = path.dirname(composePath);
      const name = path.basename(dir);

      // Check running status
      const statusResult = await ssh.execCommand(
        `cd ${dir} && docker compose ps --format json 2>/dev/null || docker-compose ps --format json 2>/dev/null`
      );

      let running = false;
      let serviceCount = 0;
      let runningCount = 0;

      try {
        const lines = statusResult.stdout.trim().split('\n').filter(Boolean);
        const services = lines.map(l => JSON.parse(l));
        serviceCount = services.length;
        runningCount = services.filter(s => s.State === 'running').length;
        running = serviceCount > 0 && runningCount > 0;
      } catch (e) {
        // fallback: check if any containers are up
        const psResult = await ssh.execCommand(
          `cd ${dir} && docker compose ps 2>/dev/null | grep -c "Up" || echo 0`
        );
        running = parseInt(psResult.stdout.trim()) > 0;
      }

      projects.push({
        name,
        dir,
        composeFile: composePath,
        running,
        serviceCount,
        runningCount,
      });
    }

    ssh.dispose();
    res.json({ projects });
  } catch (err) {
    ssh.dispose();
    res.status(500).json({ error: err.message });
  }
});

// Run compose up or down for a project
app.post('/api/projects/:action', async (req, res) => {
  const { action } = req.params; // "up" or "down"
  const { dir } = req.body;

  if (!dir) return res.status(400).json({ error: 'Missing dir' });
  if (!['up', 'down'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  // Prevent path traversal
  if (dir.includes('..')) return res.status(400).json({ error: 'Invalid path' });

  const ssh = getSSH();

  // Set SSE headers for streaming logs
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await ssh.connect(SSH_CONFIG);
    send({ type: 'log', text: `🔌 Connected to ${SSH_CONFIG.host}` });
    send({ type: 'log', text: `📁 cd ${dir}` });

    const cmd = action === 'up'
      ? `cd ${dir} && docker compose up -d 2>&1`
      : `cd ${dir} && docker compose down 2>&1`;

    send({ type: 'log', text: `🚀 Running: docker compose ${action}${action === 'up' ? ' -d' : ''}` });

    await ssh.execCommand(cmd, {
      onStdout: (chunk) => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => {
          send({ type: 'log', text: line });
        });
      },
      onStderr: (chunk) => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => {
          send({ type: 'log', text: line });
        });
      },
    });

    send({ type: 'done', success: true, text: `✅ docker compose ${action} completed` });
    ssh.dispose();
    res.end();
  } catch (err) {
    send({ type: 'done', success: false, text: `❌ Error: ${err.message}` });
    ssh.dispose();
    res.end();
  }
});

// Get live logs for a project
app.get('/api/projects/logs', async (req, res) => {
  const { dir } = req.query;
  if (!dir || dir.includes('..')) return res.status(400).json({ error: 'Invalid dir' });

  const ssh = getSSH();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await ssh.connect(SSH_CONFIG);
    await ssh.execCommand(`cd ${dir} && docker compose logs --tail=50 2>&1`, {
      onStdout: chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ type: 'log', text: l })),
      onStderr: chunk => chunk.toString().split('\n').filter(Boolean).forEach(l => send({ type: 'log', text: l })),
    });
    send({ type: 'done' });
    ssh.dispose();
    res.end();
  } catch (err) {
    send({ type: 'error', text: err.message });
    ssh.dispose();
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Compose Manager running on http://localhost:${PORT}`));
