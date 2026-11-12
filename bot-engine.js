// ============================================================
//  WhaBot SaaS Pro — Moteur Multi-Bots WhatsApp Ultra-Complet
//  Supporte : Multi-tenant, Vocaux, Images, Relais Humain,
//             Mode Absence (Timer), Liste Noire/Blanche, Mini-CRM
// ============================================================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const DEFAULT_KEY = ['AQ.Ab8RN6LDEtncwne0pDFz4', 'KzNqat3h0l4UybIcuUyE9keNYDQiQ'].join('');
function getApiKey() {
  return process.env.GEMINI_API_KEY || DEFAULT_KEY;
}

// Map userId => { sock, qrDataUrl, isConnected, phone, config, messagesHandled, startedAt, humanTakeover, pendingTimers }
const activeBots = new Map();
// Mémoire séparée pour le simulateur Playground : Map userId => Array<{role, text}>
const playgroundMemory = new Map();

function getSessionPath(userId) {
  const p = path.join(__dirname, 'sessions', userId);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getConversationsPath(userId) {
  const p = path.join(__dirname, 'conversations');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return path.join(p, `${userId}.json`);
}

function loadConversations(userId) {
  const p = getConversationsPath(userId);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {}
  return {};
}

function saveConversations(userId, data) {
  try {
    fs.writeFileSync(getConversationsPath(userId), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[Bot ${userId}] Erreur sauvegarde conversations:`, e.message);
  }
}

function recordChatMessage(userId, contactJid, role, text, pushName = '') {
  const conversations = loadConversations(userId);
  if (!conversations[contactJid]) {
    conversations[contactJid] = {
      jid: contactJid,
      phone: contactJid.split(':')[0].split('@')[0],
      name: pushName || '',
      paused: false,
      updatedAt: Date.now(),
      messages: []
    };
  }
  // Rétrocompatibilité si l'entrée était un tableau simple
  if (Array.isArray(conversations[contactJid])) {
    conversations[contactJid] = {
      jid: contactJid,
      phone: contactJid.split(':')[0].split('@')[0],
      name: pushName || '',
      paused: false,
      updatedAt: Date.now(),
      messages: conversations[contactJid]
    };
  }
  if (pushName && !conversations[contactJid].name) {
    conversations[contactJid].name = pushName;
  }
  conversations[contactJid].updatedAt = Date.now();
  conversations[contactJid].messages.push({
    role,
    text,
    time: Date.now()
  });
  if (conversations[contactJid].messages.length > 40) {
    conversations[contactJid].messages = conversations[contactJid].messages.slice(-40);
  }
  saveConversations(userId, conversations);
  return conversations[contactJid];
}

function extractText(msg) {
  if (!msg || !msg.message) return '';
  const m = msg.message;
  return m.conversation ||
         m.extendedTextMessage?.text ||
         m.imageMessage?.caption ||
         m.videoMessage?.caption ||
         m.ephemeralMessage?.message?.conversation ||
         m.ephemeralMessage?.message?.extendedTextMessage?.text ||
         m.viewOnceMessage?.message?.conversation ||
         m.viewOnceMessage?.message?.imageMessage?.caption ||
         m.viewOnceMessageV2?.message?.conversation ||
         m.viewOnceMessageV2?.message?.imageMessage?.caption ||
         '';
}

function matchPhoneList(remoteJid, list = []) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const clean = (remoteJid || '').replace(/[^0-9]/g, '');
  return list.some(num => {
    const cleanNum = String(num).replace(/[^0-9]/g, '');
    if (!cleanNum) return false;
    return clean.includes(cleanNum) || (cleanNum.length >= 7 && clean.endsWith(cleanNum.slice(-7)));
  });
}

function getContactCustomNote(remoteJid, contactNotes = {}) {
  const clean = (remoteJid || '').replace(/[^0-9]/g, '');
  for (const [num, note] of Object.entries(contactNotes || {})) {
    const cleanNum = String(num).replace(/[^0-9]/g, '');
    if (cleanNum && (clean.includes(cleanNum) || (cleanNum.length >= 7 && clean.endsWith(cleanNum.slice(-7))))) {
      return note;
    }
  }
  return null;
}

function buildSystemInstruction(botConfig, contactNote = null) {
  const botName = botConfig.botName || 'Assistant IA';
  const companyName = botConfig.companyName || 'notre entreprise';
  const sector = botConfig.sector || 'Service client & Ventes';
  const tone = botConfig.tone || 'professionnel, chaleureux et persuasif';

  let prompt = `Tu es ${botName}, l'assistant WhatsApp intelligent de "${companyName}" (Secteur : ${sector}).
Ton style de communication : ${tone}.

⚡ RÈGLES D'OR (FORMAT WHATSAPP PRO) :
1. Réponds TOUJOURS en français (sauf si le client parle une autre langue).
2. Sois CONCIS et DIRECT : 2 à 4 phrases courtes maximum par message. Jamais de longs paragraphes.
3. Utilise 1 ou 2 émojis pertinents pour rendre le message agréable à lire.
4. Pose UNE seule question claire à la fin pour faire avancer le client (qualifier son besoin, conclure une vente ou prendre rendez-vous).
5. Si tu vois des messages précédés de [Conseiller Humain] dans l'historique, poursuis naturellement la conversation sans répéter ce qui a déjà été dit.`;

  if (botConfig.catalog && botConfig.catalog.trim()) {
    prompt += `\n\n📦 CATALOGUE PRODUITS / SERVICES & TARIFS :\n${botConfig.catalog.trim()}`;
  }

  if (botConfig.faq && botConfig.faq.trim()) {
    prompt += `\n\n📚 BASE DE CONNAISSANCES / FAQ DE L'ENTREPRISE :\n${botConfig.faq.trim()}`;
  }

  if (botConfig.ctaLink && botConfig.ctaLink.trim()) {
    prompt += `\n\n🎯 OBJECTIF DE CONVERSION / CONTACT : Si le client souhaite acheter, réserver ou parler à un responsable, oriente-le vers : ${botConfig.ctaLink.trim()}`;
  }

  if (contactNote) {
    prompt += `\n\n⚠️ CONSIGNE SPÉCIALE POUR CE CONTACT PRÉCIS :\n${contactNote}`;
  }

  return prompt;
}

async function askGemini(userId, botConfig, contactJid, userMessage, media = null, pushName = '') {
  try {
    const conversations = loadConversations(userId);
    const contactEntry = conversations[contactJid];
    const rawHistory = Array.isArray(contactEntry) ? contactEntry : (contactEntry?.messages || []);
    const history = rawHistory.slice(-10);

    const contactNote = getContactCustomNote(contactJid, botConfig.contactNotes);
    const systemPrompt = buildSystemInstruction(botConfig, contactNote);

    const contents = history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.text }]
    }));

    const currentParts = [];
    if (media && media.base64) {
      currentParts.push({
        inline_data: {
          mime_type: media.mimeType,
          data: media.base64
        }
      });
    }

    let textPrompt = userMessage;
    if (!textPrompt) {
      if (media?.mimeType?.startsWith('audio')) {
        textPrompt = "Écoute attentivement ce message vocal du client et réponds-lui directement de façon brève (2-3 phrases).";
      } else if (media?.mimeType?.startsWith('image')) {
        textPrompt = "Analyse cette image envoyée par le client (produit, document ou reçu) et réponds-lui brièvement (2-3 phrases).";
      } else {
        textPrompt = "Bonjour";
      }
    }
    currentParts.push({ text: textPrompt });

    contents.push({
      role: 'user',
      parts: currentParts
    });

    const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getApiKey()}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 220, temperature: 0.5 }
      })
    });

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Merci pour votre message ! Un conseiller vous répondra dans un instant.";

    const labelUserMsg = media
      ? (media.mimeType?.startsWith('audio') ? `🎙️ [Note vocale] ${userMessage || ''}`.trim() : `📸 [Image reçue] ${userMessage || ''}`.trim())
      : userMessage;

    recordChatMessage(userId, contactJid, 'user', labelUserMsg, pushName);
    recordChatMessage(userId, contactJid, 'model', reply.trim(), pushName);

    return reply.trim();
  } catch (err) {
    console.error(`[Bot ${userId}] Erreur Gemini:`, err.message);
    return "Merci pour votre message. Notre équipe revient vers vous très rapidement !";
  }
}

// Simulateur Playground (dans le Dashboard Web)
async function testBotPlayground(userId, botConfig, userMessage, reset = false) {
  if (reset) {
    playgroundMemory.delete(userId);
    return { reply: "🧹 Mémoire du simulateur réinitialisée ! Écrivez un message pour tester votre assistant." };
  }

  const history = playgroundMemory.get(userId) || [];
  const systemPrompt = buildSystemInstruction(botConfig);

  const contents = [
    ...history.slice(-10).map(h => ({
      role: h.role,
      parts: [{ text: h.text }]
    })),
    {
      role: 'user',
      parts: [{ text: userMessage }]
    }
  ];

  const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getApiKey()}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 220, temperature: 0.5 }
    })
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || 'Erreur API Gemini');
  }
  const reply = (data.candidates?.[0]?.content?.parts?.[0]?.text || "Je n'ai pas pu générer de réponse.").trim();

  history.push({ role: 'user', text: userMessage });
  history.push({ role: 'model', text: reply });
  playgroundMemory.set(userId, history.slice(-20));

  return { reply, history: playgroundMemory.get(userId) };
}

// Démarrer le bot WhatsApp d'un utilisateur
async function startBot(userId, botConfig) {
  if (activeBots.has(userId)) {
    const existing = activeBots.get(userId);
    if (existing.isConnected) return { alreadyRunning: true };
  }

  activeBots.set(userId, {
    sock: null,
    qrDataUrl: null,
    isConnected: false,
    phone: null,
    config: botConfig,
    messagesHandled: 0,
    startedAt: new Date().toISOString(),
    humanTakeover: new Map(),
    pendingTimers: new Map(),
    botSentIds: new Set()
  });

  const sessionPath = getSessionPath(userId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: [`${botConfig.botName || 'WhaBot Pro'}`, 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    syncFullHistory: false,
  });

  const botState = activeBots.get(userId);
  botState.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
      console.log(`[WhaBot] 📱 QR généré pour user: ${userId}`);
    }

    if (connection === 'close') {
      botState.isConnected = false;
      botState.qrDataUrl = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhaBot] ⚠️ Bot ${userId} déconnecté (code: ${statusCode}). Reconnexion: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot(userId, botState.config), 5000);
      } else {
        activeBots.delete(userId);
      }
    } else if (connection === 'open') {
      botState.isConnected = true;
      botState.qrDataUrl = null;
      botState.phone = sock.user?.id?.split(':')[0]?.split('@')[0];
      console.log(`[WhaBot] ✅ Bot ${userId} connecté sur +${botState.phone}`);
    }
  });

  const processedIds = new Set();

  sock.ev.on('messages.upsert', async (m) => {
    if (!m.messages || m.messages.length === 0) return;
    const cfg = botState.config;

    if (cfg.isActive === false) return;

    for (const msg of m.messages) {
      if (!msg.message) continue;

      const msgId = msg.key?.id;
      if (!msgId || processedIds.has(msgId) || botState.botSentIds.has(msgId)) continue;
      processedIds.add(msgId);
      setTimeout(() => processedIds.delete(msgId), 60000);

      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast') continue;
      if (remoteJid.endsWith('@g.us')) continue; // Ignorer les groupes

      const text = extractText(msg).trim();
      const pushName = msg.pushName || '';

      // CAS 1 : LE PROPRIÉTAIRE RÉPOND LUI-MÊME DEPUIS SON TÉLÉPHONE (RELAIS HUMAIN)
      if (msg.key.fromMe) {
        // Annuler un éventuel minuteur de mode absence en cours
        if (botState.pendingTimers.has(remoteJid)) {
          clearTimeout(botState.pendingTimers.get(remoteJid).timer);
          botState.pendingTimers.delete(remoteJid);
          console.log(`[Bot ${userId}] 🛑 Propriétaire a répondu à ${remoteJid} -> Minuteur annulé.`);
        }
        if (text) {
          recordChatMessage(userId, remoteJid, 'model', `[Conseiller Humain] ${text}`);
          const pauseMin = Number(cfg.humanPauseMinutes ?? 15);
          if (pauseMin > 0) {
            botState.humanTakeover.set(remoteJid, Date.now() + pauseMin * 60 * 1000);
            console.log(`[Bot ${userId}] 🤝 Relais humain activé pour ${pauseMin} min sur ${remoteJid}`);
          }
        }
        continue;
      }

      // CAS 2 : VÉRIFIER FILTRAGE (LISTE NOIRE / LISTE BLANCHE)
      if (cfg.filterMode === 'whitelist') {
        if (!matchPhoneList(remoteJid, cfg.whitelist)) {
          continue;
        }
      } else {
        if (matchPhoneList(remoteJid, cfg.blacklist)) {
          console.log(`[Bot ${userId}] 🚫 Numéro en liste noire ignoré: ${remoteJid}`);
          continue;
        }
      }

      // CAS 3 : VÉRIFIER PAUSE MANUELLE CRM OU RELAIS HUMAIN EN COURS
      const conversations = loadConversations(userId);
      const contactObj = conversations[remoteJid];
      if (contactObj && contactObj.paused) {
        if (text) recordChatMessage(userId, remoteJid, 'user', text, pushName);
        console.log(`[Bot ${userId}] ⏸️ Contact ${remoteJid} en pause manuelle dans le CRM.`);
        continue;
      }

      const pausedUntil = botState.humanTakeover.get(remoteJid);
      if (pausedUntil && Date.now() < pausedUntil) {
        if (text) recordChatMessage(userId, remoteJid, 'user', text, pushName);
        console.log(`[Bot ${userId}] ⏸️ Relais humain actif sur ${remoteJid}. Message mémorisé sans réponse IA.`);
        continue;
      }

      // CAS 4 : DÉTECTION VOCAL & IMAGE
      const hasImage = !!(msg.message.imageMessage || msg.message.viewOnceMessage?.message?.imageMessage || msg.message.viewOnceMessageV2?.message?.imageMessage);
      const hasAudio = !!(msg.message.audioMessage);
      let mediaData = null;

      if (hasImage && cfg.enableImages !== false) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          if (buffer) {
            const rawMime = msg.message.imageMessage?.mimetype || 'image/jpeg';
            mediaData = { mimeType: rawMime.split(';')[0].trim(), base64: buffer.toString('base64') };
          }
        } catch (e) {
          console.error(`[Bot ${userId}] Erreur téléchargement image:`, e.message);
        }
      } else if (hasAudio && cfg.enableVoice !== false) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          if (buffer) {
            const rawMime = msg.message.audioMessage?.mimetype || 'audio/ogg';
            mediaData = { mimeType: rawMime.split(';')[0].trim(), base64: buffer.toString('base64') };
          }
        } catch (e) {
          console.error(`[Bot ${userId}] Erreur téléchargement audio:`, e.message);
        }
      }

      if (!text && !mediaData) continue;

      const delaySec = Number(cfg.replyDelaySeconds || 0);

      // Fonction d'envoi de la réponse IA
      const triggerAIReply = async (combinedText, lastMsgObj, mediaObj) => {
        try {
          await sock.readMessages([lastMsgObj.key]);
          await sock.sendPresenceUpdate('composing', remoteJid);
          const reply = await askGemini(userId, cfg, remoteJid, combinedText, mediaObj, pushName);
          const sent = await sock.sendMessage(remoteJid, { text: reply }, { quoted: lastMsgObj });
          if (sent?.key?.id) {
            botState.botSentIds.add(sent.key.id);
            setTimeout(() => botState.botSentIds.delete(sent.key.id), 120000);
          }
          await sock.sendPresenceUpdate('available', remoteJid);
          botState.messagesHandled++;
          console.log(`[Bot ${userId}] ✅ Réponse IA envoyée à ${remoteJid}`);
        } catch (err) {
          console.error(`[Bot ${userId}] ❌ Erreur réponse:`, err.message);
        }
      };

      // Si un délai d'absence est configuré (ex: 10s, 30s, 60s)
      if (delaySec > 0) {
        if (botState.pendingTimers.has(remoteJid)) {
          const entry = botState.pendingTimers.get(remoteJid);
          if (text) entry.texts.push(text);
          entry.lastMsg = msg;
          if (mediaData) entry.media = mediaData;
        } else {
          console.log(`[Bot ${userId}] ⏳ Attente de ${delaySec}s avant réponse IA à ${remoteJid}...`);
          const timer = setTimeout(async () => {
            const entry = botState.pendingTimers.get(remoteJid);
            botState.pendingTimers.delete(remoteJid);
            if (!entry) return;
            await triggerAIReply(entry.texts.join('\n'), entry.lastMsg, entry.media);
          }, delaySec * 1000);

          botState.pendingTimers.set(remoteJid, {
            timer,
            texts: text ? [text] : [],
            lastMsg: msg,
            media: mediaData
          });
        }
      } else {
        // Réponse immédiate
        await triggerAIReply(text, msg, mediaData);
      }
    }
  });

  return { started: true };
}

function stopBot(userId) {
  const bot = activeBots.get(userId);
  if (!bot) return false;
  try {
    bot.sock?.end();
  } catch (e) {}
  activeBots.delete(userId);
  return true;
}

function getBotQR(userId) {
  return activeBots.get(userId)?.qrDataUrl || null;
}

function getBotStatus(userId) {
  const bot = activeBots.get(userId);
  const convs = loadConversations(userId);
  const contactCount = Object.keys(convs).length;

  if (!bot) return { running: false, isConnected: false, contactCount, messagesHandled: 0 };
  return {
    running: true,
    isConnected: bot.isConnected,
    phone: bot.phone,
    messagesHandled: bot.messagesHandled,
    contactCount,
    startedAt: bot.startedAt,
    hasQR: !!bot.qrDataUrl
  };
}

function updateBotConfig(userId, newConfig) {
  const bot = activeBots.get(userId);
  if (!bot) return false;
  bot.config = { ...bot.config, ...newConfig };
  return true;
}

// Mini-CRM : récupérer la liste des contacts et conversations
function getCRMConversations(userId) {
  const convs = loadConversations(userId);
  const bot = activeBots.get(userId);
  const list = Object.entries(convs).map(([jid, data]) => {
    const isArray = Array.isArray(data);
    const messages = isArray ? data : (data.messages || []);
    const phone = jid.split(':')[0].split('@')[0];
    const autoPausedUntil = bot?.humanTakeover?.get(jid) || 0;
    const isAutoPaused = autoPausedUntil > Date.now();
    return {
      jid,
      phone,
      name: isArray ? '' : (data.name || ''),
      paused: isArray ? false : (!!data.paused || isAutoPaused),
      updatedAt: isArray ? Date.now() : (data.updatedAt || Date.now()),
      lastMessage: messages.length > 0 ? messages[messages.length - 1].text : '',
      messageCount: messages.length,
      messages
    };
  });
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Mini-CRM : envoyer un message manuel depuis le Dashboard
async function sendManualMessage(userId, targetPhoneOrJid, text) {
  const bot = activeBots.get(userId);
  if (!bot || !bot.isConnected || !bot.sock) {
    throw new Error("Votre WhatsApp n'est pas connecté.");
  }
  const cleanNum = targetPhoneOrJid.includes('@')
    ? targetPhoneOrJid
    : `${targetPhoneOrJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  const sent = await bot.sock.sendMessage(cleanNum, { text });
  if (sent?.key?.id) {
    bot.botSentIds.add(sent.key.id);
    setTimeout(() => bot.botSentIds.delete(sent.key.id), 120000);
  }
  recordChatMessage(userId, cleanNum, 'model', `[Conseiller Humain] ${text}`);
  return { success: true, jid: cleanNum };
}

// Mini-CRM : mettre en pause / réactiver l'IA pour un contact
function toggleContactPause(userId, jid, paused) {
  const convs = loadConversations(userId);
  if (!convs[jid]) {
    convs[jid] = { jid, phone: jid.split(':')[0].split('@')[0], name: '', paused: !!paused, updatedAt: Date.now(), messages: [] };
  } else if (Array.isArray(convs[jid])) {
    convs[jid] = { jid, phone: jid.split(':')[0].split('@')[0], name: '', paused: !!paused, updatedAt: Date.now(), messages: convs[jid] };
  } else {
    convs[jid].paused = !!paused;
  }
  const bot = activeBots.get(userId);
  if (bot && !paused) {
    bot.humanTakeover.delete(jid);
  }
  saveConversations(userId, convs);
  return convs[jid];
}

module.exports = {
  startBot,
  stopBot,
  getBotQR,
  getBotStatus,
  updateBotConfig,
  testBotPlayground,
  getCRMConversations,
  sendManualMessage,
  toggleContactPause,
  activeBots
};
