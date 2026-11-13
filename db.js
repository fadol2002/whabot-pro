// ============================================================
//  WhaBot SaaS — Base de données locale (fichier JSON)
//  Sera remplacé par Supabase en production
// ============================================================
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'users.json');

const DEFAULT_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: '5 000',
    period: 'FCFA / mois',
    maxMessages: 500,
    maxStorageMB: 10,
    isPopular: false,
    allowCatalog: true,
    allowTemplates: true,
    allowPlayground: true,
    allowCRM: true,
    allowHumanTakeover: true,
    allowVoice: false,
    allowImages: false,
    allowProductPhotos: true,
    allowAdvancedFilter: false,
    features: [
      '1 Numéro WhatsApp connecté',
      '500 réponses IA / mois',
      '💾 10 Mo d\'espace de stockage Boutique',
      '📦 Catalogue produits & FAQ sur-mesure',
      '⚡ Modèles métiers en 1 clic',
      '🧪 Simulateur IA Live inclus',
      '👥 Mini-CRM & Messagerie Live',
      '🤝 Relais humain automatique (Pause 15 min)'
    ]
  },
  {
    id: 'pro',
    name: 'Pro Illimité',
    price: '15 000',
    period: 'FCFA / mois',
    maxMessages: 999999,
    maxStorageMB: 50,
    isPopular: true,
    allowCatalog: true,
    allowTemplates: true,
    allowPlayground: true,
    allowCRM: true,
    allowHumanTakeover: true,
    allowVoice: true,
    allowImages: true,
    allowProductPhotos: true,
    allowAdvancedFilter: true,
    features: [
      '1 Numéro WhatsApp connecté',
      'Messages IA illimités 24h/24',
      '💾 50 Mo d\'espace de stockage Boutique',
      '📦 Catalogue produits & FAQ sur-mesure',
      '🛍️ Catalogue Photos Produits (Envoi auto par l\'IA)',
      '⚡ Modèles métiers en 1 clic',
      '🧪 Simulateur IA Live inclus',
      '👥 Mini-CRM & Messagerie Live',
      '🤝 Relais humain automatique (Pause 15 min)',
      '🎙️ Lecture des Notes Vocales WhatsApp',
      '📸 Analyse d\'Images & Reçus Mobile Money',
      '🛡️ Liste Noire, Liste Blanche & Consignes VIP'
    ]
  },
  {
    id: 'business',
    name: 'Business Agence',
    price: '35 000',
    period: 'FCFA / mois',
    maxMessages: 999999,
    maxStorageMB: 200,
    isPopular: false,
    allowCatalog: true,
    allowTemplates: true,
    allowPlayground: true,
    allowCRM: true,
    allowHumanTakeover: true,
    allowVoice: true,
    allowImages: true,
    allowProductPhotos: true,
    allowAdvancedFilter: true,
    features: [
      '1 Numéro WhatsApp connecté',
      'Messages IA illimités 24h/24',
      '💾 200 Mo d\'espace de stockage Boutique',
      '📦 Catalogue produits & FAQ sur-mesure',
      '🛍️ Catalogue Photos Produits (Envoi auto par l\'IA)',
      '⚡ Modèles métiers en 1 clic',
      '🧪 Simulateur IA Live inclus',
      '👥 Mini-CRM & Messagerie Live',
      '🤝 Relais humain automatique (Pause 15 min)',
      '🎙️ Lecture des Notes Vocales WhatsApp',
      '📸 Analyse d\'Images & Reçus Mobile Money',
      '🛡️ Liste Noire, Liste Blanche & Consignes VIP',
      '⭐ Support prioritaire & Configuration VIP'
    ]
  }
];

function loadDB() {
  try {
    if (!fs.existsSync(path.dirname(DB_PATH))) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], plans: DEFAULT_PLANS }, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!Array.isArray(data.plans) || data.plans.length === 0) {
      data.plans = DEFAULT_PLANS;
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
    return data;
  } catch (e) {
    return { users: [], plans: DEFAULT_PLANS };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

module.exports = {
  // Trouver un user par email
  findUserByEmail(email) {
    const db = loadDB();
    const target = String(email || '').trim().toLowerCase();
    return db.users.find(u => (u.email || '').toLowerCase() === target) || null;
  },

  // Trouver un user par email OU par numéro de téléphone
  findUserByIdentifier(identifier) {
    const db = loadDB();
    const raw = String(identifier || '').trim();
    if (!raw) return null;
    if (raw.includes('@')) {
      return db.users.find(u => (u.email || '').toLowerCase() === raw.toLowerCase()) || null;
    }
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits.length < 7) return null;
    const last8 = digits.slice(-8);
    return db.users.find(u => {
      const uPhone = String(u.phone || '').replace(/[^0-9]/g, '');
      return uPhone && (uPhone === digits || (uPhone.length >= 8 && uPhone.slice(-8) === last8));
    }) || null;
  },

  // Trouver un user par ID
  findUserById(id) {
    const db = loadDB();
    return db.users.find(u => u.id === id) || null;
  },

  // Créer un user
  createUser(user) {
    const db = loadDB();
    db.users.push(user);
    saveDB(db);
    return user;
  },

  // Mettre à jour un user
  updateUser(id, updates) {
    const db = loadDB();
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    db.users[idx] = { ...db.users[idx], ...updates };
    saveDB(db);
    return db.users[idx];
  },

  // Supprimer un user
  deleteUser(id) {
    const db = loadDB();
    db.users = db.users.filter(u => u.id !== id);
    saveDB(db);
    return true;
  },

  // Lister tous les users (admin)
  getAllUsers() {
    return loadDB().users;
  },

  // Lister tous les forfaits (public & admin)
  getPlans() {
    return loadDB().plans || DEFAULT_PLANS;
  },

  // Ajouter ou modifier un forfait (admin)
  savePlan(plan) {
    const db = loadDB();
    if (!Array.isArray(db.plans)) db.plans = [...DEFAULT_PLANS];
    const id = plan.id || ('plan-' + Date.now());
    const normalized = {
      id,
      name: String(plan.name || 'Nouveau Forfait').trim(),
      price: String(plan.price || '10 000').trim(),
      period: String(plan.period || 'FCFA / mois').trim(),
      maxMessages: Number(plan.maxMessages) || 500,
      maxStorageMB: Math.max(1, Number(plan.maxStorageMB) || 10),
      isPopular: !!plan.isPopular,
      allowCatalog: plan.allowCatalog !== false,
      allowTemplates: plan.allowTemplates !== false,
      allowPlayground: plan.allowPlayground !== false,
      allowCRM: plan.allowCRM !== false,
      allowHumanTakeover: plan.allowHumanTakeover !== false,
      allowVoice: !!plan.allowVoice,
      allowImages: !!plan.allowImages,
      allowProductPhotos: plan.allowProductPhotos !== false,
      allowAdvancedFilter: !!plan.allowAdvancedFilter,
      features: Array.isArray(plan.features) ? plan.features.filter(Boolean) : []
    };
    const idx = db.plans.findIndex(p => p.id === id);
    if (idx >= 0) {
      db.plans[idx] = normalized;
    } else {
      db.plans.push(normalized);
    }
    saveDB(db);
    return db.plans;
  },

  // Supprimer un forfait (admin)
  deletePlan(id) {
    const db = loadDB();
    if (!Array.isArray(db.plans)) return [];
    db.plans = db.plans.filter(p => p.id !== id);
    saveDB(db);
    return db.plans;
  },

  // Calculer l'espace de stockage utilisé par un user (en Mo)
  getUserStorageUsedMB(user) {
    if (!user) return 0;
    let bytes = Buffer.byteLength(JSON.stringify(user.botConfig || {}), 'utf8');
    try {
      const convFile = path.join(__dirname, 'data', 'conversations', `${user.id}.json`);
      if (fs.existsSync(convFile)) {
        bytes += fs.statSync(convFile).size;
      }
    } catch (e) {}
    return Number((bytes / (1024 * 1024)).toFixed(2));
  }
};
