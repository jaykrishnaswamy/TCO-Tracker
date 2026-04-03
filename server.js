require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
// Serve auth callback
app.get('/auth/callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/auth/callback.html'));
});

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Supabase admin client (server-side only, uses secret key)
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://zmlwcswvjbfayzjjcywz.supabase.co',
  process.env.SUPABASE_SECRET_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Auth middleware: verify Supabase JWT from Authorization header ──
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid session' });
  req.user = user;
  req.token = token;
  // Create a user-scoped client for RLS
  req.db = createClient(
    process.env.SUPABASE_URL || 'https://zmlwcswvjbfayzjjcywz.supabase.co',
    process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_ovKoCEQA_7nVYA13Hs1BVA_MtyoZQvx',
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  next();
}

// ── Vehicle endpoints ──
app.get('/api/vehicles', requireAuth, async (req, res) => {
  const { data, error } = await req.db.from('vehicles').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/vehicles', requireAuth, async (req, res) => {
  const { vehicle } = req.body;
  const { data, error } = await req.db.from('vehicles')
    .insert({ user_id: req.user.id, vehicle })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/vehicles/:id', requireAuth, async (req, res) => {
  const { vehicle } = req.body;
  const { data, error } = await req.db.from('vehicles')
    .update({ vehicle, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/vehicles/:id', requireAuth, async (req, res) => {
  const { error } = await req.db.from('vehicles').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Generic entries endpoint factory ──
function entriesRouter(table) {
  const router = express.Router();

  router.get('/:vehicleId', requireAuth, async (req, res) => {
    const { data, error } = await req.db.from(table)
      .select('*')
      .eq('vehicle_id', req.params.vehicleId)
      .order('created_at');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.post('/:vehicleId', requireAuth, async (req, res) => {
    const { data: entry } = req.body;
    const { data, error } = await req.db.from(table)
      .insert({ vehicle_id: req.params.vehicleId, user_id: req.user.id, data: entry })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.put('/:id', requireAuth, async (req, res) => {
    const { data: entry } = req.body;
    const { data, error } = await req.db.from(table)
      .update({ data: entry })
      .eq('id', req.params.id)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    const { error } = await req.db.from(table).delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  return router;
}

app.use('/api/fuel', entriesRouter('fuel_entries'));
app.use('/api/maintenance', entriesRouter('maintenance_entries'));
app.use('/api/fixed', entriesRouter('fixed_entries'));
app.use('/api/consumables', entriesRouter('consumable_entries'));

// ── Bulk entries save (for importing/syncing all at once) ──
app.post('/api/sync/:vehicleId', requireAuth, async (req, res) => {
  const { vehicleId } = req.params;
  const { fuel = [], maintenance = [], fixed = [], consumables = [] } = req.body;

  const uid = req.user.id;
  const toRows = (arr) => arr.map(e => ({
    vehicle_id: vehicleId, user_id: uid, data: e
  }));

  try {
    // Delete existing and reinsert (simple full sync)
    await req.db.from('fuel_entries').delete().eq('vehicle_id', vehicleId);
    await req.db.from('maintenance_entries').delete().eq('vehicle_id', vehicleId);
    await req.db.from('fixed_entries').delete().eq('vehicle_id', vehicleId);
    await req.db.from('consumable_entries').delete().eq('vehicle_id', vehicleId);

    if (fuel.length) await req.db.from('fuel_entries').insert(toRows(fuel));
    if (maintenance.length) await req.db.from('maintenance_entries').insert(toRows(maintenance));
    if (fixed.length) await req.db.from('fixed_entries').insert(toRows(fixed));
    if (consumables.length) await req.db.from('consumable_entries').insert(toRows(consumables));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invite a friend (admin only — checks if requester is in allowed_users with owner note) ──
app.post('/api/invite', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Check requester is owner
  const { data: me } = await supabase.from('allowed_users')
    .select('note').eq('email', req.user.email).single();
  if (!me || me.note !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can invite users' });
  }

  // Add to whitelist
  const { error: wErr } = await supabase.from('allowed_users')
    .insert({ email, invited_by: req.user.email, note: 'friend' })
    .on_conflict('email').ignore();
  if (wErr) return res.status(500).json({ error: wErr.message });

  // Send Supabase magic link invite
  const { error: iErr } = await supabase.auth.admin.inviteUserByEmail(email);
  if (iErr) return res.status(500).json({ error: iErr.message });

  res.json({ ok: true, message: `Invite sent to ${email}` });
});

// ── Usage endpoint ──
app.get('/api/usage', requireAuth, async (req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const isOwner = req.user.email === (process.env.OWNER_EMAIL || '');
  if (isOwner) return res.json({ count: 0, limit: null, unlimited: true, month });

  const { data } = await supabase
    .from('scan_usage')
    .select('count')
    .eq('user_id', req.user.id)
    .eq('month', month)
    .single();

  const count = data?.count || 0;
  res.json({ count, limit: SCAN_LIMIT, remaining: SCAN_LIMIT - count, unlimited: false, month });
});

// ── Image upload + resize ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf']);

function mimeForExt(ext) {
  const map = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf' };
  return map[ext.toLowerCase()] || 'image/jpeg';
}

function extractRawImages(files) {
  const images = [];
  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip') {
      try {
        const zip = new AdmZip(file.buffer);
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const entryExt = path.extname(entry.entryName).toLowerCase();
          if (!IMAGE_EXTS.has(entryExt)) continue;
          if (entry.entryName.startsWith('__MACOSX') || path.basename(entry.entryName).startsWith('._')) continue;
          images.push({ name: path.basename(entry.entryName), buffer: entry.getData(), mime: mimeForExt(entryExt) });
        }
      } catch (e) { console.error('Zip error:', e.message); }
    } else if (IMAGE_EXTS.has(ext)) {
      images.push({ name: file.originalname, buffer: file.buffer, mime: file.mimetype || mimeForExt(ext) });
    }
  }
  return images;
}

async function resizeImage(img) {
  if (img.mime === 'application/pdf') return img;
  try {
    const resized = await sharp(img.buffer).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { name: img.name, buffer: resized, mime: 'image/jpeg' };
  } catch (e) { return img; }
}

app.post('/api/upload', upload.array('files', 500), async (req, res) => {
  try {
    const raw = extractRawImages(req.files || []);
    const images = await Promise.all(raw.map(resizeImage));
    res.json({ count: images.length, files: images.map(img => ({ name: img.name, mime: img.mime, data: img.buffer.toString('base64') })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scan usage helpers ──
const SCAN_LIMIT = 20;
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';

async function checkAndIncrementUsage(user) {
  // Owner has unlimited scans
  if (user.email === OWNER_EMAIL) return { allowed: true, count: 0, limit: Infinity };

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Get current count
  const { data } = await supabase
    .from('scan_usage')
    .select('count')
    .eq('user_id', user.id)
    .eq('month', month)
    .single();

  const current = data?.count || 0;
  if (current >= SCAN_LIMIT) {
    return { allowed: false, count: current, limit: SCAN_LIMIT };
  }

  // Increment
  await supabase.from('scan_usage').upsert(
    { user_id: user.id, month, count: current + 1 },
    { onConflict: 'user_id,month' }
  );

  return { allowed: true, count: current + 1, limit: SCAN_LIMIT };
}

// ── Anthropic proxy ──
app.post('/api/scan', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  // Check auth and usage limit
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) {
      const usage = await checkAndIncrementUsage(user);
      if (!usage.allowed) {
        return res.status(429).json({
          error: `Monthly scan limit reached (${usage.limit} scans/month). Resets on the 1st.`,
          count: usage.count,
          limit: usage.limit
        });
      }
      // Add usage info to response headers
      res.set('X-Scan-Count', usage.count);
      res.set('X-Scan-Limit', usage.limit === Infinity ? 'unlimited' : usage.limit);
    }
  }
  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data));
  });
  proxyReq.on('error', err => res.status(502).json({ error: 'Failed to reach Anthropic API.' }));
  proxyReq.write(body);
  proxyReq.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TCO Tracker running at http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'configured' : 'using defaults'}`);
  console.log(`API key: ${process.env.ANTHROPIC_API_KEY ? 'found' : 'MISSING'}`);
});
