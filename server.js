const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits } = require('discord.js');

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

client.once('ready', () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);
});

client.on('messageCreate', async (message) => {
    // On ignore les messages des bots et ceux qui ne commencent pas par "!"
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'ban' || command === 'mute' || command === 'warn') {
        const target = message.mentions.members.first();
        
        if (!target) {
            return message.reply("❌ Tu dois mentionner un utilisateur ! Exemple : `!mute @Pseudo 30m raison`");
        }

        const moderator = message.author.tag;
        const username = target.user.username;
        const user_id = target.id;

        try {
            // --- COMMANDE BAN ---
            if (command === 'ban') {
                const reason = args.slice(1).join(' ') || "Aucune raison spécifiée";
                
                await target.ban({ reason: reason });
                
                await pool.query(
                    'INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                    [username, user_id, reason, moderator]
                );
                
                message.channel.send(`🔨 **${username}** a été banni de Discord et ajouté au site web !`);
                await message.delete(); // Supprime ton message !ban automatiquement
            } 
            
            // --- COMMANDE MUTE ---
            else if (command === 'mute') {
                const timeArg = args[1]; 
                let ms = 0;
                let durationText = "24 Heures";

                if (timeArg) {
                    const timeValue = parseInt(timeArg);
                    const timeUnit = timeArg.slice(-1).toLowerCase();

                    if (timeUnit === 'm') {
                        ms = timeValue * 60 * 1000;
                        durationText = `${timeValue} Minute(s)`;
                    } else if (timeUnit === 'h') {
                        ms = timeValue * 60 * 60 * 1000;
                        durationText = `${timeValue} Heure(s)`;
                    } else if (timeUnit === 'd') {
                        ms = timeValue * 24 * 60 * 60 * 1000;
                        durationText = `${timeValue} Jour(s)`;
                    }
                }

                if (ms === 0) {
                    ms = 24 * 60 * 60 * 1000; 
                    durationText = "24 Heures";
                }

                const reason = args.slice(2).join(' ') || "Aucune raison spécifiée";

                await target.timeout(ms, reason);

                await pool.query(
                    'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                    [username, user_id, reason, moderator, durationText]
                );
                
                message.channel.send(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);
                await message.delete(); // Supprime ton message !mute automatiquement
            } 
            
            // --- COMMANDE WARN ---
            else if (command === 'warn') {
                const reason = args.slice(1).join(' ') || "Aucune raison spécifiée";
                
                await pool.query(
                    'INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                    [username, user_id, reason, moderator]
                );
                
                message.channel.send(`⚠️ **${username}** a reçu un avertissement et cela apparaît sur le site web !`);
                await message.delete(); // Supprime ton message !warn automatiquement
            }

        } catch (err) {
            console.error(err);
            message.reply("❌ Impossible d'exécuter la commande. Vérifie mes permissions (rôle Administrateur).");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// -------------------------------------------------------------
// 3. SITE WEB API (ROUTES POUR LES PAGES HTML)
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Récupérer la liste des sanctions
app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ajouter une sanction via le formulaire du site
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

// Supprimer (Unban / Unmute / Retirer un warn) via le site web
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