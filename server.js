const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const GUILD_ID = process.env.GUILD_ID; 

// 1. CONNEXION BASE DE DONNÉES
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 2. CONFIGURATION DU BOT DISCORD
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages // Nécessaire pour envoyer des MP
    ]
});

// Définition des commandes slash
const commands = [
    {
        name: 'warn',
        description: 'Mettre un avertissement à un membre et lui envoyer un MP',
        options: [
            { name: 'membre', description: 'Le membre à avertir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison de l\'avertissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'mute',
        description: 'Rendre muet un membre et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à rendre muet', type: ApplicationCommandOptionType.User, required: true },
            { name: 'duree', description: 'Exemples: 15m, 2h, 1d', type: ApplicationCommandOptionType.String, required: true },
            { name: 'motif', description: 'La raison du mute', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'ban',
        description: 'Bannir un membre et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à bannir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison du bannissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    }
];

// Synchronisation des commandes au démarrage (Correction v15)
client.once('clientReady', async () => {
    console.log(`🤖 Bot connecté : ${client.user.tag}`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Commandes Discord synchronisées !');
    } catch (error) {
        console.error('❌ Erreur synchro commandes:', error);
    }
});

// Gestion des commandes reçues
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const targetMember = interaction.options.getMember('membre');
    const reason = interaction.options.getString('motif');

    await interaction.deferReply();

    if (!targetMember) {
        return interaction.editReply("❌ Membre introuvable.");
    }

    const moderator = interaction.user.tag;
    const username = targetMember.user.username;
    const user_id = targetMember.id;

    // --- COMMANDE /WARN ---
    if (commandName === 'warn') {
        let mpEnvoye = true;

        // Envoi du MP à l'utilisateur
        try {
            await targetMember.send(`⚠️ **Avertissement reçu**\n\nTu as reçu un avertissement.\n**Raison :** ${reason}\n**Modérateur :** ${moderator}`);
        } catch (err) {
            console.log(`⚠️ MP bloqués pour ${username}`);
            mpEnvoye = false;
        }

        // Enregistrement sur le site (BDD)
        try {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(mpEnvoye 
                ? `⚠️ **${username}** a été averti et notifié en MP !`
                : `⚠️ **${username}** a été averti sur le site ! (Mais ses MP sont fermés).`
            );
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur de base de données.");
        }
    }

    // --- COMMANDE /MUTE ---
    if (commandName === 'mute') {
        const timeArg = interaction.options.getString('duree').toLowerCase().trim();
        try {
            let totalMs = 0;
            const daysMatch = timeArg.match(/(\d+)d/);
            const hoursMatch = timeArg.match(/(\d+)h/);
            const minsMatch = timeArg.match(/(\d+)m/);

            if (daysMatch) totalMs += parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
            if (hoursMatch) totalMs += parseInt(hoursMatch[1]) * 60 * 60 * 1000;
            if (minsMatch) totalMs += parseInt(minsMatch[1]) * 60 * 1000;

            if (totalMs === 0) return interaction.editReply("❌ Format invalide (ex: 15m, 2h).");

            await targetMember.timeout(totalMs, reason);
            await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, timeArg]);
            return interaction.editReply(`🔇 **${username}** a été muté (${timeArg}) et ajouté au site !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Impossible de mute ce membre.");
        }
    }

    // --- COMMANDE /BAN ---
    if (commandName === 'ban') {
        try {
            await targetMember.ban({ reason: reason });
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(`🔨 **${username}** a été banni et ajouté au site !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Impossible de bannir ce membre.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// 3. API DU SITE WEB
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// Récupérer les sanctions pour les afficher sur le site
app.get('/api/sanctions/:type', async (req, res) => {
    let type = req.params.type.toLowerCase();
    if (!type.endsWith('s')) type += 's';
    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprimer une sanction depuis le site (Bouton Retirer ❌)
app.delete('/api/sanctions/:table/:id', async (req, res) => {
    const { table, id } = req.params;
    try {
        const data = await pool.query(`SELECT user_id FROM ${table} WHERE id = $1`, [id]);
        if (data.rows.length > 0 && GUILD_ID) {
            const userId = data.rows[0].user_id;
            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            if (guild) {
                if (table === 'mutes') {
                    const member = await guild.members.fetch(userId).catch(() => null);
                    if (member) await member.timeout(null).catch(() => null);
                } else if (table === 'bans') {
                    await guild.bans.remove(userId).catch(() => null);
                }
            }
        }
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => { console.log(`🚀 Serveur actif sur le port ${PORT}`); });
