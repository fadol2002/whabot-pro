// ============================================================
//  WhaBot SaaS Pro — Serveur Principal (API REST)
//  Port: 4000
// ============================================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

const db = require('./db');
const {
  startBot,
  stopBot,
  getBotQR,
  getBotStatus,
  updateBotConfig,
  testBotPlayground,
  getCRMConversations,
  sendManualMessage,
  toggleContactPause
} = require('./bot-engine');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'whabot_secret';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Middleware Auth JWT ───────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = decoded.userId;
    req.user = db.findUserById(decoded.userId);
    if (!req.user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

const DEFAULT_BOT_CONFIG = (company, name) => ({
  botName: 'Maya',
  companyName: company || name || 'Mon Entreprise',
  sector: 'agence de voyage',
  tone: 'professionnel, chaleureux et persuasif',
  faq: '',
  catalog: '',
  ctaLink: '',
  replyDelaySeconds: 0,
  humanPauseMinutes: 15,
  enableVoice: true,
  enableImages: true,
  filterMode: 'all', // 'all' ou 'whitelist'
  blacklist: [],
  whitelist: [],
  contactNotes: {},
  isActive: true
});

// ─── ROUTES AUTH ──────────────────────────────────────────

// POST /api/register — Créer un compte
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, mot de passe et nom requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
    }
    if (db.findUserByEmail(email)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser({
      id: uuidv4(),
      email,
      password: hash,
      name,
      company: company || '',
      plan: 'Essai Pro',
      isActive: true,
      subscriptionExpiresAt: null,
      botConfig: DEFAULT_BOT_CONFIG(company, name),
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[WhaBot] ✅ Nouvel utilisateur: ${email}`);
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, company: user.company, plan: user.plan, botConfig: user.botConfig }
    });
  } catch (err) {
    console.error('Erreur register:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/login — Se connecter
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[WhaBot] 🔐 Connexion: ${email}`);
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, company: user.company, plan: user.plan, botConfig: user.botConfig }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/me — Profil utilisateur connecté
app.get('/api/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, email: u.email, name: u.name, company: u.company,
    plan: u.plan, isActive: u.isActive,
    subscriptionExpiresAt: u.subscriptionExpiresAt,
    botConfig: { ...DEFAULT_BOT_CONFIG(u.company, u.name), ...(u.botConfig || {}) }
  });
});

// ─── ROUTES BOT ───────────────────────────────────────────

// POST /api/bot/start — Démarrer le bot (génère QR)
app.post('/api/bot/start', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    console.log(`[WhaBot] 🚀 Démarrage bot pour ${user.email}`);
    await startBot(user.id, { ...DEFAULT_BOT_CONFIG(user.company, user.name), ...(user.botConfig || {}), isActive: true });
    res.json({ message: 'Bot en cours de démarrage. Scannez le QR code.' });
  } catch (err) {
    console.error('Erreur start bot:', err);
    res.status(500).json({ error: 'Impossible de démarrer le bot: ' + err.message });
  }
});

// POST /api/bot/stop — Arrêter le bot
app.post('/api/bot/stop', authMiddleware, (req, res) => {
  stopBot(req.userId);
  res.json({ message: 'Bot arrêté.' });
});

// GET /api/bot/qr — Obtenir le QR code (image base64)
app.get('/api/bot/qr', authMiddleware, (req, res) => {
  const qr = getBotQR(req.userId);
  if (!qr) return res.status(404).json({ error: 'Pas de QR disponible. Démarrez le bot d\'abord.' });
  res.json({ qr });
});

// GET /api/bot/status — Statut du bot
app.get('/api/bot/status', authMiddleware, (req, res) => {
  res.json(getBotStatus(req.userId));
});

// POST /api/bot/config — Sauvegarder la configuration complète du bot
app.post('/api/bot/config', authMiddleware, (req, res) => {
  try {
    const current = { ...DEFAULT_BOT_CONFIG(req.user.company, req.user.name), ...(req.user.botConfig || {}) };
    const b = req.body;

    const newConfig = {
      ...current,
      botName: b.botName !== undefined ? b.botName : current.botName,
      companyName: b.companyName !== undefined ? b.companyName : current.companyName,
      sector: b.sector !== undefined ? b.sector : current.sector,
      tone: b.tone !== undefined ? b.tone : current.tone,
      faq: b.faq !== undefined ? b.faq : current.faq,
      catalog: b.catalog !== undefined ? b.catalog : current.catalog,
      ctaLink: b.ctaLink !== undefined ? b.ctaLink : current.ctaLink,
      replyDelaySeconds: b.replyDelaySeconds !== undefined ? Number(b.replyDelaySeconds) : current.replyDelaySeconds,
      humanPauseMinutes: b.humanPauseMinutes !== undefined ? Number(b.humanPauseMinutes) : current.humanPauseMinutes,
      enableVoice: b.enableVoice !== undefined ? !!b.enableVoice : current.enableVoice,
      enableImages: b.enableImages !== undefined ? !!b.enableImages : current.enableImages,
      filterMode: b.filterMode !== undefined ? b.filterMode : current.filterMode,
      blacklist: Array.isArray(b.blacklist) ? b.blacklist : current.blacklist,
      whitelist: Array.isArray(b.whitelist) ? b.whitelist : current.whitelist,
      contactNotes: (b.contactNotes && typeof b.contactNotes === 'object') ? b.contactNotes : current.contactNotes,
      isActive: b.isActive !== undefined ? !!b.isActive : current.isActive
    };

    db.updateUser(req.userId, { botConfig: newConfig });
    updateBotConfig(req.userId, newConfig);
    res.json({ message: 'Configuration sauvegardée avec succès !', botConfig: newConfig });
  } catch (err) {
    console.error('Erreur config:', err);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde' });
  }
});

// POST /api/bot/playground — Tester son IA en direct dans le navigateur
app.post('/api/bot/playground', authMiddleware, async (req, res) => {
  try {
    const { message, reset, customConfig } = req.body;
    const cfg = customConfig || { ...DEFAULT_BOT_CONFIG(req.user.company, req.user.name), ...(req.user.botConfig || {}) };
    const result = await testBotPlayground(req.userId, cfg, message || 'Bonjour', !!reset);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur lors du test IA' });
  }
});

// GET /api/bot/conversations — Récupérer le Mini-CRM et l'historique des chats
app.get('/api/bot/conversations', authMiddleware, (req, res) => {
  try {
    const list = getCRMConversations(req.userId);
    res.json({ conversations: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bot/send — Envoyer un message WhatsApp manuel depuis le CRM
app.post('/api/bot/send', authMiddleware, async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Destinataire et message requis' });
    const result = await sendManualMessage(req.userId, to, text);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/bot/contact-pause — Mettre en pause / réactiver l'IA sur un contact
app.post('/api/bot/contact-pause', authMiddleware, (req, res) => {
  try {
    const { jid, paused } = req.body;
    if (!jid) return res.status(400).json({ error: 'JID requis' });
    const updated = toggleContactPause(req.userId, jid, paused);
    res.json({ success: true, contact: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE ADMIN ──────────────────────────────────────────

app.get('/api/admin/users', (req, res) => {
  if (req.headers['x-admin-key'] !== 'whabot_admin_fadol_2024') {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const users = db.getAllUsers().map(u => ({
    id: u.id, email: u.email, name: u.name,
    plan: u.plan, isActive: u.isActive, createdAt: u.createdAt
  }));
  res.json({ total: users.length, users });
});

// ─── ROUTE SANTÉ & AUTO-RÉVEIL 24H/24 (CLOUD KEEP-ALIVE) ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// ─── ROUTE RACINE ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── DÉMARRAGE ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🤖 WhaBot SaaS Pro — Serveur démarré !`);
  console.log(`🌐 URL : http://localhost:${PORT}`);
  console.log(`📡 API : http://localhost:${PORT}/api`);
  console.log(`======================================================\n`);

  // Auto-ping toutes les 10 minutes sur Render / Koyeb pour ne jamais dormir
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (externalUrl) {
    setInterval(() => {
      fetch(`${externalUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
});
