const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS mutes (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                user_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                moderator TEXT NOT NULL,
                duration TEXT NOT NULL,
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS warns (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                user_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                moderator TEXT NOT NULL,
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS bans (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                user_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                moderator TEXT NOT NULL,
                date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Base de données Discord initialisée avec succès ! 🛡️");
    } catch (err) {
        console.error("Erreur d'initialisation SQL :", err);
    }
};
initDb();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. LIRE LES SANCTIONS
app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    if (!['mutes', 'warns', 'bans'].includes(type)) return res.status(400).json({ error: "Type invalide" });

    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. AJOUTER UNE SANCTION
app.post('/api/sanctions', async (req, res) => {
    const { type, username, user_id, reason, moderator, duration } = req.body;

    try {
        if (type === 'mute') {
            await pool.query(
                'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                [username, user_id, reason, moderator, duration || 'Non spécifiée']
            );
        } else if (type === 'warn') {
            await pool.query(
                'INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                [username, user_id, reason, moderator]
            );
        } else if (type === 'ban') {
            await pool.query(
                'INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                [username, user_id, reason, moderator]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. SUPPRIMER UNE SANCTION (Nouveau !)
app.delete('/api/sanctions/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    if (!['mutes', 'warns', 'bans'].includes(type)) return res.status(400).json({ error: "Type invalide" });

    try {
        await pool.query(`DELETE FROM ${type} WHERE id = $1`, [id]);
        res.json({ success: true, message: "Supprimé avec succès !" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. MODIFIER UNE SANCTION (Nouveau !)
app.put('/api/sanctions/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { reason, duration } = req.body;
    if (!['mutes', 'warns', 'bans'].includes(type)) return res.status(400).json({ error: "Type invalide" });

    try {
        if (type === 'mute') {
            await pool.query('UPDATE mutes SET reason = $1, duration = $2 WHERE id = $3', [reason, duration, id]);
        } else {
            await pool.query(`UPDATE ${type} SET reason = $1 WHERE id = $2`, [reason, id]);
        }
        res.json({ success: true, message: "Mis à jour avec succès !" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur Discord lancé sur le port ${PORT} 🚀`);
});