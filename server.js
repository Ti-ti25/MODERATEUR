const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');
const session = require('express-session');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// -------------------------------------------------------------
// SESSION (nécessaire pour l'OAuth2)
// -------------------------------------------------------------
app.use(session({
    secret: process.env.SESSION_SECRET || 'changeme_super_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true sur Render (HTTPS)
        maxAge: 1000 * 60 * 60 * 24 // 24h
    }
}));
 
// MODIFICATION : On ne sert en accès libre que le dossier public (qui contient login.html)
// On ne met PAS "app.use(express.static(__dirname))" sinon tout le site est en accès libre !
app.use(express.static(path.join(__dirname, 'public')));
 
// -------------------------------------------------------------
// VARIABLES D'ENVIRONNEMENT
// -------------------------------------------------------------
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
 
// Database Postgres
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
 
// -------------------------------------------------------------
// BOT DISCORD (pour appliquer les sanctions en direct)
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers
    ]
});
 
client.login(BOT_TOKEN).catch(err => console.error("❌ Échec login Bot Discord :", err));
 
client.once('ready', () => {
    console.log(`🤖 Bot Discord connecté en tant que ${client.user.tag}`);
});
 
// -------------------------------------------------------------
// MIDDLEWARE DE SÉCURITÉ
// -------------------------------------------------------------
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    // Si pas connecté, on redirige vers la page de login
    res.redirect('/login.html');
}
 
// -------------------------------------------------------------
// 3. OAUTH2 DISCORD (CONNEXION)
// -------------------------------------------------------------
app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});
 
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Code de connexion manquant.");
 
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
 
        const tokenData = await tokenResponse.json();
        if (tokenData.error) {
            console.error("Token error:", tokenData);
            return res.send("Erreur lors de la récupération du token Discord.");
        }
 
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();
 
        // Sauvegarde de l'utilisateur dans la session
        req.session.user = {
            id: userData.id,
            username: userData.username,
            avatar: userData.avatar
        };
 
        console.log(`🔑 ${userData.username} s'est connecté au panel.`);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.send("Erreur serveur pendant l'authentification.");
    }
});
 
app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});
 
// -------------------------------------------------------------
// 4. SITE WEB — ROUTES PROTEGEES (Vérifiées par requireAuth)
// -------------------------------------------------------------
 
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
 
app.get('/index.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
 
app.get('/warns.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'warns.html'));
});
 
app.get('/bans.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'bans.html'));
});
 
// Route d'accès à la page de login (publique)
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
 
// -------------------------------------------------------------
// API — GESTION DES SANCTIONS (PROTEGEE)
// -------------------------------------------------------------
 
// Récupérer les mutes
app.get('/api/sanctions/mutes', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM mutes ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
// Récupérer les warns
app.get('/api/sanctions/warns', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM warns ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
// Récupérer les bans
app.get('/api/sanctions/bans', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bans ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
// Supprimer une sanction (et agir sur Discord si nécessaire)
app.delete('/api/sanctions/:table/:id', requireAuth, async (req, res) => {
    const { table, id } = req.params;
    const validTables = ['mutes', 'warns', 'bans'];
 
    if (!validTables.includes(table)) {
        return res.status(400).json({ error: "Table invalide" });
    }
 
    try {
        // 1. On récupère d'abord l'ID Discord de l'utilisateur de la sanction avant de supprimer la ligne
        const dataQuery = await pool.query(`SELECT user_id FROM ${table} WHERE id = $1`, [id]);
        
        if (dataQuery.rows.length > 0) {
            const userIdDiscord = dataQuery.rows[0].user_id;
            const guild = client.guilds.cache.get(GUILD_ID);
 
            if (guild) {
                if (table === 'mutes') {
                    try {
                        const member = await guild.members.fetch(userIdDiscord).catch(() => null);
                        if (member && member.communicationDisabledUntilTimestamp) {
                            await member.timeout(null, "Sanction annulée depuis le site web");
                            console.log(`🔊 Unmute appliqué pour ${member.user.username}`);
                        }
                    } catch { console.log("⚠️ Impossible d'unmute sur Discord."); }
                } else if (table === 'bans') {
                    try {
                        await guild.bans.remove(userIdDiscord, "Sanction annulée depuis le site web");
                        console.log(`🔓 Unban appliqué pour l'ID ${userIdDiscord}`);
                    } catch { console.log("⚠️ Impossible d'unban sur Discord."); }
                }
            }
        }
 
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        console.log(`✅ Ligne ID ${id} supprimée de ${table}.`);
        return res.json({ success: true });
    } catch (err) {
        console.error("❌ Erreur suppression :", err);
        return res.status(500).json({ error: err.message });
    }
});
 
// -------------------------------------------------------------
// 5. DÉMARRAGE DU SERVEUR
// -------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});
