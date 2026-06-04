const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits } = require('discord.js'); // On importe Discord

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// -------------------------------------------------------------
// 1. BASE DE DONNÉES POSTGRESQL (RENDER)
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// -------------------------------------------------------------
// 2. LE BOT DISCORD
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Événement : Quand le bot s'allume
client.once('ready', () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);
});

// Événement : Quand un message est envoyé sur le serveur Discord
client.on('messageCreate', async (message) => {
    // On ignore les messages des autres bots et ceux qui ne commencent pas par "!"
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // COMMANDES DE TEST : !ban, !mute, !warn
    // Syntaxe attendue sur Discord : !ban @Pseudo Raison du ban
    if (command === 'ban' || command === 'mute' || command === 'warn') {
        const target = message.mentions.members.first();
        
        if (!target) {
            return message.reply("❌ Tu dois mentionner un utilisateur ! Exemple : `!ban @Pseudo raison`");
        }

        // On récupère la raison (tout ce qui est écrit après la mention)
        const reason = args.slice(1).join(' ') || "Aucune raison spécifiée";
        const moderator = message.author.tag;
        const username = target.user.username;
        const user_id = target.id;

        try {
            if (command === 'ban') {
                // 1. Action réelle sur Discord
                await target.ban({ reason: reason });
                // 2. Sauvegarde automatique dans Render SQL
                await pool.query(
                    'INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                    [username, user_id, reason, moderator]
                );
                message.channel.send(`🔨 **${username}** a été banni et ajouté au site web !`);
            } 
            
            else if (command === 'mute') {
                // Pour le mute, on ajoute par défaut une durée fixe de 24h pour le site
                await pool.query(
                    'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                    [username, user_id, reason, moderator, '24 Heures']
                );
                message.channel.send(`🔇 **${username}** a été muté et ajouté au site web !`);
            } 
            
            else if (command === 'warn') {
                await pool.query(
                    'INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                    [username, user_id, reason, moderator]
                );
                message.channel.send(`⚠️ **${username}** a reçu un avertissement et cela apparaît sur le site web !`);
            }

        } catch (err) {
            console.error(err);
            message.reply("❌ Impossible d'exécuter la commande. Vérifie mes permissions (rôle Administrateur).");
        }
    }
});

// On connecte le bot avec le Token secret qui sera caché sur Render
client.login(process.env.DISCORD_TOKEN);


// -------------------------------------------------------------
// 3. SITE WEB API (TES ROUTES SONT INCHANGÉES)
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sanctions', async (req, res) => {
    const { type, username, user_id, reason, moderator, duration } = req.body;
    try {
        if (type === 'mute') {
            await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, duration || 'Non spécifiée']);
        } else if (type === 'warn') {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        } else if (type === 'ban') {
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sanctions/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        await pool.query(`DELETE FROM ${type} WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur en ligne sur le port ${PORT} 🚀`);
});