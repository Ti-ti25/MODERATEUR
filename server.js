const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits } = require('discord.js');
const session = require('express-session');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// -------------------------------------------------------------
// CONFIGURATION DE LA SESSION
// -------------------------------------------------------------
app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'phrase_secrete_par_defaut_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        maxAge: 1000 * 60 * 60 * 24 // 24h
    }
}));
 
// -------------------------------------------------------------
// VARIABLES D'ENVIRONNEMENT
// -------------------------------------------------------------
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const MODERATOR_ROLE_ID = process.env.MODERATOR_ROLE_ID; // 👈 Ton nouveau rôle configuré sur Render
 
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
 
// -------------------------------------------------------------
// BOT DISCORD
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers // ⚠️ Assure-toi que cette case "Server Members Intent" est bien cochée sur le Discord Developer Portal !
    ]
});
 
client.login(BOT_TOKEN).catch(err => console.error("❌ Erreur de token Bot Discord :", err));
 
client.once('ready', () => {
    console.log(`🤖 Bot Discord en ligne : ${client.user.tag}`);
});
 
// -------------------------------------------------------------
// MIDDLEWARE DE VÉRIFICATION
// -------------------------------------------------------------
async function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect('/login.html');
    }

    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return res.status(500).send("Erreur de configuration Discord.");

        const member = await guild.members.fetch({ user: req.session.user.id, force: true });
        
        if (member && member.roles.cache.has(MODERATOR_ROLE_ID)) {
            return next();
        } else {
            req.session.destroy();
            // On le redirige vers le login avec l'erreur "norole" dans l'URL
            return res.redirect('/login.html?error=norole');
        }
    } catch (error) {
        console.error(error);
        req.session.destroy();
        return res.redirect('/login.html');
    }
}
 
// -------------------------------------------------------------
// FLUX OAUTH2 DISCORD WITH ROLE CHECK
// -------------------------------------------------------------
app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});
 
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Erreur : Code de connexion manquant.");
 
    try {
        // 1. Échange du code contre un Token
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
            console.error("Erreur Token Discord :", tokenData);
            return res.send("Erreur d'authentification.");
        }
 
        // 2. Récupération de l'identité de l'utilisateur
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();
 
        // 3. VÉRIFICATION DU RÔLE MODÉRATEUR SUR LE SERVEUR DISCORD
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error("❌ Le bot n'est pas présent sur le serveur configuré (GUILD_ID).");
            return res.send("Erreur de configuration : Le bot n'est pas sur le serveur Discord.");
        }
 
        // On récupère le membre en direct sur le serveur Discord
        let member;
        try {
            member = await guild.members.fetch(userData.id);
        } catch (e) {
            // Si l'utilisateur n'est même pas sur le serveur Discord
            return res.send("Accès refusé : Vous ne faites pas partie du serveur Discord.");
        }
 
        // On regarde si le membre possède l'ID du rôle modérateur
        const hasRole = member.roles.cache.has(MODERATOR_ROLE_ID);
        
        if (!hasRole) {
            console.log(`🚫 Accès refusé pour ${userData.username} : Rôle modérateur manquant.`);
            return res.send("Accès refusé : Vous n'avez pas le rôle requis pour accéder au Panel Staff.");
        }
 
        // 4. Si tout est bon, on crée la session
        req.session.user = {
            id: userData.id,
            username: userData.username
        };
 
        console.log(`🔑 Connexion validée pour le modérateur : ${userData.username}`);
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.send("Erreur interne du serveur lors de la vérification de vos permissions.");
    }
});
 
app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});
 
// -------------------------------------------------------------
// PAGES DU SITE WEB
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
 
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
 
// -------------------------------------------------------------
// ROUTES DE L'API
// -------------------------------------------------------------
app.get('/api/sanctions/mutes', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM mutes ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.get('/api/sanctions/warns', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM warns ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.get('/api/sanctions/bans', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bans ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.delete('/api/sanctions/:table/:id', requireAuth, async (req, res) => {
    const { table, id } = req.params;
    if (!['mutes', 'warns', 'bans'].includes(table)) return res.status(400).json({ error: "Table invalide" });
 
    try {
        const dataQuery = await pool.query(`SELECT user_id FROM ${table} WHERE id = $1`, [id]);
        
        if (dataQuery.rows.length > 0) {
            const userIdDiscord = dataQuery.rows[0].user_id;
            const guild = client.guilds.cache.get(GUILD_ID);
 
            if (guild) {
                if (table === 'mutes') {
                    try {
                        const member = await guild.members.fetch(userIdDiscord).catch(() => null);
                        if (member && member.communicationDisabledUntilTimestamp) {
                            await member.timeout(null, "Sanction retirée du site");
                        }
                    } catch { console.log("Impossible d'unmute sur Discord."); }
                } else if (table === 'bans') {
                    try { await guild.bans.remove(userIdDiscord, "Sanction retirée du site"); } catch { console.log("Impossible d'unban."); }
                }
            }
        }
 
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
 
app.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
});
