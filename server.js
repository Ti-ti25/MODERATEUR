const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');

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
            {
                name: 'membre',
                description: 'Le membre à avertir',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'motif',
                description: 'La raison de l\'avertissement',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    },
    {
        name: 'mute',
        description: 'Rendre muet (Timeout) un membre sur Discord et l\'ajouter au site',
        options: [
            {
                name: 'membre',
                description: 'Le membre à rendre muet',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'duree',
                description: 'La durée du mute (ex: 15m, 2h, 2h15m, 1d12h)',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'motif',
                description: 'La raison du mute',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    },
    {
        name: 'ban',
        description: 'Bannir définitivement un membre de Discord et l\'ajouter au site',
        options: [
            {
                name: 'membre',
                description: 'Le membre à bannir',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'motif',
                description: 'La raison du bannissement',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    }
];

client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        console.log('🔄 Enregistrement des commandes Slash...');
        
        // Supprime proprement les anciennes commandes globales au cas où
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        
        // Enregistre les nouvelles
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

    // --- COMMANDE /MUTE (INTELLIGENTE) ---
    if (commandName === 'mute') {
        const timeArg = interaction.options.getString('duree').toLowerCase().trim();
        await interaction.deferReply();

        try {
            let totalMs = 0;
            
            // Système d'analyse intelligent (Regex) pour tout cumuler
            const daysMatch = timeArg.match(/(\d+)d/);
            const hoursMatch = timeArg.match(/(\d+)h/);
            const minsMatch = timeArg.match(/(\d+)m/);

            if (daysMatch) totalMs += parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
            if (hoursMatch) totalMs += parseInt(hoursMatch[1]) * 60 * 60 * 1000;
            if (minsMatch) totalMs += parseInt(minsMatch[1]) * 60 * 1000;

            // Si le format entré est n'importe quoi
            if (totalMs === 0) {
                return interaction.editReply("❌ Format de durée invalide ! Utilise par exemple : `15m`, `2h`, `2h15m` ou `1d12h`.");
            }

            // Création d'un joli texte pour la base de données et le site web
            let durationParts = [];
            if (daysMatch) durationParts.push(`${daysMatch[1]} Jour(s)`);
            if (hoursMatch) durationParts.push(`${hoursMatch[1]} Heure(s)`);
            if (minsMatch) durationParts.push(`${minsMatch[1]} Minute(s)`);
            const durationText = durationParts.join(' et ');

            // Application du timeout sur Discord
            await targetMember.timeout(totalMs, reason);

            // Envoi au site
            await pool.query(
                'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                [username, user_id, reason, moderator, durationText]
            );
            return interaction.editReply(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);

        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur lors du mute. Vérifie que mon rôle est bien tout en haut.");
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
// 3. SITE WEB API
// -------------------------------------------------------------
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/api/sanctions/:type', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${req.params.type} ORDER BY date_added DESC`);
        res.json(result.rows);
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
app.delete('/api/sanctions/:type/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM ${req.params.type} WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.listen(PORT, () => { console.log(`Serveur en ligne sur le port ${PORT} 🚀`); });