// ============================================================
//  WhaBot SaaS Pro — Moteur Multi-Bots WhatsApp Ultra-Complet
//  Supporte : Multi-tenant, Vocaux, Images, Relais Humain,
//             Mode Absence (Timer), Liste Noire/Blanche, Mini-CRM
// ============================================================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const db = require('./db');
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

function getPlanPermsForUser(userId) {
  const u = db.findUserById(userId);
  if (!u || u.isAdmin) {
    return { allowCatalog: true, allowHumanTakeover: true, allowVoice: true, allowImages: true, allowProductPhotos: true, allowAdvancedFilter: true };
  }
  const plans = db.getPlans ? db.getPlans() : [];
  const matched = plans.find(p => p.id === u.planId || (u.plan && u.plan.toLowerCase().startsWith(p.name.toLowerCase())));
  if (!matched) {
    return { allowCatalog: true, allowHumanTakeover: true, allowVoice: true, allowImages: true, allowProductPhotos: true, allowAdvancedFilter: true };
  }
  return {
    allowCatalog: matched.allowCatalog !== false,
    allowHumanTakeover: matched.allowHumanTakeover !== false,
    allowVoice: !!matched.allowVoice,
    allowImages: !!matched.allowImages,
    allowProductPhotos: matched.allowProductPhotos !== false,
    allowAdvancedFilter: !!matched.allowAdvancedFilter
  };
}

function extractProductPhotosFromReply(rawReply, products = []) {
  if (!rawReply) return { cleanReply: '', matchedProducts: [] };
  const matchedProducts = [];
  const seenIds = new Set();
  const regex = /\[PHOTO:([a-zA-Z0-9_-]+)\]/gi;
  let match;
  while ((match = regex.exec(rawReply)) !== null) {
    const pid = match[1];
    if (!seenIds.has(pid) && Array.isArray(products)) {
      const found = products.find(p => String(p.id) === String(pid));
      if (found && found.imageDataUrl) {
        seenIds.add(pid);
        matchedProducts.push(found);
      }
    }
  }
  const cleanReply = rawReply.replace(/\[PHOTO:[a-zA-Z0-9_-]+\]/gi, '').trim();
  return { cleanReply, matchedProducts };
}

function buildSystemInstruction(botConfig, contactNote = null, allowCatalog = true, allowProductPhotos = true) {
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

  if (allowCatalog && botConfig.catalog && botConfig.catalog.trim()) {
    prompt += `\n\n📦 CATALOGUE PRODUITS / SERVICES & TARIFS :\n${botConfig.catalog.trim()}`;
  }

  if (allowCatalog && botConfig.faq && botConfig.faq.trim()) {
    prompt += `\n\n📚 BASE DE CONNAISSANCES / FAQ DE L'ENTREPRISE :\n${botConfig.faq.trim()}`;
  }

  if (allowProductPhotos && Array.isArray(botConfig.products) && botConfig.products.length > 0) {
    const prodLines = botConfig.products.map(p =>
      `- ID: ${p.id} | Produit: ${p.name} | Prix: ${p.price} | Infos: ${p.description || 'Disponible en stock'}`
    ).join('\n');
    prompt += `\n\n🛍️ BOUTIQUE E-COMMERCE — PRODUITS AVEC PHOTOS DISPONIBLES :\n${prodLines}\n👉 RÈGLE D'ENVOI AUTOMATIQUE DE PHOTO PRODUIT : Dès que tu proposes ou présentes l'un de ces produits au client (ou si le client demande à voir les articles / photos / modèles), ajoute OBLIGATOIREMENT à la fin de ton message le code exact [PHOTO:ID_DU_PRODUIT] (par exemple [PHOTO:${botConfig.products[0].id}]). Le système enverra automatiquement la vraie photo de ce produit au client sur WhatsApp !`;
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

    const perms = getPlanPermsForUser(userId);
    const contactNote = perms.allowAdvancedFilter ? getContactCustomNote(contactJid, botConfig.contactNotes) : null;
    const systemPrompt = buildSystemInstruction(botConfig, contactNote, perms.allowCatalog, perms.allowProductPhotos);

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
  const rawReply = (data.candidates?.[0]?.content?.parts?.[0]?.text || "Je n'ai pas pu générer de réponse.").trim();
  const { cleanReply, matchedProducts } = extractProductPhotosFromReply(rawReply, botConfig.products);

  history.push({ role: 'user', text: userMessage });
  history.push({ role: 'model', text: cleanReply });
  playgroundMemory.set(userId, history.slice(-20));

  return {
    reply: cleanReply,
    images: matchedProducts.map(p => ({ name: p.name, price: p.price, imageDataUrl: p.imageDataUrl })),
    history: playgroundMemory.get(userId)
  };
}

// Démarrer le bot WhatsApp d'un utilisateur
function isCredsPaired(creds) {
  return Boolean(creds && (creds.account || creds.registered || (creds.me?.id && creds.me.id.includes(':'))));
}

async function startBot(userId, botConfig, pairingPhone = null) {
  if (activeBots.has(userId)) {
    const existing = activeBots.get(userId);
    if (existing.isConnected) {
      return { alreadyRunning: true, phone: existing.phone };
    }
    existing.stopped = true;
    try { existing.sock?.end(); } catch (e) {}
    activeBots.delete(userId);
  }

  const sessionPath = getSessionPath(userId);
  if (pairingPhone) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      fs.mkdirSync(sessionPath, { recursive: true });
    } catch (e) {}
  } else {
    // Si une ancienne tentative de code par numéro n'a pas abouti (creds.me sans creds.account), nettoyer pour éviter l'erreur 401
    try {
      const credsFile = path.join(sessionPath, 'creds.json');
      if (fs.existsSync(credsFile)) {
        const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        if (credsData && credsData.me && !isCredsPaired(credsData)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          fs.mkdirSync(sessionPath, { recursive: true });
        }
      }
    } catch (e) {}
  }

  const botState = {
    sock: null,
    qrDataUrl: null,
    pairingCode: null,
    pairingRequested: false,
    pairingPhone: pairingPhone ? String(pairingPhone).replace(/[^0-9]/g, '') : null,
    stopped: false,
    isConnected: false,
    phone: null,
    config: botConfig,
    messagesHandled: 0,
    startedAt: new Date().toISOString(),
    humanTakeover: new Map(),
    pendingTimers: new Map(),
    botSentIds: new Set()
  };
  activeBots.set(userId, botState);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    syncFullHistory: false,
  });

  botState.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (botState.stopped || activeBots.get(userId) !== botState) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
      console.log(`[WhaBot] 📱 QR généré pour user: ${userId}`);
      if (botState.pairingPhone && !botState.pairingRequested && !isCredsPaired(sock.authState.creds)) {
        botState.pairingRequested = true;
        setTimeout(async () => {
          if (botState.stopped) return;
          try {
            const rawCode = await sock.requestPairingCode(botState.pairingPhone);
            botState.pairingCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            console.log(`[WhaBot] 🔑 Code d'appairage généré pour +${botState.pairingPhone} : ${botState.pairingCode}`);
          } catch (err) {
            console.error(`[WhaBot] ❌ Erreur requestPairingCode:`, err.message);
          }
        }, 1500);
      }
    }

    if (connection === 'close') {
      if (botState.stopped || activeBots.get(userId) !== botState) return;
      botState.isConnected = false;
      botState.qrDataUrl = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isPaired = isCredsPaired(sock.authState?.creds);
      const shouldReconnect = (statusCode === 515) || (isPaired && statusCode !== DisconnectReason.loggedOut);
      console.log(`[WhaBot] ⚠️ Bot ${userId} déconnecté (code: ${statusCode}, paired: ${isPaired}). Reconnexion: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => {
          if (!botState.stopped) startBot(userId, botState.config);
        }, statusCode === 515 ? 1500 : 4000);
      } else {
        activeBots.delete(userId);
      }
    } else if (connection === 'open') {
      botState.isConnected = true;
      botState.qrDataUrl = null;
      botState.pairingCode = null;
      botState.phone = sock.user?.id?.split(':')[0]?.split('@')[0];
      if (botState.phone) {
        const u = db.findUserById(userId);
        if (u && !u.phone) db.updateUser(userId, { phone: botState.phone });
      }
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
      const myPhone = (sock.user?.id || '').split(':')[0].split('@')[0];
      const myLid = (sock.user?.lid || '').split(':')[0].split('@')[0];
      const remotePhone = remoteJid.split(':')[0].split('@')[0];
      const isSelfChat = msg.key.fromMe && (
        remotePhone === myPhone ||
        remoteJid.includes(myPhone) ||
        (myLid && (remotePhone === myLid || remoteJid.includes(myLid)))
      );

      console.log(`[Bot ${userId}] 📩 Événement message de ${remoteJid} (fromMe=${msg.key.fromMe}, selfChat=${isSelfChat}): "${text}"`);
      const perms = getPlanPermsForUser(userId);

      // CAS 1 : LE PROPRIÉTAIRE RÉPOND LUI-MÊME À UN CLIENT EXTERNE DEPUIS SON TÉLÉPHONE (RELAIS HUMAIN)
      if (msg.key.fromMe && !isSelfChat) {
        // Annuler un éventuel minuteur de mode absence en cours
        if (botState.pendingTimers.has(remoteJid)) {
          clearTimeout(botState.pendingTimers.get(remoteJid).timer);
          botState.pendingTimers.delete(remoteJid);
          console.log(`[Bot ${userId}] 🛑 Propriétaire a répondu à ${remoteJid} -> Minuteur annulé.`);
        }
        if (text) {
          recordChatMessage(userId, remoteJid, 'model', `[Conseiller Humain] ${text}`);
          const pauseMin = perms.allowHumanTakeover ? Number(cfg.humanPauseMinutes ?? 15) : 0;
          if (pauseMin > 0) {
            botState.humanTakeover.set(remoteJid, Date.now() + pauseMin * 60 * 1000);
            console.log(`[Bot ${userId}] 🤝 Relais humain activé pour ${pauseMin} min sur ${remoteJid}`);
          }
        }
        continue;
      }

      // CAS 2 : VÉRIFIER FILTRAGE (LISTE NOIRE / LISTE BLANCHE)
      if (perms.allowAdvancedFilter) {
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

      if (hasImage && perms.allowImages && cfg.enableImages !== false) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          if (buffer) {
            const rawMime = msg.message.imageMessage?.mimetype || 'image/jpeg';
            mediaData = { mimeType: rawMime.split(';')[0].trim(), base64: buffer.toString('base64') };
          }
        } catch (e) {
          console.error(`[Bot ${userId}] Erreur téléchargement image:`, e.message);
        }
      } else if (hasAudio && perms.allowVoice && cfg.enableVoice !== false) {
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
          const usr = db.findUserById(userId);
          if (usr) {
            if (usr.isActive === false) {
              console.log(`[Bot ${userId}] ⛔ Compte suspendu (${usr.email}). Réponse IA ignorée.`);
              return;
            }
            const used = Number(usr.messagesUsed || 0);
            const max = Number(usr.maxMessages ?? 20);
            if (!usr.isAdmin && used >= max) {
              console.log(`[Bot ${userId}] ⛔ Quota d'essai atteint (${used}/${max}) pour ${usr.email}.`);
              return;
            }
          }

          await sock.readMessages([lastMsgObj.key]);
          await sock.sendPresenceUpdate('composing', remoteJid);
          const rawReply = await askGemini(userId, cfg, remoteJid, combinedText, mediaObj, pushName);
          const { cleanReply, matchedProducts } = extractProductPhotosFromReply(rawReply, cfg.products);

          if (matchedProducts.length > 0) {
            for (let i = 0; i < matchedProducts.length; i++) {
              const prod = matchedProducts[i];
              const base64Part = (prod.imageDataUrl || '').split(',')[1];
              if (base64Part) {
                const imgBuffer = Buffer.from(base64Part, 'base64');
                const captionText = i === 0 ? cleanReply : `🛍️ *${prod.name}* — ${prod.price}`;
                const sentImg = await sock.sendMessage(remoteJid, { image: imgBuffer, caption: captionText }, i === 0 ? { quoted: lastMsgObj } : undefined);
                if (sentImg?.key?.id) {
                  botState.botSentIds.add(sentImg.key.id);
                  setTimeout(() => botState.botSentIds.delete(sentImg.key.id), 120000);
                }
              }
            }
          } else {
            const sent = await sock.sendMessage(remoteJid, { text: cleanReply }, { quoted: lastMsgObj });
            if (sent?.key?.id) {
              botState.botSentIds.add(sent.key.id);
              setTimeout(() => botState.botSentIds.delete(sent.key.id), 120000);
            }
          }
          await sock.sendPresenceUpdate('available', remoteJid);
          botState.messagesHandled++;
          if (usr) {
            db.updateUser(userId, { messagesUsed: Number(usr.messagesUsed || 0) + 1 });
          }
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
  bot.stopped = true;
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
  const usr = db.findUserById(userId);
  const convs = loadConversations(userId);
  const contactCount = Object.keys(convs).length;
  const messagesUsed = usr ? Number(usr.messagesUsed || 0) : (bot?.messagesHandled || 0);
  const maxMessages = usr ? Number(usr.maxMessages ?? 20) : 20;
  const quotaReached = usr && !usr.isAdmin && messagesUsed >= maxMessages;

  if (!bot) return { running: false, isConnected: false, contactCount, messagesHandled: messagesUsed, maxMessages, quotaReached };
  return {
    running: true,
    isConnected: bot.isConnected,
    phone: bot.phone,
    pairingCode: bot.pairingCode,
    messagesHandled: messagesUsed,
    maxMessages,
    quotaReached,
    contactCount,
    startedAt: bot.startedAt,
    hasQR: !!bot.qrDataUrl
  };
}

async function requestPairingCode(userId, phoneNumber, botConfig) {
  const existing = activeBots.get(userId);
  if (existing && existing.isConnected) {
    throw new Error(`Votre WhatsApp (+${existing.phone}) est déjà connecté ! Cliquez d'abord sur 'Arrêter' si vous voulez changer de numéro.`);
  }
  let cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');
  // Au Bénin (+229), les comptes WhatsApp sont enregistrés en 229 + 8 chiffres (sans le préfixe 01)
  if (cleanPhone.startsWith('22901') && cleanPhone.length === 13) {
    cleanPhone = '229' + cleanPhone.slice(5);
  }
  if (cleanPhone.length < 8) {
    throw new Error('Numéro WhatsApp invalide (ex: 22962836380).');
  }
  await startBot(userId, botConfig, cleanPhone);
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 500));
    const bot = activeBots.get(userId);
    if (bot?.pairingCode) {
      return { code: bot.pairingCode, phone: cleanPhone };
    }
  }
  throw new Error('Délai dépassé pour générer le code. Vérifiez le numéro et réessayez.');
}

async function restoreAllBots(users) {
  for (const u of users) {
    try {
      const credsFile = path.join(getSessionPath(u.id), 'creds.json');
      if (fs.existsSync(credsFile)) {
        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        if (isCredsPaired(creds)) {
          console.log(`[WhaBot] 🔄 Restauration automatique du bot de ${u.email}...`);
          await startBot(u.id, { ...(u.botConfig || {}), isActive: true });
        }
      }
    } catch (e) {}
  }
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

// Envoyer un code de récupération de mot de passe via un bot WhatsApp actif sur la plateforme
async function sendPasswordResetWhatsApp(targetPhone, resetCode, userName = '') {
  let cleanPhone = String(targetPhone || '').replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('22901') && cleanPhone.length === 13) {
    cleanPhone = '229' + cleanPhone.slice(5);
  }
  if (cleanPhone.length === 8) {
    cleanPhone = '229' + cleanPhone;
  }
  const jid = `${cleanPhone}@s.whatsapp.net`;

  const msgText = `🔐 *WhaBot Pro — Récupération de mot de passe*\n\nBonjour ${userName || ''},\nVoici votre code de sécurité à 6 chiffres pour réinitialiser votre mot de passe :\n\n👉 *${resetCode}*\n\n_(Ce code est valable pendant 15 minutes)_`;

  // 1. Chercher un bot connecté sur WhaBot Pro
  let senderBot = null;
  for (const [, b] of activeBots.entries()) {
    if (b && b.isConnected && b.sock) {
      senderBot = b;
      break;
    }
  }
  if (senderBot) {
    const sent = await senderBot.sock.sendMessage(jid, { text: msgText });
    if (sent?.key?.id) {
      senderBot.botSentIds.add(sent.key.id);
      setTimeout(() => senderBot.botSentIds.delete(sent.key.id), 120000);
    }
    return { sentViaWhatsApp: true, phone: cleanPhone };
  }

  // 2. Relais automatique via l'assistante principale Maya (port 3000) si aucun bot n'est actif sur le port 4000
  try {
    const fallbackRes = await fetch('http://localhost:3000/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, text: msgText })
    });
    const fbData = await fallbackRes.json();
    if (fbData && fbData.ok) {
      return { sentViaWhatsApp: true, phone: cleanPhone };
    }
  } catch (e) {}

  return { sentViaWhatsApp: false };
}

module.exports = {
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
  sendPasswordResetWhatsApp,
  activeBots
};
