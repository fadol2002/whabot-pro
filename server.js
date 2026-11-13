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
  requestPairingCode,
  updateBotConfig,
  testBotPlayground,
  getCRMConversations,
  sendManualMessage,
  toggleContactPause,
  restoreAllBots,
  sendPasswordResetWhatsApp
} = require('./bot-engine');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'whabot_secret';

app.use(cors());
app.use(express.json({ limit: '15mb' }));
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

// ─── ROUTES AUTH (EMAIL OU NUMÉRO DE TÉLÉPHONE + RÉCUPÉRATION MOT DE PASSE) ──

function normalizeUserPhone(rawPhone) {
  let clean = String(rawPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return '';
  if (clean.startsWith('22901') && clean.length === 13) {
    clean = '229' + clean.slice(5);
  } else if (clean.startsWith('01') && clean.length === 10) {
    clean = '229' + clean.slice(2);
  } else if (clean.length === 8) {
    clean = '229' + clean;
  }
  return clean;
}

// POST /api/register — Créer un compte (Numéro WhatsApp obligatoire, Email optionnel)
app.post('/api/register', async (req, res) => {
  try {
    const { email, phone, password, name, company } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = normalizeUserPhone(phone);

    if (!name || !password) {
      return res.status(400).json({ error: 'Veuillez renseigner votre nom et votre mot de passe.' });
    }
    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({ error: '📱 Le numéro WhatsApp est obligatoire pour créer un compte (vous pouvez mettre Numéro seul, ou Numéro + Email).' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
    }
    if (cleanPhone && db.findUserByIdentifier(cleanPhone)) {
      return res.status(409).json({ error: 'Ce numéro de téléphone est déjà associé à un compte.' });
    }
    if (cleanEmail && db.findUserByIdentifier(cleanEmail)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé par un compte.' });
    }

    const finalEmail = cleanEmail || `${cleanPhone}@whabot.local`;
    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser({
      id: uuidv4(),
      email: finalEmail,
      phone: cleanPhone || '',
      password: hash,
      name,
      company: company || '',
      plan: 'Essai (20 msg)',
      isAdmin: false,
      maxMessages: 20,
      maxStorageMB: 5,
      messagesUsed: 0,
      isActive: true,
      subscriptionExpiresAt: null,
      botConfig: DEFAULT_BOT_CONFIG(company, name),
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[WhaBot] ✅ Nouvel utilisateur: ${finalEmail} (Tel: ${cleanPhone || 'N/A'})`);
    res.json({
      token,
      user: {
        id: user.id, email: user.email, phone: user.phone, name: user.name, company: user.company,
        plan: user.plan, isAdmin: !!user.isAdmin, maxMessages: user.maxMessages, messagesUsed: user.messagesUsed,
        botConfig: user.botConfig
      }
    });
  } catch (err) {
    console.error('Erreur register:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/login — Se connecter avec Email OU Numéro de téléphone
app.post('/api/login', async (req, res) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || '').trim();
    const { password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Veuillez entrer votre email (ou numéro) et votre mot de passe.' });
    }

    const searchKey = identifier.includes('@') ? identifier : normalizeUserPhone(identifier) || identifier;
    const user = db.findUserByIdentifier(searchKey);
    if (!user) return res.status(401).json({ error: 'Compte introuvable (vérifiez votre email ou numéro de téléphone).' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Mot de passe incorrect.' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[WhaBot] 🔐 Connexion: ${user.email}`);
    res.json({
      token,
      user: {
        id: user.id, email: user.email, phone: user.phone || '', name: user.name, company: user.company,
        plan: user.plan, isAdmin: !!user.isAdmin, maxMessages: user.maxMessages ?? 20, messagesUsed: user.messagesUsed || 0,
        botConfig: user.botConfig
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/forgot-password — Demander un code de récupération à 6 chiffres (envoyé sur WhatsApp)
app.post('/api/forgot-password', async (req, res) => {
  try {
    const rawId = String(req.body.identifier || '').trim();
    const rawWhatsapp = String(req.body.whatsappPhone || '').trim();
    if (!rawId) return res.status(400).json({ error: 'Veuillez entrer votre email ou votre numéro de téléphone.' });

    const searchKey = rawId.includes('@') ? rawId : (normalizeUserPhone(rawId) || rawId);
    const user = db.findUserByIdentifier(searchKey);
    if (!user) {
      return res.status(404).json({ error: 'Aucun compte trouvé avec cet email ou ce numéro de téléphone.' });
    }

    const resetCode = String(Math.floor(100000 + Math.random() * 900000));
    const resetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    const targetPhone = normalizeUserPhone(rawWhatsapp || user.phone || (!rawId.includes('@') ? rawId : ''));

    if (!targetPhone) {
      return res.status(400).json({
        needWhatsappPhone: true,
        error: '📲 Ce compte a été créé uniquement avec un email (sans numéro). Veuillez saisir juste en dessous le numéro WhatsApp sur lequel vous souhaitez recevoir votre code à 6 chiffres !'
      });
    }

    db.updateUser(user.id, {
      resetCode,
      resetCodeExpires: resetExpires,
      phone: user.phone || targetPhone || ''
    });

    if (targetPhone) {
      try {
        const waRes = await sendPasswordResetWhatsApp(targetPhone, resetCode, user.name);
        if (waRes.sentViaWhatsApp) {
          return res.json({
            sentViaWhatsApp: true,
            message: `✅ Un code de sécurité à 6 chiffres vient d'être envoyé sur votre WhatsApp (+${waRes.phone}) !`
          });
        }
      } catch (e) {
        console.error('Erreur envoi WhatsApp reset:', e.message);
      }
    }

    return res.json({
      sentViaWhatsApp: false,
      message: `⚠️ Code de récupération généré. Si vous ne l'avez pas reçu sur WhatsApp, renseignez votre numéro WhatsApp ci-dessous ou demandez votre code à l'administrateur.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la demande de récupération.' });
  }
});

// POST /api/reset-password — Valider le code à 6 chiffres et enregistrer le nouveau mot de passe
app.post('/api/reset-password', async (req, res) => {
  try {
    const rawId = String(req.body.identifier || '').trim();
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');

    if (!rawId || !code || !newPassword) {
      return res.status(400).json({ error: 'Tous les champs sont obligatoires.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
    }

    const searchKey = rawId.includes('@') ? rawId : (normalizeUserPhone(rawId) || rawId);
    const user = db.findUserByIdentifier(searchKey);
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

    if (!user.resetCode || user.resetCode !== code) {
      return res.status(400).json({ error: 'Code de sécurité incorrect.' });
    }
    if (user.resetCodeExpires && Date.now() > user.resetCodeExpires) {
      return res.status(400).json({ error: 'Ce code a expiré. Veuillez en demander un nouveau.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    db.updateUser(user.id, {
      password: hash,
      resetCode: null,
      resetCodeExpires: null
    });

    res.json({ message: '✅ Votre mot de passe a été modifié avec succès ! Vous pouvez maintenant vous connecter.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe.' });
  }
});

function getUserPermissions(u) {
  if (!u || u.isAdmin) {
    return {
      allowCatalog: true,
      allowTemplates: true,
      allowPlayground: true,
      allowCRM: true,
      allowHumanTakeover: true,
      allowVoice: true,
      allowImages: true,
      allowProductPhotos: true,
      allowAdvancedFilter: true
    };
  }
  const plans = db.getPlans();
  const matched = plans.find(p => p.id === u.planId || (u.plan && u.plan.toLowerCase().startsWith(p.name.toLowerCase())));
  if (!matched) {
    // Par défaut en Essai gratuit (20 msg), tout est ouvert pour que le client teste la puissance de WhaBot
    return {
      allowCatalog: true,
      allowTemplates: true,
      allowPlayground: true,
      allowCRM: true,
      allowHumanTakeover: true,
      allowVoice: true,
      allowImages: true,
      allowProductPhotos: true,
      allowAdvancedFilter: true
    };
  }
  return {
    allowCatalog: matched.allowCatalog !== false,
    allowTemplates: matched.allowTemplates !== false,
    allowPlayground: matched.allowPlayground !== false,
    allowCRM: matched.allowCRM !== false,
    allowHumanTakeover: matched.allowHumanTakeover !== false,
    allowVoice: !!matched.allowVoice,
    allowImages: !!matched.allowImages,
    allowProductPhotos: matched.allowProductPhotos !== false,
    allowAdvancedFilter: !!matched.allowAdvancedFilter
  };
}

// GET /api/me — Profil utilisateur connecté
app.get('/api/me', authMiddleware, (req, res) => {
  const u = req.user;
  const permissions = getUserPermissions(u);
  res.json({
    id: u.id, email: u.email, name: u.name, company: u.company,
    plan: u.plan || 'Essai (20 msg)',
    planId: u.planId || null,
    isAdmin: !!u.isAdmin,
    maxMessages: u.maxMessages ?? 20,
    messagesUsed: u.messagesUsed || 0,
    storageUsedMB: db.getUserStorageUsedMB(u),
    maxStorageMB: u.isAdmin ? 999 : (u.maxStorageMB ?? 5),
    isActive: u.isActive,
    permissions,
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

// POST /api/bot/pair — Connecter avec un Code à 8 chiffres (1 seul téléphone, sans scanner QR)
app.post('/api/bot/pair', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Entrez votre numéro WhatsApp avec indicatif (ex: 22962836380)' });
    console.log(`[WhaBot] 🔑 Demande de code d'appairage pour ${user.email} (${phone})`);
    const result = await requestPairingCode(
      user.id,
      phone,
      { ...DEFAULT_BOT_CONFIG(user.company, user.name), ...(user.botConfig || {}), isActive: true }
    );
    res.json(result);
  } catch (err) {
    console.error('Erreur pair bot:', err);
    res.status(400).json({ error: err.message || 'Impossible de générer le code' });
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
      products: Array.isArray(b.products) ? b.products : (current.products || []),
      isActive: b.isActive !== undefined ? !!b.isActive : current.isActive
    };

    // Vérifier la limite d'espace de stockage (Mo) du client
    const simulatedUser = { ...req.user, botConfig: newConfig };
    const newStorageMB = db.getUserStorageUsedMB(simulatedUser);
    const maxMB = req.user.isAdmin ? 999 : (req.user.maxStorageMB ?? 5);
    if (!req.user.isAdmin && newStorageMB > maxMB) {
      return res.status(400).json({
        error: `⚠️ Espace de stockage insuffisant (${newStorageMB} Mo / ${maxMB} Mo max). Supprimez des produits ou passez au forfait supérieur !`,
        storageUsedMB: db.getUserStorageUsedMB(req.user),
        maxStorageMB: maxMB
      });
    }

    db.updateUser(req.userId, { botConfig: newConfig });
    updateBotConfig(req.userId, newConfig);
    res.json({
      message: 'Configuration sauvegardée avec succès !',
      botConfig: newConfig,
      storageUsedMB: newStorageMB,
      maxStorageMB: maxMB
    });
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

// ─── ROUTES ADMIN (POUR FADOL) ────────────────────────────

function adminOnly(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur WhaBot' });
  }
  next();
}

app.get('/api/plans', (req, res) => {
  res.json({ plans: db.getPlans() });
});

app.post('/api/admin/plans', authMiddleware, adminOnly, (req, res) => {
  const plans = db.savePlan(req.body);
  res.json({ message: 'Forfait enregistré avec succès !', plans });
});

app.post('/api/admin/delete-plan', authMiddleware, adminOnly, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID du forfait requis' });
  const plans = db.deletePlan(id);
  res.json({ message: 'Forfait supprimé.', plans });
});

app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.getAllUsers().map(u => {
    const st = getBotStatus(u.id);
    return {
      id: u.id,
      email: u.email,
      accountPhone: u.phone || '',
      resetCode: u.resetCode || null,
      name: u.name,
      company: u.company || '',
      plan: u.plan || 'Essai (20 msg)',
      isAdmin: !!u.isAdmin,
      isActive: u.isActive !== false,
      messagesUsed: u.messagesUsed || 0,
      maxMessages: u.maxMessages ?? 20,
      storageUsedMB: db.getUserStorageUsedMB(u),
      maxStorageMB: u.isAdmin ? 999 : (u.maxStorageMB ?? 5),
      isConnected: !!st.isConnected,
      phone: st.phone || null,
      contactCount: st.contactCount || 0,
      createdAt: u.createdAt
    };
  });
  res.json({ total: users.length, users, plans: db.getPlans() });
});

app.post('/api/admin/reset-user-password', authMiddleware, adminOnly, async (req, res) => {
  const uid = req.body.userId || req.body.targetUserId;
  const newPass = String(req.body.newPassword || '').trim();
  if (!uid || newPass.length < 6) {
    return res.status(400).json({ error: 'Mot de passe de 6 caractères minimum requis.' });
  }
  const hash = await bcrypt.hash(newPass, 10);
  const updated = db.updateUser(uid, { password: hash, resetCode: null, resetCodeExpires: null });
  if (!updated) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ message: `🔑 Mot de passe de ${updated.email} modifié avec succès !` });
});

app.post('/api/admin/user-plan', authMiddleware, adminOnly, (req, res) => {
  const uid = req.body.userId || req.body.targetUserId;
  const { planType, customMax } = req.body;
  if (!uid || !planType) return res.status(400).json({ error: 'Paramètres manquants' });

  const targetUser = db.findUserById(uid);
  if (!targetUser) return res.status(404).json({ error: 'Utilisateur introuvable' });

  let updates = {};
  const dynamicPlan = db.getPlans().find(p => p.id === planType);

  if (planType === 'trial') {
    updates = { plan: 'Essai (20 msg)', planId: 'trial', maxMessages: 20, maxStorageMB: 5, messagesUsed: 0, isActive: true };
  } else if (planType === 'custom') {
    const limit = Math.max(1, Number(customMax) || 50);
    updates = { plan: `Essai Sur-Mesure (${limit} msg)`, planId: 'custom', maxMessages: limit, messagesUsed: 0, isActive: true };
  } else if (planType === 'custom-storage') {
    const storageLimit = Math.max(1, Number(req.body.customStorageMB) || 10);
    updates = { maxStorageMB: storageLimit };
  } else if (planType === 'suspend') {
    updates = { plan: 'Suspendu ⛔', isActive: false };
    stopBot(uid);
  } else if (dynamicPlan) {
    const currentBotCfg = targetUser.botConfig || {};
    const updatedBotCfg = {
      ...currentBotCfg,
      enableVoice: !!dynamicPlan.allowVoice,
      enableImages: !!dynamicPlan.allowImages,
      isActive: true
    };
    updates = {
      plan: `${dynamicPlan.name} (${dynamicPlan.price} FCFA)`,
      planId: dynamicPlan.id,
      maxMessages: Number(dynamicPlan.maxMessages) || 500,
      maxStorageMB: Number(dynamicPlan.maxStorageMB) || 10,
      messagesUsed: 0,
      isActive: true,
      botConfig: updatedBotCfg
    };
    updateBotConfig(uid, updatedBotCfg);
  } else {
    return res.status(400).json({ error: 'Forfait inconnu' });
  }

  const updated = db.updateUser(uid, updates);
  if (updates.isActive !== undefined) updateBotConfig(uid, { isActive: updates.isActive });
  res.json({ message: updates.plan ? `Forfait "${updates.plan}" activé avec succès !` : `Espace de stockage mis à jour (${updates.maxStorageMB} Mo) !`, user: updated });
});

app.post('/api/admin/delete-user', authMiddleware, adminOnly, (req, res) => {
  const uid = req.body.userId || req.body.targetUserId;
  if (!uid) return res.status(400).json({ error: 'ID requis' });
  stopBot(uid);
  db.deleteUser(uid);
  res.json({ message: 'Compte client supprimé.' });
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

  // Restaurer les sessions WhatsApp déjà connectées
  restoreAllBots(db.getAllUsers());

  // Auto-ping toutes les 10 minutes sur Render / Koyeb pour ne jamais dormir
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (externalUrl) {
    setInterval(() => {
      fetch(`${externalUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
});
