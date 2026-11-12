// ============================================================
//  WhaBot SaaS — Base de données locale (fichier JSON)
//  Sera remplacé par Supabase en production
// ============================================================
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'users.json');

function loadDB() {
  try {
    if (!fs.existsSync(path.dirname(DB_PATH))) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return { users: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

module.exports = {
  // Trouver un user par email
  findUserByEmail(email) {
    const db = loadDB();
    return db.users.find(u => u.email === email) || null;
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

  // Lister tous les users (admin)
  getAllUsers() {
    return loadDB().users;
  }
};
