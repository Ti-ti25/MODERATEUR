const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ID de ton serveur Discord principal pour retrouver les membres lors du nettoyage
const GUILD_ID = process.env.GUILD_ID; 

// -------------------------------------------------------------
// 1. BASE DE DONNÉES POSTGRESQL (RENDER)
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// -------------------------------------------------------------
// 2. LE BOT DISCORD & ENREGISTREMENT DES COMMANDES SLASH
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

const commands = [
    {
        name: 'warn',
        description: 'Mettre un avertissement à un membre et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à avertir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison de l\'avertissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'mute',
        description: 'Rendre muet (Timeout) un membre sur Discord et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à rendre muet', type: ApplicationCommandOptionType.User, required: true },
            { name: 'duree', description: 'La durée du mute (ex: 15m, 2h, 2h15m, 1d12h)', type: ApplicationCommandOptionType.String, required: true },
            { name: 'motif', description: 'La raison du mute', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'ban',
        description: 'Bannir définitivement un membre de Discord et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à bannir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison du bannissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    }
];

client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Toutes les commandes Slash individuelles sont synchronisées !');
    } catch (error) {
        console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const targetMember = interaction.options.getMember('membre');
    const reason = interaction.options.getString('motif');

    if (!targetMember) {
        return interaction.reply({ content: "❌ Impossible de trouver ce membre sur le serveur.", ephemeral: true });
    }

    const moderator = interaction.user.tag;
    const username = targetMember.user.username;
    const user_id = targetMember.id;

    // --- COMMANDE /WARN ---
    if (commandName === 'warn') {
        await interaction.deferReply();
        try {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(`⚠️ **${username}** a reçu un avertissement et cela apparaît sur le site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur de base de données.");
        }
    }

    // --- COMMANDE /MUTE ---
    if (commandName === 'mute') {
        const timeArg = interaction.options.getString('duree').toLowerCase().trim();
        await interaction.deferReply();

        try {
            let totalMs = 0;
            const daysMatch = timeArg.match(/(\d+)d/);
            const hoursMatch = timeArg.match(/(\d+)h/);
            const minsMatch = timeArg.match(/(\d+)m/);

            if (daysMatch) totalMs += parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
            if (hoursMatch) totalMs += parseInt(hoursMatch[1]) * 60 * 60 * 1000;
            if (minsMatch) totalMs += parseInt(minsMatch[1]) * 60 * 1000;

            if (totalMs === 0) {
                return interaction.editReply("❌ Format de durée invalide ! Exemple : `15m`, `2h`, `2h15m` ou `1d12h`.");
            }

            let durationParts = [];
            if (daysMatch) durationParts.push(`${daysMatch[1]} Jour(s)`);
            if (hoursMatch) durationParts.push(`${hoursMatch[1]} Heure(s)`);
            if (minsMatch) durationParts.push(`${minsMatch[1]} Minute(s)`);
            const durationText = durationParts.join(' et ');

            await targetMember.timeout(totalMs, reason);

            await pool.query(
                'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                [username, user_id, reason, moderator, durationText]
            );
            return interaction.editReply(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur lors du mute. Vérifie ma hiérarchie.");
        }
    }

    // --- COMMANDE /BAN ---
    if (commandName === 'ban') {
        await interaction.deferReply();
        try {
            await targetMember.ban({ reason: reason });
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(`🔨 **${username}** a été banni de Discord et ajouté au site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Impossible de bannir ce membre.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// -------------------------------------------------------------
// 3. SITE WEB API (AVEC NETTOYAGE ET SYNCHRONISATION)
// -------------------------------------------------------------
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// Route pour afficher la liste (Nettoie automatiquement les mutes terminés)
app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        let rows = result.rows;

        // Si le site demande les mutes, on vérifie si certains sont terminés sur Discord
        if (type === 'mute' && GUILD_ID) {
            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            if (guild) {
                for (const row of rows) {
                    const member = await guild.members.fetch(row.user_id).catch(() => null);
                    // Si le membre n'est plus muté sur Discord ou est parti, on l'efface de la DB
                    if (!member || !member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) {
                        await pool.query('DELETE FROM mutes WHERE id = $1', [row.id]);
                    }
                }
                // On recharge la liste propre après le nettoyage
                const updatedResult = await pool.query(`SELECT * FROM mutes ORDER BY date_added DESC`);
                rows = updatedResult.rows;
            }
        }

        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sanctions', async (req, res) => {
    const { type, username, user_id, reason, moderator, duration } = req.body;
    try {
        if (type === 'mute') await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, duration || 'Non spécifiée']);
        else if (type === 'warn') await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        else if (type === 'ban') await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprimer une sanction depuis le site (Retire AUSSI la sanction sur Discord !)
app.delete('/api/sanctions/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        // 1. On cherche d'abord l'ID Discord de l'utilisateur concerné dans notre DB
        const data = await pool.query(`SELECT user_id FROM ${type} WHERE id = $1`, [id]);
        
        if (data.rows.length > 0 && GUILD_ID) {
            const userIdDiscord = data.rows[0].user_id;
            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);

            if (guild) {
                // Si on supprime un MUTE sur le site -> On unmute sur Discord
                if (type === 'mute') {
                    const member = await guild.members.fetch(userIdDiscord).catch(() => null);
                    if (member) await member.timeout(null, "Sanction retirée depuis le site web");
                } 
                // Si on supprime un BAN sur le site -> On unban sur Discord
                else if (type === 'ban') {
                    await guild.bans.remove(userIdDiscord, "Sanction retirée depuis le site web").catch(() => null);
                }
            }
        }

        // 2. On le supprime enfin du site web (Base de données)
        await pool.query(`DELETE FROM ${type} WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});

app.listen(PORT, () => { console.log(`Serveur en ligne sur le port ${PORT} 🚀`); });