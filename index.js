// language: JavaScript, file: index.js, target: node 20+, discord.js-selfbot-v13
// *self-bot: logs in with YOUR user token. violates Discord ToS. use an alt.
const { Client } = require('discord.js-selfbot-v13');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const CONFIG_PATH    = path.join(__dirname, 'afk.json');
const HEARTBEAT_PATH = path.join(__dirname, 'heartbeat.txt');

function loadCfg() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch { return { guildId: null, channelId: null }; }
}
function saveCfg(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

let CONFIG = loadCfg();

const client = new Client({
    checkUpdate: false,
    ws: { properties: { $browser: 'Discord Client' } },
    restRequestTimeout: 30_000,
});

const TOKEN = process.env.TOKEN;
if (!TOKEN) { console.error('no TOKEN env var'); process.exit(1); }

function beat() { try { fs.writeFileSync(HEARTBEAT_PATH, String(Date.now())); } catch {} }
setInterval(beat, 15_000); beat();

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    const inVc = isInAfkChannel();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ok: true, tag: client.user?.tag || null, vc: CONFIG.channelId,
        inVc, uptime: process.uptime(), beat: Date.now(),
    }));
}).listen(PORT, () => console.log(`[http] keepalive on :${PORT}`));

function parseChannelRef(input) {
    if (!input) return null;
    input = input.trim();
    if (/^\d{17,20}$/.test(input)) return { id: input, guildId: null };
    const m = input.match(/channels\/(\d{17,20})\/(\d{17,20})/);
    if (m) return { guildId: m[1], id: m[2] };
    return null;
}

async function resolveChannel(ref) {
    try {
        const ch = await client.channels.fetch(ref.id);
        if (ch && (ch.type === 'GUILD_VOICE' || ch.type === 'GUILD_STAGE_VOICE')) return ch;
    } catch {}
    for (const [, guild] of client.guilds.cache) {
        if (ref.guildId && guild.id !== ref.guildId) continue;
        try {
            const ch = await guild.channels.fetch(ref.id);
            if (ch && (ch.type === 'GUILD_VOICE' || ch.type === 'GUILD_STAGE_VOICE')) return ch;
        } catch {}
    }
    return null;
}

function isInAfkChannel() {
    if (!CONFIG.channelId) return false;
    const ch = client.channels.cache.get(CONFIG.channelId);
    const me = ch?.guild?.members?.me;
    return me?.voice?.channelId === CONFIG.channelId;
}

let joinLock = false, joinAttempts = 0;

async function joinAfk() {
    if (joinLock || !CONFIG.channelId) return;
    joinLock = true;
    try {
        const ch = await resolveChannel({ id: CONFIG.channelId, guildId: CONFIG.guildId });
        if (!ch) { console.log('[afk] channel not resolvable'); return; }
        const me = ch.guild?.members?.me;
        if (me?.voice?.channelId === ch.id) { joinAttempts = 0; return; }
        await client.voice.joinChannel(ch, { selfMute: true, selfDeaf: true, selfVideo: false });
        console.log(`[afk] joined ${ch.guild?.name} / ${ch.name}`);
        joinAttempts = 0;
    } catch (e) {
        joinAttempts++;
        const backoff = Math.min(2000 * joinAttempts, 30_000);
        console.log(`[afk] join err (${joinAttempts}, retry ${backoff}ms): ${e.message}`);
        setTimeout(joinAfk, backoff);
    } finally { joinLock = false; }
}

client.on('voiceStateUpdate', (oldS, newS) => {
    if (newS.id !== client.user?.id) return;
    if (!CONFIG.channelId) return;
    if (newS.channelId !== CONFIG.channelId) {
        console.log(`[afk] out of target (${newS.channelId || 'disconnected'}) — rejoin in 2s`);
        setTimeout(joinAfk, 2000);
    }
});

setInterval(() => {
    if (!CONFIG.channelId) return;
    if (!isInAfkChannel()) { console.log('[watchdog] rejoin'); joinAfk(); }
}, 20_000);

client.on('shardResume',    () => { console.log('[gateway] resumed');   setTimeout(joinAfk, 1500); });
client.on('shardReconnect', () => { console.log('[gateway] reconnect'); });
client.on('shardReady',     () => { console.log('[gateway] ready');     setTimeout(joinAfk, 1500); });
client.on('shardDisconnect', e => { console.log('[gateway] disconnect', e?.code); });
client.on('error',       e => console.log('[err]', e?.message));
client.on('invalidated', () => { console.log('[fatal] session invalidated — token dead or flagged'); });

// ---------- commands ----------
const PREFIX = '!';

function isAuthorized(authorId) {
    const ownerId = process.env.OWNER_ID;
    const selfId  = client.user?.id;
    if (!authorId) return false;
    if (selfId  && authorId === selfId)  return true;   // the bot account itself
    if (ownerId && authorId === ownerId) return true;   // external owner
    return false;
}

client.on('messageCreate', async (msg) => {
    if (msg.content?.startsWith('!')) {
        console.log(`[cmd] from ${msg.author.id} (${msg.author.username}): ${msg.content}`);
    }
    if (!msg.content?.startsWith(PREFIX)) return;
    if (!isAuthorized(msg.author?.id)) return;

    const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const c = cmd.toLowerCase();

    if (c === 'setafk') {
        const ref = parseChannelRef(args[0]);
        if (!ref) {
            await msg.reply('usage: `!setafk <vc-id|vc-link>`').catch(()=>{});
            return;
        }
        await msg.reply(`entered, tracing vs for \`${args[0]}\`...`).catch(()=>{});

        const ch = await resolveChannel(ref);
        if (!ch) {
            await msg.reply(`fail: couldn't resolve \`${args[0]}\` — is this account a member of that server?`).catch(()=>{});
            return;
        }

        CONFIG = { guildId: ch.guild?.id || ref.guildId, channelId: ch.id };
        saveCfg(CONFIG);

        const targetId = ch.id;
        const joined = new Promise(resolve => {
            const t = setTimeout(() => resolve(false), 8000);
            const handler = (o, n) => {
                if (n.id !== client.user?.id) return;
                if (n.channelId === targetId) {
                    clearTimeout(t);
                    client.off('voiceStateUpdate', handler);
                    resolve(true);
                }
            };
            client.on('voiceStateUpdate', handler);
        });

        joinAfk();

        const ok = await joined;
        if (ok) {
            await msg.reply(`success: joined **${ch.guild?.name} / ${ch.name}** ✅`).catch(()=>{});
        } else {
            await msg.reply(`entered, but join didn't confirm in 8s — check console.`).catch(()=>{});
        }
        return;
    }

    if (c === 'afkstatus') {
        const ch = client.channels.cache.get(CONFIG.channelId);
        const me = ch?.guild?.members?.me;
        const inIt = me?.voice?.channelId === CONFIG.channelId;
        return msg.reply(CONFIG.channelId
            ? `vc: **${ch?.guild?.name} / ${ch?.name}** — ${inIt ? 'joined ✅' : 'not joined ❌'}`
            : 'no vc set').catch(()=>{});
    }

    if (c === 'afkleave') {
        CONFIG = { guildId: null, channelId: null };
        saveCfg(CONFIG);
        try { client.voice?.disconnect?.(); } catch {}
        return msg.reply('left and cleared.').catch(()=>{});
    }

    if (c === 'afkping') return msg.reply('pong').catch(()=>{});
});

client.on('ready', async () => {
    console.log(`[self-bot] ${client.user.tag} (${client.user.id})`);
    if (CONFIG.channelId) { console.log('[afk] resuming saved vc'); joinAfk(); }
});

client.login(TOKEN).catch(err => {
    console.error('login failed:', err.message);
    process.exit(1);
});

process.on('unhandledRejection', e => console.log('[warn] unhandled:', e?.message || e));
process.on('uncaughtException',  e => console.log('[warn] uncaught:',  e?.message || e));
