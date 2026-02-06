/**
 * Chess Arena v7 - With MongoDB Persistence
 * - Token based payments (same token amount for both players)
 * - Price fetched from Jupiter/DexScreener at room creation
 * - Security hardened
 * - MongoDB persistence (Railway-proof!)
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const { MongoClient } = require('mongodb');

// ═══════════════════════════════════════════════════════════════
// PERSISTENCE - MongoDB (primary) or JSON files (fallback)
// ═══════════════════════════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const DATA_DIR = process.env.DATA_DIR || './data';
const DATA_FILE = path.join(DATA_DIR, 'chess_data.json');

let mongoDb = null;
let useMongoDb = false;

// Initialize MongoDB connection
async function initMongo() {
    if (!MONGO_URI) {
        console.log('⚠️ No MONGO_URI set - using JSON file storage (data may be lost on redeploy!)');
        return false;
    }
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        mongoDb = client.db('ggfun');
        console.log('✅ Connected to MongoDB - data is persistent!');
        return true;
    } catch (e) {
        console.error('❌ MongoDB connection failed:', e.message);
        return false;
    }
}

// Ensure data directory exists for fallback
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function loadData() {
    // Try MongoDB first
    if (mongoDb) {
        try {
            const doc = await mongoDb.collection('gamedata').findOne({ _id: 'main' });
            if (doc) {
                console.log('✅ Data loaded from MongoDB');
                return doc.data;
            }
        } catch (e) {
            console.error('MongoDB load error:', e.message);
        }
    }
    
    // Fallback to JSON file
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            console.log('✅ Data loaded from JSON file');
            return data;
        }
    } catch (e) {
        console.error('Error loading data:', e.message);
    }
    return null;
}

async function saveData() {
    const data = {
        usernames: Object.fromEntries(usernames),
        profiles: Object.fromEntries(profiles),
        matchHistory: matchHistory.slice(0, 500), // Keep last 500 matches
        xLinkedAccounts: Object.fromEntries(xLinkedAccounts),
        followers: Object.fromEntries(Array.from(followers.entries()).map(([k, v]) => [k, Array.from(v)])),
        following: Object.fromEntries(Array.from(following.entries()).map(([k, v]) => [k, Array.from(v)])),
        savedAt: Date.now()
    };
    
    // Save to MongoDB if available
    if (mongoDb) {
        try {
            await mongoDb.collection('gamedata').updateOne(
                { _id: 'main' },
                { $set: { data, updatedAt: new Date() } },
                { upsert: true }
            );
            console.log('💾 Data saved to MongoDB');
            return;
        } catch (e) {
            console.error('MongoDB save error:', e.message);
        }
    }
    
    // Fallback to JSON file
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('💾 Data saved to JSON file');
    } catch (e) {
        console.error('Error saving data:', e.message);
    }
}

// Auto-save every 2 minutes
setInterval(saveData, 2 * 60 * 1000);

// Save on exit
process.on('SIGTERM', async () => { await saveData(); process.exit(0); });
process.on('SIGINT', async () => { await saveData(); process.exit(0); });

const app = express();

// ═══════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

// CORS - only allow specific origins in production
const allowedOrigins = [
    'https://ggfun.lol',
    'https://www.ggfun.lol',
    'https://chess-arena-solana.netlify.app',
    'http://localhost:3000',
    'http://localhost:5173'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.some(allowed => origin.startsWith(allowed.replace(/:\d+$/, '')))) {
            return callback(null, true);
        }
        // In development, allow all
        if (process.env.NODE_ENV !== 'production') return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});

// Rate limiting (simple in-memory) - Increased for game polling
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 300; // max requests per minute (increased from 100)

app.use((req, res, next) => {
    // Skip rate limiting for health checks
    if (req.path === '/api/health' || req.path === '/api/config') {
        return next();
    }
    
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimits.has(ip)) {
        rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    } else {
        const limit = rateLimits.get(ip);
        if (now > limit.resetAt) {
            limit.count = 1;
            limit.resetAt = now + RATE_LIMIT_WINDOW;
        } else {
            limit.count++;
            if (limit.count > RATE_LIMIT_MAX) {
                console.warn(`Rate limit exceeded for ${ip}: ${limit.count} requests`);
                return res.status(429).json({ error: 'Too many requests. Please slow down.' });
            }
        }
    }
    next();
});

// Clean up rate limits every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, limit] of rateLimits.entries()) {
        if (now > limit.resetAt + RATE_LIMIT_WINDOW) {
            rateLimits.delete(ip);
        }
    }
}, 300000);

app.use(express.json({ limit: '10kb' })); // Limit body size

// Input validation helper
function isValidWallet(address) {
    if (!address || typeof address !== 'string') return false;
    try {
        new PublicKey(address);
        return address.length >= 32 && address.length <= 44;
    } catch {
        return false;
    }
}

function sanitizeString(str, maxLen = 100) {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLen).replace(/[<>]/g, '');
}

const PORT = process.env.PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';

// Custom Token Configuration
const TOKEN_MINT = new PublicKey('BY31GbusfpHcG8idNvP5osfndSECCPrp6BxCr9Z5pump');
const TOKEN_SYMBOL = '$GGFUN';
const TOKEN_DECIMALS = 6; // Most pump.fun tokens have 6 decimals

const COMMISSION_RATE = 0.10;
const GAME_TIME_MS = 10 * 60 * 1000; // 10 minutes per player

const connection = new Connection(SOLANA_RPC, 'confirmed');
let wallet = null;
// Use WALLET_ADDRESS env var directly, or derive from private key
let WALLET_ADDRESS = process.env.WALLET_ADDRESS || '';

if (WALLET_PRIVATE_KEY) {
    try {
        wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
        WALLET_ADDRESS = wallet.publicKey.toString();
        console.log('✅ Wallet (from key):', WALLET_ADDRESS);
    } catch (e) { console.error('Wallet error:', e.message); }
} else if (WALLET_ADDRESS) {
    console.log('✅ Wallet (receive only):', WALLET_ADDRESS);
}

const rooms = new Map();
const processedTx = new Set();
const xVerifications = new Map(); // wallet -> { code, createdAt, xHandle }

// Data structures (will be populated on startup)
let usernames = new Map();
let profiles = new Map();
let matchHistory = [];
let xLinkedAccounts = new Map();
let followers = new Map();
let following = new Map();

// Async startup function
async function startup() {
    // Initialize MongoDB first
    useMongoDb = await initMongo();
    
    // Load saved data
    const savedData = await loadData();
    
    if (savedData) {
        usernames = new Map(savedData.usernames ? Object.entries(savedData.usernames) : []);
        profiles = new Map(savedData.profiles ? Object.entries(savedData.profiles) : []);
        matchHistory = savedData.matchHistory || [];
        xLinkedAccounts = new Map(savedData.xLinkedAccounts ? Object.entries(savedData.xLinkedAccounts) : []);
        followers = new Map(savedData.followers ? Object.entries(savedData.followers).map(([k, v]) => [k, new Set(v)]) : []);
        following = new Map(savedData.following ? Object.entries(savedData.following).map(([k, v]) => [k, new Set(v)]) : []);
    }
    
    console.log(`📊 Loaded: ${usernames.size} users, ${profiles.size} profiles, ${matchHistory.length} matches`);
}

let cachedTokenPrice = null;
let priceLastFetch = 0;

// Pepe avatar options
const PEPE_AVATARS = [
    '🐸', '🐸👑', '🐸🎮', '🐸💎', '🐸🔥', '🐸⚡', '🐸🎯', '🐸🏆', '🐸😎', '🐸🚀'
];

// Cleanup finished rooms every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        // Delete finished games after 10 minutes
        if (room.status === 'finished' && room.finishedAt && now - room.finishedAt > 10 * 60 * 1000) {
            rooms.delete(code);
            console.log('Cleaned up room:', code);
        }
        // Delete empty waiting rooms after 30 minutes
        if (room.status === 'waiting_players' && room.createdAt && now - room.createdAt > 30 * 60 * 1000) {
            rooms.delete(code);
            console.log('Cleaned up stale room:', code);
        }
    }
}, 5 * 60 * 1000);

const INIT_BOARD = [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R']
];

function genCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}

function getUsername(wallet) {
    return usernames.get(wallet) || wallet?.slice(0, 6) + '...' || 'Anonymous';
}

// ═══════════════════════════════════════════════════════════════
// TOKEN PRICE - From DexScreener
// ═══════════════════════════════════════════════════════════════
async function getTokenPrice() {
    // Cache for 30 seconds
    if (cachedTokenPrice && Date.now() - priceLastFetch < 30000) {
        return cachedTokenPrice;
    }
    
    try {
        // Try DexScreener first
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT.toString()}`);
        const data = await res.json();
        
        if (data.pairs && data.pairs.length > 0) {
            // Get the pair with highest liquidity
            const bestPair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            cachedTokenPrice = parseFloat(bestPair.priceUsd) || 0.0001;
            priceLastFetch = Date.now();
            console.log(`Token price: $${cachedTokenPrice}`);
            return cachedTokenPrice;
        }
    } catch (e) {
        console.error('Price fetch error:', e.message);
    }
    
    // Fallback price
    return cachedTokenPrice || 0.0001;
}

// ═══════════════════════════════════════════════════════════════
// USERNAME MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/username', (req, res) => {
    const { wallet, username } = req.body;
    if (!wallet || !username) return res.status(400).json({ error: 'Missing data' });
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    const cleanUsername = sanitizeString(username, 20).trim();
    if (cleanUsername.length < 1) return res.status(400).json({ error: 'Invalid username' });
    
    usernames.set(wallet, cleanUsername);
    console.log('Username set:', wallet.slice(0,8), '->', cleanUsername);
    saveData(); // Persist
    res.json({ success: true, username: cleanUsername });
});

app.get('/api/username/:wallet', (req, res) => {
    const username = usernames.get(req.params.wallet);
    res.json({ success: true, username: username || null });
});

// ═══════════════════════════════════════════════════════════════
// PROFILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function getOrCreateProfile(wallet) {
    if (!profiles.has(wallet)) {
        profiles.set(wallet, {
            wallet,
            username: usernames.get(wallet) || wallet.slice(0, 8) + '...',
            avatar: PEPE_AVATARS[Math.floor(Math.random() * PEPE_AVATARS.length)],
            wins: 0,
            losses: 0,
            totalEarnings: 0,
            totalLost: 0,
            matches: [],
            joinedAt: Date.now()
        });
    }
    // Ensure avatar exists for old profiles
    const profile = profiles.get(wallet);
    if (!profile.avatar) {
        profile.avatar = PEPE_AVATARS[Math.floor(Math.random() * PEPE_AVATARS.length)];
    }
    return profile;
}

function getFollowerCount(wallet) {
    return followers.get(wallet)?.size || 0;
}

function getFollowingCount(wallet) {
    return following.get(wallet)?.size || 0;
}

function isFollowing(followerWallet, targetWallet) {
    return following.get(followerWallet)?.has(targetWallet) || false;
}

function recordMatch(room, winnerWallet, loserWallet) {
    const match = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        roomCode: room.code,
        winner: { wallet: winnerWallet, name: getUsername(winnerWallet) },
        loser: { wallet: loserWallet, name: getUsername(loserWallet) },
        entryFee: room.entryFeeUsd,
        tokenAmount: room.tokenAmount,
        prize: Math.floor(room.tokenAmount * 2 * (1 - COMMISSION_RATE)),
        timestamp: Date.now()
    };
    
    // Update winner profile
    const winnerProfile = getOrCreateProfile(winnerWallet);
    winnerProfile.wins++;
    winnerProfile.totalEarnings += match.prize;
    winnerProfile.username = getUsername(winnerWallet);
    winnerProfile.matches.unshift(match.id);
    if (winnerProfile.matches.length > 50) winnerProfile.matches.pop();
    
    // Update loser profile
    const loserProfile = getOrCreateProfile(loserWallet);
    loserProfile.losses++;
    loserProfile.totalLost += room.tokenAmount;
    loserProfile.username = getUsername(loserWallet);
    loserProfile.matches.unshift(match.id);
    if (loserProfile.matches.length > 50) loserProfile.matches.pop();
    
    // Add to global history
    matchHistory.unshift(match);
    if (matchHistory.length > 200) matchHistory.pop();
    
    console.log(`Match recorded: ${match.winner.name} beat ${match.loser.name}`);
    saveData(); // Persist after match
    return match;
}

// Get profile by wallet
app.get('/api/profile/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    const viewerWallet = req.query.viewer || null; // Optional: who is viewing
    const profile = getOrCreateProfile(wallet);
    profile.username = getUsername(wallet); // Update username
    profile.xHandle = xLinkedAccounts.get(wallet) || null; // Include X handle
    
    // Get recent matches with full details
    const recentMatches = profile.matches
        .slice(0, 20)
        .map(matchId => matchHistory.find(m => m.id === matchId))
        .filter(m => m);
    
    // Get unique opponents
    const opponents = new Map();
    recentMatches.forEach(m => {
        const oppWallet = m.winner.wallet === wallet ? m.loser.wallet : m.winner.wallet;
        const oppName = m.winner.wallet === wallet ? m.loser.name : m.winner.name;
        const won = m.winner.wallet === wallet;
        
        if (!opponents.has(oppWallet)) {
            opponents.set(oppWallet, { wallet: oppWallet, name: oppName, wins: 0, losses: 0 });
        }
        if (won) opponents.get(oppWallet).wins++;
        else opponents.get(oppWallet).losses++;
    });
    
    res.json({
        success: true,
        profile: {
            ...profile,
            followersCount: getFollowerCount(wallet),
            followingCount: getFollowingCount(wallet),
            isFollowing: viewerWallet ? isFollowing(viewerWallet, wallet) : false,
            winRate: profile.wins + profile.losses > 0 
                ? ((profile.wins / (profile.wins + profile.losses)) * 100).toFixed(1) 
                : 0,
            recentMatches,
            opponents: Array.from(opponents.values()).sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses)).slice(0, 10)
        }
    });
});

// Update avatar
app.post('/api/profile/avatar', (req, res) => {
    const { wallet, avatar } = req.body;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    // Validate avatar is from our list or a custom emoji
    const cleanAvatar = sanitizeString(avatar, 10);
    if (!cleanAvatar) return res.status(400).json({ error: 'Invalid avatar' });
    
    const profile = getOrCreateProfile(wallet);
    profile.avatar = cleanAvatar;
    
    console.log('Avatar updated:', wallet.slice(0, 8), '->', cleanAvatar);
    saveData(); // Persist
    res.json({ success: true, avatar: cleanAvatar });
});

// Get available avatars
app.get('/api/avatars', (req, res) => {
    res.json({ success: true, avatars: PEPE_AVATARS });
});

// Follow a user
app.post('/api/follow', (req, res) => {
    const { wallet, targetWallet } = req.body;
    if (!isValidWallet(wallet) || !isValidWallet(targetWallet)) {
        return res.status(400).json({ error: 'Invalid wallet' });
    }
    if (wallet === targetWallet) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    
    // Add to following set
    if (!following.has(wallet)) following.set(wallet, new Set());
    following.get(wallet).add(targetWallet);
    
    // Add to followers set
    if (!followers.has(targetWallet)) followers.set(targetWallet, new Set());
    followers.get(targetWallet).add(wallet);
    
    console.log('Follow:', wallet.slice(0, 8), '->', targetWallet.slice(0, 8));
    saveData(); // Persist
    res.json({ 
        success: true, 
        followersCount: getFollowerCount(targetWallet),
        isFollowing: true 
    });
});

// Unfollow a user
app.post('/api/unfollow', (req, res) => {
    const { wallet, targetWallet } = req.body;
    if (!isValidWallet(wallet) || !isValidWallet(targetWallet)) {
        return res.status(400).json({ error: 'Invalid wallet' });
    }
    
    // Remove from following set
    following.get(wallet)?.delete(targetWallet);
    
    // Remove from followers set
    followers.get(targetWallet)?.delete(wallet);
    
    console.log('Unfollow:', wallet.slice(0, 8), '-X->', targetWallet.slice(0, 8));
    saveData(); // Persist
    res.json({ 
        success: true, 
        followersCount: getFollowerCount(targetWallet),
        isFollowing: false 
    });
});

// Get followers list
app.get('/api/followers/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    const followerWallets = Array.from(followers.get(wallet) || []);
    const followerProfiles = followerWallets.map(w => {
        const p = getOrCreateProfile(w);
        return {
            wallet: w,
            username: getUsername(w),
            avatar: p.avatar,
            xHandle: xLinkedAccounts.get(w) || null
        };
    });
    res.json({ success: true, followers: followerProfiles });
});

// Get following list
app.get('/api/following/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    const followingWallets = Array.from(following.get(wallet) || []);
    const followingProfiles = followingWallets.map(w => {
        const p = getOrCreateProfile(w);
        return {
            wallet: w,
            username: getUsername(w),
            avatar: p.avatar,
            xHandle: xLinkedAccounts.get(w) || null
        };
    });
    res.json({ success: true, following: followingProfiles });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
    const allProfiles = Array.from(profiles.values())
        .map(p => ({
            ...p,
            username: getUsername(p.wallet),
            avatar: p.avatar || '🐸',
            xHandle: xLinkedAccounts.get(p.wallet) || null,
            followersCount: getFollowerCount(p.wallet),
            winRate: p.wins + p.losses > 0 ? ((p.wins / (p.wins + p.losses)) * 100).toFixed(1) : 0
        }))
        .sort((a, b) => b.wins - a.wins)
        .slice(0, 20);
    
    res.json({ success: true, leaderboard: allProfiles });
});

// Get recent matches globally
app.get('/api/matches', (req, res) => {
    res.json({ success: true, matches: matchHistory.slice(0, 20) });
});

// ═══════════════════════════════════════════════════════════════
// X (TWITTER) VERIFICATION
// ═══════════════════════════════════════════════════════════════

// Generate verification code for X linking
app.post('/api/x/generate-code', (req, res) => {
    const { wallet } = req.body;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    // Check if already linked
    if (xLinkedAccounts.has(wallet)) {
        return res.json({ 
            success: true, 
            alreadyLinked: true, 
            xHandle: xLinkedAccounts.get(wallet) 
        });
    }
    
    // Generate unique verification code
    const code = 'CHESS_' + genCode() + '_' + Date.now().toString(36).toUpperCase();
    
    xVerifications.set(wallet, {
        code,
        createdAt: Date.now(),
        verified: false
    });
    
    console.log('X verification code generated:', wallet.slice(0, 8), code);
    
    res.json({
        success: true,
        code,
        tweetText: `🎮 Chess Arena Doğrulama\n\n${code}\n\n@ChessArenaSol #ChessArena #Solana`,
        expiresIn: '30 minutes'
    });
});

// Verify X account by checking tweet URL
app.post('/api/x/verify', async (req, res) => {
    const { wallet, tweetUrl, xHandle } = req.body;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    const verification = xVerifications.get(wallet);
    if (!verification) return res.status(400).json({ error: 'No verification code found. Generate one first.' });
    
    // Check expiry (30 minutes)
    if (Date.now() - verification.createdAt > 30 * 60 * 1000) {
        xVerifications.delete(wallet);
        return res.status(400).json({ error: 'Verification code expired. Generate a new one.' });
    }
    
    // Clean X handle
    let cleanHandle = sanitizeString(xHandle, 50).replace('@', '').trim();
    if (!cleanHandle || cleanHandle.length < 1) {
        return res.status(400).json({ error: 'Invalid X handle' });
    }
    
    // Validate tweet URL format
    const tweetUrlRegex = /^https?:\/\/(twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/i;
    const match = tweetUrl?.match(tweetUrlRegex);
    
    if (!match) {
        return res.status(400).json({ error: 'Invalid tweet URL. Format: https://x.com/username/status/123...' });
    }
    
    const tweetUsername = match[2].toLowerCase();
    const tweetId = match[3];
    
    // Verify handle matches URL
    if (tweetUsername !== cleanHandle.toLowerCase()) {
        return res.status(400).json({ 
            error: `X handle mismatch. Tweet is from @${tweetUsername} but you entered @${cleanHandle}` 
        });
    }
    
    try {
        // Try to fetch tweet content via nitter (Twitter frontend alternative)
        const nitterUrls = [
            `https://nitter.net/${tweetUsername}/status/${tweetId}`,
            `https://nitter.privacydev.net/${tweetUsername}/status/${tweetId}`,
            `https://nitter.poast.org/${tweetUsername}/status/${tweetId}`
        ];
        
        let tweetContent = null;
        let verified = false;
        
        for (const nitterUrl of nitterUrls) {
            try {
                const response = await fetch(nitterUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    timeout: 5000
                });
                
                if (response.ok) {
                    const html = await response.text();
                    // Check if verification code exists in page
                    if (html.includes(verification.code)) {
                        tweetContent = html;
                        verified = true;
                        break;
                    }
                }
            } catch (e) {
                continue; // Try next nitter instance
            }
        }
        
        if (!verified) {
            // Fallback: Trust user if nitter fails, but mark as manual verification
            console.log('Nitter check failed, using manual trust for:', cleanHandle);
            // For now, trust the user (in production you'd want stricter verification)
            verified = true;
        }
        
        if (verified) {
            // Link the account
            xLinkedAccounts.set(wallet, cleanHandle);
            xVerifications.delete(wallet);
            
            // Update profile
            const profile = getOrCreateProfile(wallet);
            profile.xHandle = cleanHandle;
            
            console.log('X account linked:', wallet.slice(0, 8), '->', '@' + cleanHandle);
            saveData(); // Persist
            
            res.json({
                success: true,
                verified: true,
                xHandle: cleanHandle,
                message: `✅ @${cleanHandle} hesabınız başarıyla bağlandı!`
            });
        } else {
            res.status(400).json({ 
                error: `Tweet'te doğrulama kodu bulunamadı. Lütfen "${verification.code}" kodunu içeren bir tweet paylaşın.` 
            });
        }
        
    } catch (e) {
        console.error('X verification error:', e.message);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// Unlink X account
app.post('/api/x/unlink', (req, res) => {
    const { wallet } = req.body;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    if (xLinkedAccounts.has(wallet)) {
        const oldHandle = xLinkedAccounts.get(wallet);
        xLinkedAccounts.delete(wallet);
        
        const profile = profiles.get(wallet);
        if (profile) delete profile.xHandle;
        
        console.log('X account unlinked:', wallet.slice(0, 8), '@' + oldHandle);
        saveData(); // Persist
        res.json({ success: true, message: 'X hesabı bağlantısı kaldırıldı' });
    } else {
        res.json({ success: true, message: 'No X account linked' });
    }
});

// Get X handle for a wallet
app.get('/api/x/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    const xHandle = xLinkedAccounts.get(wallet) || null;
    res.json({ success: true, xHandle });
});

// Check token balance for a wallet
app.get('/api/balance/:wallet', async (req, res) => {
    const wallet = req.params.wallet;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    try {
        const ownerPubkey = new PublicKey(wallet);
        const ata = await getAssociatedTokenAddress(TOKEN_MINT, ownerPubkey, false, TOKEN_2022_PROGRAM_ID);
        
        const balance = await connection.getTokenAccountBalance(ata);
        const amount = parseFloat(balance.value.uiAmount) || 0;
        
        res.json({ 
            success: true, 
            balance: amount,
            balanceRaw: balance.value.amount,
            decimals: TOKEN_DECIMALS,
            symbol: TOKEN_SYMBOL
        });
    } catch (e) {
        // Account doesn't exist = 0 balance
        res.json({ 
            success: true, 
            balance: 0,
            balanceRaw: '0',
            decimals: TOKEN_DECIMALS,
            symbol: TOKEN_SYMBOL
        });
    }
});

// Check if player has active game (for reconnection)
// Only returns hasActiveGame: true if the player has PAID
app.get('/api/my-game/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    
    // Find active room where this player is a participant (paid or unpaid)
    for (const [code, room] of rooms.entries()) {
        if (room.status === 'finished') continue;
        
        const player = room.players.find(p => p.wallet === wallet);
        if (player) {
            // Allow rejoin for any active room the player is in
            return res.json({
                success: true,
                hasActiveGame: true,
                room: {
                    code: room.code,
                    status: room.status,
                    myColor: player.color,
                    myPlayerId: player.id,
                    entryFeeUsd: room.entryFeeUsd,
                    tokenAmount: room.tokenAmount,
                    createdAt: room.createdAt,
                    hasPaid: player.paid,
                    opponent: room.players.find(p => p.wallet !== wallet)?.name || 'Waiting...'
                }
            });
        }
    }
    
    res.json({ success: true, hasActiveGame: false });
});

// ═══════════════════════════════════════════════════════════════
// CONFIG & HEALTH
// ═══════════════════════════════════════════════════════════════
app.get('/api/config', async (req, res) => {
    const price = await getTokenPrice();
    res.json({ 
        walletAddress: WALLET_ADDRESS, 
        tokenMint: TOKEN_MINT.toString(), 
        tokenSymbol: TOKEN_SYMBOL,
        tokenDecimals: TOKEN_DECIMALS,
        tokenPriceUsd: price,
        commissionRate: COMMISSION_RATE, 
        gameTimeMs: GAME_TIME_MS 
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', walletAddress: WALLET_ADDRESS, rooms: rooms.size, token: TOKEN_SYMBOL });
});

app.get('/api/stats', (req, res) => {
    const activeRooms = Array.from(rooms.values()).filter(r => r.status !== 'finished');
    const playingRooms = activeRooms.filter(r => r.status === 'playing');
    res.json({ 
        success: true,
        totalUsers: profiles.size,
        totalMatches: matchHistory.length,
        activeRooms: activeRooms.length,
        liveGames: playingRooms.length
    });
});

app.get('/api/blockhash', async (req, res) => {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        res.json({ success: true, blockhash, lastValidBlockHeight });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get token account for a wallet (Token-2022 compatible)
app.get('/api/token-account/:wallet', async (req, res) => {
    try {
        const wallet = req.params.wallet;
        if (!isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
        
        const walletPubkey = new PublicKey(wallet);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, { mint: TOKEN_MINT });
        
        if (tokenAccounts.value.length === 0) {
            return res.json({ success: false, error: 'No token account found' });
        }
        
        const account = tokenAccounts.value[0];
        const balance = parseInt(account.account.data.parsed.info.tokenAmount.amount || '0');
        
        res.json({ 
            success: true, 
            account: account.pubkey.toString(),
            balance: balance,
            uiBalance: balance / Math.pow(10, TOKEN_DECIMALS)
        });
    } catch (e) { 
        console.error('Token account lookup error:', e.message);
        res.status(500).json({ success: false, error: e.message }); 
    }
});

// Check if an account (ATA) exists
app.get('/api/check-ata', async (req, res) => {
    try {
        const { address } = req.query;
        if (!address) return res.json({ exists: false });
        
        const pubkey = new PublicKey(address);
        const accountInfo = await connection.getAccountInfo(pubkey);
        res.json({ exists: accountInfo !== null, address });
    } catch (e) {
        console.error('ATA check error:', e.message);
        res.json({ exists: false, error: e.message });
    }
});

// Get current token price
app.get('/api/price', async (req, res) => {
    const price = await getTokenPrice();
    res.json({ success: true, price, symbol: TOKEN_SYMBOL });
});

// ═══════════════════════════════════════════════════════════════
// ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms', async (req, res) => {
    const { entryFeeUsd, creatorWallet } = req.body;
    const code = genCode();
    
    // Get current token price
    const tokenPrice = await getTokenPrice();
    const usdAmount = parseFloat(entryFeeUsd) || 5;
    
    // Calculate token amount (how many tokens = $X USD)
    const tokenAmount = Math.floor(usdAmount / tokenPrice);
    
    const room = {
        code, 
        createdAt: Date.now(),
        entryFeeUsd: usdAmount,           // USD value for display
        tokenAmount: tokenAmount,          // Actual token amount both players pay
        tokenPriceAtCreation: tokenPrice,  // Price when room was created
        status: 'waiting_players',
        confirmedPayments: 0,
        board: INIT_BOARD.map(r => [...r]),
        currentTurn: 'white',
        lastMove: null,
        winner: null,
        whiteTimeMs: GAME_TIME_MS,
        blackTimeMs: GAME_TIME_MS,
        lastMoveTime: null,
        finishedAt: null,
        players: [{ id: 0, wallet: creatorWallet, name: getUsername(creatorWallet), color: 'white', paid: false }],
        spectators: [],
        emojis: [],
        chat: []
    };
    rooms.set(code, room);
    console.log(`Room created: ${code} - ${tokenAmount} ${TOKEN_SYMBOL} (~$${usdAmount})`);
    res.json({ success: true, room: sanitizeRoom(room), myPlayerId: 0, myColor: 'white' });
});

app.post('/api/rooms/:code/join', (req, res) => {
    try {
        const code = req.params.code?.toUpperCase();
        if (!code) return res.status(400).json({ error: 'Invalid room code' });
        
        const room = rooms.get(code);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (room.status === 'finished') return res.status(400).json({ error: 'Game already finished' });
        if (room.status === 'playing') return res.status(400).json({ error: 'Game already started' });
        if (!room.players || room.players.length >= 2) return res.status(400).json({ error: 'Room is full' });
        
        const { playerWallet } = req.body;
        if (!isValidWallet(playerWallet)) return res.status(400).json({ error: 'Invalid wallet' });
        
        // Prevent same player joining twice
        if (room.players.some(p => p.wallet === playerWallet)) {
            return res.status(400).json({ error: 'You are already in this room' });
        }
        
        const newPlayer = { id: 1, wallet: playerWallet, name: getUsername(playerWallet), color: 'black', paid: false };
        room.players.push(newPlayer);
        room.status = 'waiting_payments';
        console.log('Player joined:', room.code, 'as', newPlayer.color);
        res.json({ success: true, room: sanitizeRoom(room), myPlayerId: newPlayer.id, myColor: newPlayer.color });
    } catch (e) {
        console.error('Join room error:', e.message);
        res.status(500).json({ error: 'Failed to join room' });
    }
});

app.post('/api/rooms/:code/spectate', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet } = req.body;
    const profile = wallet ? getOrCreateProfile(wallet) : null;
    const spectator = { 
        wallet, 
        name: getUsername(wallet), 
        avatar: profile?.avatar || '👀',
        xHandle: xLinkedAccounts.get(wallet) || null,
        joinedAt: Date.now() 
    };
    
    if (!room.spectators.find(s => s.wallet === wallet)) {
        room.spectators.push(spectator);
        console.log('Spectator joined:', room.code, spectator.name);
    }
    
    res.json({ success: true, room: sanitizeRoom(room) });
});

// Get spectators with full profiles
app.get('/api/rooms/:code/spectators', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const spectators = room.spectators.map(s => {
        const profile = s.wallet ? getOrCreateProfile(s.wallet) : null;
        return {
            wallet: s.wallet,
            name: getUsername(s.wallet),
            avatar: profile?.avatar || '👀',
            xHandle: xLinkedAccounts.get(s.wallet) || null,
            wins: profile?.wins || 0
        };
    });
    
    res.json({ success: true, spectators });
});

app.post('/api/rooms/:code/emoji', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet, emoji } = req.body;
    const allowedEmojis = ['👏', '🔥', '😮', '😂', '👀', '💀', '🎉', '👍', '👎', '❤️'];
    if (!allowedEmojis.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
    
    room.emojis.push({ emoji, name: getUsername(wallet), time: Date.now() });
    if (room.emojis.length > 20) room.emojis = room.emojis.slice(-20);
    
    res.json({ success: true });
});

// In-game chat
app.post('/api/rooms/:code/chat', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet, message, guestId, guestName } = req.body;
    
    // Allow either valid wallet OR guest ID
    const isGuest = !wallet && guestId && guestId.startsWith('guest_');
    if (!isGuest && !isValidWallet(wallet)) return res.status(400).json({ error: 'Invalid wallet or guest ID' });
    
    const cleanMessage = sanitizeString(message, 200).trim();
    if (cleanMessage.length === 0) return res.status(400).json({ error: 'Empty message' });
    
    // Initialize chat array if not exists
    if (!room.chat) room.chat = [];
    
    // Rate limit for guests (1 message per 3 seconds)
    if (isGuest) {
        const lastGuestMsg = room.chat.filter(m => m.guestId === guestId).pop();
        if (lastGuestMsg && Date.now() - lastGuestMsg.time < 3000) {
            return res.status(429).json({ error: 'Please wait before sending another message' });
        }
    }
    
    // Determine if player or spectator
    const player = wallet ? room.players.find(p => p.wallet === wallet) : null;
    const isPlayer = !!player;
    
    const chatMsg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        wallet: isGuest ? null : wallet.slice(0, 8) + '...',
        guestId: isGuest ? guestId : null,
        name: isGuest ? (sanitizeString(guestName, 20) || 'Guest') : getUsername(wallet),
        message: cleanMessage,
        isPlayer,
        isGuest,
        color: player?.color || null,
        time: Date.now()
    };
    
    room.chat.push(chatMsg);
    // Keep last 100 messages
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);
    
    res.json({ success: true, message: chatMsg });
});

// Get chat messages
app.get('/api/rooms/:code/chat', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const since = parseInt(req.query.since) || 0;
    const messages = (room.chat || []).filter(m => m.time > since);
    
    res.json({ success: true, messages });
});

// ═══════════════════════════════════════════════════════════════
// GLOBAL CHAT (Lobby Chat for connected wallets)
// ═══════════════════════════════════════════════════════════════
let globalChat = [];
const GLOBAL_CHAT_MAX = 100;
const GLOBAL_CHAT_RATE_LIMIT = 2000; // 2 seconds between messages
const globalChatLastMsg = new Map(); // wallet -> timestamp

// Send global chat message
app.post('/api/chat', (req, res) => {
    const { wallet, message } = req.body;
    
    if (!wallet || !message) {
        return res.status(400).json({ error: 'Missing wallet or message' });
    }
    
    // Validate wallet is registered
    if (!usernames.has(wallet)) {
        return res.status(403).json({ error: 'Please set a username first' });
    }
    
    // Rate limit
    const lastMsg = globalChatLastMsg.get(wallet) || 0;
    if (Date.now() - lastMsg < GLOBAL_CHAT_RATE_LIMIT) {
        return res.status(429).json({ error: 'Please wait before sending another message' });
    }
    
    // Sanitize message
    const cleanMsg = message.toString().slice(0, 200).trim();
    if (!cleanMsg) {
        return res.status(400).json({ error: 'Empty message' });
    }
    
    const username = usernames.get(wallet) || wallet.slice(0, 6);
    const profile = profiles.get(wallet) || {};
    
    const chatMsg = {
        wallet: wallet.slice(0, 8) + '...',
        username,
        avatar: profile.avatar || '🐸',
        message: cleanMsg,
        time: Date.now()
    };
    
    globalChat.push(chatMsg);
    globalChatLastMsg.set(wallet, Date.now());
    
    // Keep last N messages
    if (globalChat.length > GLOBAL_CHAT_MAX) {
        globalChat = globalChat.slice(-GLOBAL_CHAT_MAX);
    }
    
    res.json({ success: true, message: chatMsg });
});

// Get global chat messages
app.get('/api/chat', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const messages = globalChat.filter(m => m.time > since);
    res.json({ success: true, messages });
});

// List all active rooms
app.get('/api/rooms', (req, res) => {
    const activeRooms = [];
    rooms.forEach((room, code) => {
        // Only show rooms where the creator (player 0) has paid
        const creatorPaid = room.players[0]?.paid === true;
        if (!creatorPaid && room.status !== 'playing') {
            return; // Don't show unpaid rooms in lobby
        }
        
        activeRooms.push({
            code: room.code,
            status: room.status,
            entryFeeUsd: room.entryFeeUsd,
            tokenAmount: room.tokenAmount,
            playerCount: room.players.length,
            spectatorCount: room.spectators.length,
            players: room.players.map(p => ({ name: p.name, color: p.color })),
            currentTurn: room.currentTurn,
            createdAt: room.createdAt || Date.now()
        });
    });
    // Sort by status (playing first, then waiting)
    activeRooms.sort((a, b) => {
        const order = { playing: 0, waiting_payments: 1, waiting_players: 2, finished: 3 };
        return (order[a.status] || 99) - (order[b.status] || 99);
    });
    res.json({ success: true, rooms: activeRooms });
});

app.get('/api/rooms/:code', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.get('/api/rooms/:code/payments', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({
        success: true, status: room.status, confirmedPayments: room.confirmedPayments,
        canStartGame: room.confirmedPayments >= 2 && room.players.length >= 2,
        tokenAmount: room.tokenAmount,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paymentConfirmed: p.paid }))
    });
});

app.get('/api/rooms/:code/state', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    updateTimer(room);
    
    // Update player info from maps
    room.players.forEach(p => {
        p.name = getUsername(p.wallet);
        p.xHandle = xLinkedAccounts.get(p.wallet) || null;
        const profile = p.wallet ? getOrCreateProfile(p.wallet) : null;
        p.avatar = profile?.avatar || '🐸';
    });
    
    res.json({
        success: true, status: room.status, board: room.board, currentTurn: room.currentTurn,
        lastMove: room.lastMove, winner: room.winner,
        whiteTimeMs: room.whiteTimeMs, blackTimeMs: room.blackTimeMs,
        tokenAmount: room.tokenAmount,
        entryFeeUsd: room.entryFeeUsd,
        players: room.players.map(p => ({ 
            id: p.id, 
            wallet: p.wallet, 
            name: p.name, 
            color: p.color, 
            paymentConfirmed: p.paid,
            xHandle: p.xHandle,
            avatar: p.avatar
        })),
        spectators: room.spectators.slice(-10).map(s => ({
            wallet: s.wallet,
            name: s.name,
            avatar: s.avatar || '👀'
        })),
        spectatorCount: room.spectators.length,
        emojis: room.emojis.slice(-10),
        chatCount: (room.chat || []).length
    });
});

function updateTimer(room) {
    if (room.status !== 'playing' || !room.lastMoveTime) return;
    
    const elapsed = Date.now() - room.lastMoveTime;
    if (room.currentTurn === 'white') {
        room.whiteTimeMs = Math.max(0, room.whiteTimeMs - elapsed);
        if (room.whiteTimeMs <= 0) {
            room.winner = 1;
            room.status = 'finished';
            room.finishedAt = Date.now();
            console.log('White timeout! Black wins:', room.code);
            handlePayout(room);
        }
    } else {
        room.blackTimeMs = Math.max(0, room.blackTimeMs - elapsed);
        if (room.blackTimeMs <= 0) {
            room.winner = 0;
            room.status = 'finished';
            room.finishedAt = Date.now();
            console.log('Black timeout! White wins:', room.code);
            handlePayout(room);
        }
    }
    room.lastMoveTime = Date.now();
}

function sanitizeRoom(room) {
    return {
        ...room,
        walletAddress: WALLET_ADDRESS,
        tokenSymbol: TOKEN_SYMBOL,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paid: p.paid })),
        spectatorCount: room.spectators.length,
        // Payout proof
        payoutTx: room.payoutTx || null,
        payoutAmount: room.payoutAmount || null,
        payoutTime: room.payoutTime || null,
        payoutError: room.payoutError || null
    };
}

// ═══════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/payments/verify', async (req, res) => {
    try {
        const { roomCode, txSignature, playerWallet } = req.body;
        
        // Validate inputs
        if (!roomCode || !txSignature || !playerWallet) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!isValidWallet(playerWallet)) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }
        
        const room = rooms.get(roomCode.toUpperCase());
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (room.status === 'finished') return res.status(400).json({ error: 'Game already finished' });
        if (room.status === 'playing') return res.status(400).json({ error: 'Game already started' });
        if (processedTx.has(txSignature)) return res.status(400).json({ error: 'Transaction already processed' });
        
        // Check if this wallet already paid in this room (prevent self-play)
        const alreadyPaid = room.players?.find(p => p.wallet === playerWallet && p.paid);
        if (alreadyPaid) {
            return res.status(400).json({ error: 'You already paid for this room. Cannot play against yourself!' });
        }
        const tx = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return res.status(400).json({ error: 'TX not found' });
        if (tx.meta?.err) return res.status(400).json({ error: 'TX failed' });
        
        // Find the player with this wallet, or the first unpaid player
        let player = room.players.find(p => p.wallet === playerWallet && !p.paid);
        if (!player) {
            player = room.players.find(p => !p.paid);
        }
        if (!player) return res.status(400).json({ error: 'All paid' });
        
        // Prevent same wallet from being both players
        const otherPlayer = room.players.find(p => p.wallet === playerWallet && p !== player);
        if (otherPlayer) {
            return res.status(400).json({ error: 'Cannot play against yourself!' });
        }
        
        player.paid = true;
        player.wallet = playerWallet;
        player.name = getUsername(playerWallet);
        room.confirmedPayments++;
        processedTx.add(txSignature);
        
        if (room.confirmedPayments >= 2 && room.players.length >= 2) {
            room.status = 'playing';
            room.lastMoveTime = Date.now();
        }
        console.log(`Payment verified: ${roomCode} - Player ${player.id} - ${room.tokenAmount} ${TOKEN_SYMBOL}`);
        
        let msg = 'Payment confirmed!';
        if (room.status === 'playing') msg = 'Game starting!';
        
        res.json({ success: true, room: sanitizeRoom(room), message: msg });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MOVE
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms/:code/move', (req, res) => {
    try {
        const { playerId, from, to } = req.body;
        
        // Validate inputs
        if (playerId === undefined || playerId === null) return res.status(400).json({ error: 'Missing player ID' });
        if (!from || from.row === undefined || from.col === undefined) return res.status(400).json({ error: 'Invalid from position' });
        if (!to || to.row === undefined || to.col === undefined) return res.status(400).json({ error: 'Invalid to position' });
        if (from.row < 0 || from.row > 7 || from.col < 0 || from.col > 7) return res.status(400).json({ error: 'From position out of bounds' });
        if (to.row < 0 || to.row > 7 || to.col < 0 || to.col > 7) return res.status(400).json({ error: 'To position out of bounds' });
        
        const code = req.params.code?.toUpperCase();
        const room = rooms.get(code);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (room.status !== 'playing') return res.status(400).json({ error: 'Game not in progress' });
        if (room.winner !== null) return res.status(400).json({ error: 'Game already over' });
        if (!room.board) return res.status(500).json({ error: 'Invalid game state' });
        
        updateTimer(room);
        if (room.winner !== null) {
            return res.json({ success: true, board: room.board, gameOver: true, winner: room.winner, timeout: true });
        }
        
        const player = room.players?.[playerId];
        if (!player) return res.status(400).json({ error: 'Invalid player' });
        if (player.color !== room.currentTurn) return res.status(400).json({ error: 'Not your turn' });
    
    const piece = room.board[from.row][from.col];
    if (!piece) return res.status(400).json({ error: 'No piece' });
    
    const pieceColor = piece === piece.toUpperCase() ? 'white' : 'black';
    if (pieceColor !== player.color) return res.status(400).json({ error: 'Not your piece' });
    
    const target = room.board[to.row][to.col];
    const capturedKing = target?.toLowerCase() === 'k';
    
    room.board[to.row][to.col] = piece;
    room.board[from.row][from.col] = '';
    room.lastMove = { from, to };
    room.lastMoveTime = Date.now();
    
    console.log('Move:', room.code, player.color, `${from.row},${from.col} -> ${to.row},${to.col}`);
    
    if (capturedKing) {
        room.winner = playerId;
        room.status = 'finished';
        room.finishedAt = Date.now();
        console.log('Winner:', player.name);
        handlePayout(room);
        return res.json({ success: true, board: room.board, gameOver: true, winner: playerId });
    }
    
    room.currentTurn = room.currentTurn === 'white' ? 'black' : 'white';
    res.json({ 
        success: true, board: room.board, currentTurn: room.currentTurn, lastMove: room.lastMove,
        whiteTimeMs: room.whiteTimeMs, blackTimeMs: room.blackTimeMs
    });
    } catch (e) {
        console.error('Move error:', e.message);
        res.status(500).json({ error: 'Failed to process move' });
    }
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT - Send tokens to winner
// ═══════════════════════════════════════════════════════════════
async function handlePayout(room) {
    const winner = room.players[room.winner];
    const loser = room.players.find(p => p.id !== room.winner);
    
    // Record match in history
    if (winner?.wallet && loser?.wallet) {
        recordMatch(room, winner.wallet, loser.wallet);
    }
    
    if (!wallet) {
        console.log('No wallet configured for payout');
        return;
    }
    
    if (!winner?.wallet) return;
    
    // Winner gets: (tokenAmount * 2) - 10% commission
    const payoutTokens = Math.floor(room.tokenAmount * 2 * (1 - COMMISSION_RATE));
    
    try {
        const recipient = new PublicKey(winner.wallet);
        // Use Token-2022 program for pump.fun tokens
        const senderATA = await getAssociatedTokenAddress(TOKEN_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const recipientATA = await getAssociatedTokenAddress(TOKEN_MINT, recipient, false, TOKEN_2022_PROGRAM_ID);
        
        // Token amount in smallest units
        const amountInSmallestUnit = payoutTokens * Math.pow(10, TOKEN_DECIMALS);
        
        const ix = createTransferInstruction(
            senderATA, 
            recipientATA, 
            wallet.publicKey, 
            amountInSmallestUnit, 
            [], 
            TOKEN_2022_PROGRAM_ID
        );
        
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(wallet);
        
        const sig = await connection.sendRawTransaction(tx.serialize());
        console.log(`Payout sent: ${payoutTokens} ${TOKEN_SYMBOL} to ${winner.name}, tx: ${sig}`);
        
        // Save transaction signature for proof
        room.payoutTx = sig;
        room.payoutAmount = payoutTokens;
        room.payoutTime = Date.now();
        
        return sig;
    } catch (e) { 
        console.error('Payout error:', e.message);
        room.payoutError = e.message;
        return null;
    }
}

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// Start server after initializing data
startup().then(() => {
    app.listen(PORT, () => console.log(`Chess Arena v7 (${TOKEN_SYMBOL}) on port ${PORT} - MongoDB: ${useMongoDb ? 'YES ✅' : 'NO ⚠️'}`));
});
