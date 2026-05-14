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

function parseShortPortMapping(value) {
  // Supports forms like "8080:80", "127.0.0.1:8080:80/tcp", "8080:80/udp"
  const raw = String(value).trim().replace(/^"|"$/g, '');
  if (!raw) return null;

  const [portPart, protocol = 'tcp'] = raw.split('/');
  const pieces = portPart.split(':');
  if (pieces.length < 2) return null;

  const containerPort = pieces[pieces.length - 1];
  const hostPort = pieces[pieces.length - 2];
  const ip = pieces.length > 2 ? pieces.slice(0, pieces.length - 2).join(':') : '';

  if (!/^\d+$/.test(hostPort) || !/^\d+$/.test(containerPort)) return null;

  return {
    hostPort,
    containerPort,
    protocol,
    hostIp: ip || null,
  };
}

function parsePortsFromComposeJson(config) {
  const ports = [];
  const services = config && config.services ? config.services : {};

  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    const mappings = Array.isArray(serviceConfig.ports) ? serviceConfig.ports : [];

    for (const item of mappings) {
      if (typeof item === 'string') {
        const parsed = parseShortPortMapping(item);
        if (parsed) {
          ports.push({ service: serviceName, ...parsed });
        }
        continue;
      }

      if (item && typeof item === 'object') {
        const target = item.target != null ? String(item.target) : '';
        const published = item.published != null ? String(item.published) : '';
        if (!published || !target) continue;

        ports.push({
          service: serviceName,
          hostPort: published,
          containerPort: target,
          protocol: item.protocol ? String(item.protocol) : 'tcp',
          hostIp: item.host_ip ? String(item.host_ip) : null,
        });
      }
    }
  }

  return ports;
}

function parsePortsFromComposeYaml(yamlText) {
  const ports = [];
  const lines = String(yamlText || '').split('\n');

  let inServices = false;
  let currentService = null;
  let inPorts = false;
  let currentPortObj = null;

  for (const line of lines) {
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }

    const serviceMatch = line.match(/^\s{2}([a-zA-Z0-9_.-]+):\s*$/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      inPorts = false;
      currentPortObj = null;
      continue;
    }

    if (!currentService) continue;

    if (/^\s{4}ports:\s*$/.test(line)) {
      inPorts = true;
      currentPortObj = null;
      continue;
    }

    if (/^\s{4}[a-zA-Z0-9_.-]+:\s*$/.test(line)) {
      inPorts = false;
      currentPortObj = null;
      continue;
    }

    if (!inPorts) continue;

    const shortPortMatch = line.match(/^\s{6}-\s+"?([^"\n]+)"?\s*$/);
    if (shortPortMatch) {
      const parsed = parseShortPortMapping(shortPortMatch[1]);
      if (parsed) {
        ports.push({ service: currentService, ...parsed });
      }
      currentPortObj = null;
      continue;
    }

    const longFormStartMatch = line.match(/^\s{6}-\s+target:\s+"?(\d+)"?\s*$/);
    if (longFormStartMatch) {
      currentPortObj = {
        service: currentService,
        containerPort: longFormStartMatch[1],
        hostPort: '',
        protocol: 'tcp',
        hostIp: null,
      };
      continue;
    }

    if (currentPortObj) {
      const publishedMatch = line.match(/^\s{8}published:\s+"?(\d+)"?\s*$/);
      if (publishedMatch) {
        currentPortObj.hostPort = publishedMatch[1];
        continue;
      }

      const protocolMatch = line.match(/^\s{8}protocol:\s+([a-zA-Z]+)\s*$/);
      if (protocolMatch) {
        currentPortObj.protocol = protocolMatch[1];
        continue;
      }

      const hostIpMatch = line.match(/^\s{8}host_ip:\s+"?([^"\n]+)"?\s*$/);
      if (hostIpMatch) {
        currentPortObj.hostIp = hostIpMatch[1];
        continue;
      }

      if (/^\s{6}-\s+/.test(line) || /^\s{4}[a-zA-Z0-9_.-]+:\s*$/.test(line)) {
        if (currentPortObj.hostPort) {
          ports.push(currentPortObj);
        }
        currentPortObj = null;
      }
    }
  }

  if (currentPortObj && currentPortObj.hostPort) {
    ports.push(currentPortObj);
  }

  return ports;
}

async function getProjectPorts(ssh, dir) {
  const jsonResult = await ssh.execCommand(
    `cd ${dir} && (docker compose config --format json 2>/dev/null || docker-compose config --format json 2>/dev/null || true)`
  );

  const rawJson = (jsonResult.stdout || '').trim();
  if (rawJson) {
    try {
      return parsePortsFromComposeJson(JSON.parse(rawJson));
    } catch (e) {
      // Fall through to YAML parser.
    }
  }

  const yamlResult = await ssh.execCommand(
    `cd ${dir} && (docker compose config 2>/dev/null || docker-compose config 2>/dev/null || true)`
  );

  return parsePortsFromComposeYaml(yamlResult.stdout || '');
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
      const ports = await getProjectPorts(ssh, dir);

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
        ports,
      });
    }

    const portUsage = {};
    for (const project of projects) {
      for (const port of project.ports || []) {
        const key = `${port.hostPort}/${port.protocol || 'tcp'}`;
        if (!portUsage[key]) portUsage[key] = [];
        portUsage[key].push({
          project: project.name,
          dir: project.dir,
          service: port.service,
          running: project.running,
        });
      }
    }

    for (const project of projects) {
      const conflicts = [];
      for (const port of project.ports || []) {
        const key = `${port.hostPort}/${port.protocol || 'tcp'}`;
        const users = portUsage[key] || [];
        if (users.length > 1) {
          conflicts.push({
            hostPort: port.hostPort,
            protocol: port.protocol || 'tcp',
            service: port.service,
            users,
          });
        }
      }
      project.conflicts = conflicts;
    }

    ssh.dispose();
    res.json({ projects, portUsage });
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
